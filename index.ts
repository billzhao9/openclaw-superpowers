/**
 * OpenClaw Superpowers Plugin
 *
 * Brings structured brainstorming, planning, debugging, and config safety
 * to OpenClaw agents. Modeled after obra/superpowers, adapted for OpenClaw.
 *
 * Core flows:
 *   Task:  recall memories → brainstorm → design → spec → plan → execute → verify → capture
 *   Debug: recall memories → root cause → pattern → hypothesis → fix → verify → capture
 *   Config: detect → safety overlay on any modification flow
 *
 * Memory integration (inspired by claude-mem):
 *   - Before brainstorming: recall past decisions, user preferences, lessons learned
 *   - After key decisions: capture design choices, specs, learnings to OpenViking
 *   - Before debugging: recall past similar bugs and fixes
 *   - After fixes: capture root cause and solution
 *
 * Architecture follows the OpenViking plugin pattern:
 *   - Hooks: before_prompt_build, agent_end, before_reset
 *   - Tools: superpowers_status, superpowers_advance, superpowers_reset, superpowers_remember
 *   - State: per-session workflow phase tracking
 *   - Memory: OpenViking-backed recall and capture
 */

import { detectPrompt, type DetectionMode } from "./detector.js";
import {
  getSession,
  startSession,
  updateSession,
  advancePhase,
  incrementTurn,
  endSession,
  isActiveSession,
  detectPhaseTransition,
  type WorkflowPhase,
  type SessionState,
} from "./state.js";
import { BRAINSTORMING_PROMPT, BRAINSTORMING_CONTINUATION_PROMPT } from "./prompts/brainstorming.js";
import { WRITING_PLANS_PROMPT, WRITING_PLANS_CONTINUATION_PROMPT } from "./prompts/writing-plans.js";
import { VERIFICATION_PROMPT } from "./prompts/verification.js";
import { DEBUGGING_PROMPT } from "./prompts/debugging.js";
import { CONFIG_SAFETY_PROMPT } from "./prompts/config-safety.js";
import { SPEC_REVIEWER_PROMPT } from "./prompts/spec-reviewer.js";
import {
  buildBrainstormMemoryContext,
  buildDebugMemoryContext,
  captureMemory,
  buildDecisionSummary,
  buildDebugSummary,
  resolveMemoryConfig,
  isMemoryConfigured,
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
} from "./memory.js";
import {
  applyBudget,
  shouldRecallMemory,
  getCompactionSuggestion,
  getPhaseTransitionHint,
  type InjectionParts,
} from "./context-budget.js";

// --- Types ---

type PluginLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type HookAgentContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
};

type OpenClawPluginApi = {
  pluginConfig?: unknown;
  logger: PluginLogger;
  registerTool: (
    tool: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    },
    opts?: { name?: string; names?: string[] },
  ) => void;
  registerService: (service: {
    id: string;
    start: (ctx?: unknown) => void | Promise<void>;
    stop?: (ctx?: unknown) => void | Promise<void>;
  }) => void;
  on: (
    hookName: string,
    handler: (event: unknown, ctx?: HookAgentContext) => unknown,
    opts?: { priority?: number },
  ) => void;
};

// --- Config ---

type SuperpowersConfig = {
  enabled: boolean;
  autoDetect: boolean;
  memoryEnabled: boolean;
  language: string;
  specDir: string;
  planDir: string;
  skipPatterns: string[];
  memory: Partial<MemoryConfig>;
};

const DEFAULT_CONFIG: SuperpowersConfig = {
  enabled: true,
  autoDetect: true,
  memoryEnabled: true,
  language: "auto",
  specDir: "superpowers/specs",
  planDir: "superpowers/plans",
  skipPatterns: [],
  memory: {},
};

function parseConfig(raw: unknown): SuperpowersConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const obj = raw as Record<string, unknown>;
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled,
    autoDetect: typeof obj.autoDetect === "boolean" ? obj.autoDetect : DEFAULT_CONFIG.autoDetect,
    memoryEnabled: typeof obj.memoryEnabled === "boolean" ? obj.memoryEnabled : DEFAULT_CONFIG.memoryEnabled,
    language: typeof obj.language === "string" ? obj.language : DEFAULT_CONFIG.language,
    specDir: typeof obj.specDir === "string" ? obj.specDir : DEFAULT_CONFIG.specDir,
    planDir: typeof obj.planDir === "string" ? obj.planDir : DEFAULT_CONFIG.planDir,
    skipPatterns: Array.isArray(obj.skipPatterns) ? obj.skipPatterns.filter((s): s is string => typeof s === "string") : DEFAULT_CONFIG.skipPatterns,
    memory: (typeof obj.memory === "object" && obj.memory !== null ? obj.memory : {}) as Partial<MemoryConfig>,
  };
}

// --- Prompt selection ---

function getPromptForPhase(phase: WorkflowPhase, isNewSession: boolean): string | null {
  switch (phase) {
    case "brainstorming":
      return isNewSession ? BRAINSTORMING_PROMPT : BRAINSTORMING_CONTINUATION_PROMPT;
    case "design_review":
      return BRAINSTORMING_CONTINUATION_PROMPT;
    case "spec_writing":
      return BRAINSTORMING_CONTINUATION_PROMPT;
    case "spec_review":
      return SPEC_REVIEWER_PROMPT;
    case "planning":
      return isNewSession ? WRITING_PLANS_PROMPT : WRITING_PLANS_CONTINUATION_PROMPT;
    case "plan_review":
      return WRITING_PLANS_CONTINUATION_PROMPT;
    case "executing":
      return null; // Don't inject during execution
    case "verifying":
      return VERIFICATION_PROMPT;
    default:
      return null;
  }
}

function getPromptForMode(mode: DetectionMode): string | null {
  switch (mode) {
    case "brainstorm":
      return BRAINSTORMING_PROMPT;
    case "debug":
      return DEBUGGING_PROMPT;
    default:
      return null;
  }
}

// --- Text extraction ---

/**
 * Strip all XML-style tags injected by other plugins (openviking, smart-notes, etc.)
 * so the detector sees only the user's actual message.
 */
function stripInjectedContext(text: string): string {
  return text
    // Remove any <tag>...</tag> blocks (relevant-memories, smart-notes-result, superpowers-*, etc.)
    .replace(/<[a-z][\w-]*>[\s\S]*?<\/[a-z][\w-]*>/gi, "")
    // Remove OpenClaw sender metadata
    .replace(/Sender\s*\([^)]*\)\s*:\s*```[\s\S]*?```/gi, "")
    .replace(/(?:^|\n)\s*(?:Conversation info|Conversation metadata)\s*(?:\([^)]+\))?\s*:\s*```[\s\S]*?```/gi, "")
    // Remove leading timestamp
    .replace(/^\s*\[[^\]\n]{1,120}\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLatestUserText(messages: unknown[] | undefined): string {
  if (!messages || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return stripInjectedContext(content);
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b?.type === "text" && typeof b.text === "string") {
          return stripInjectedContext(b.text as string);
        }
      }
    }
  }
  return "";
}

function extractLatestAssistantText(messages: unknown[] | undefined): string {
  if (!messages || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b?.type === "text" && typeof b.text === "string") {
          parts.push((b.text as string).trim());
        }
      }
      return parts.join("\n");
    }
  }
  return "";
}

// --- Phase display ---

const PHASE_LABELS: Record<WorkflowPhase, string> = {
  idle: "空闲",
  brainstorming: "头脑风暴（收集需求）",
  design_review: "设计审核（等待批准）",
  spec_writing: "编写 Spec",
  spec_review: "Spec 审核（等待批准）",
  planning: "编写实施计划",
  plan_review: "计划审核（等待批准）",
  executing: "执行计划",
  verifying: "验证完成",
  debugging: "系统化调试",
};

// --- Plugin ---

const superpowersPlugin = {
  id: "openclaw-superpowers",
  name: "Superpowers (Brainstorming & Planning)",
  description: "Smart brainstorming, planning, debugging, and config safety for OpenClaw agents",
  kind: "lifecycle" as const,

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);

    if (!cfg.enabled) {
      api.logger.info("superpowers: disabled by config");
      return;
    }

    const customSkipPatterns: RegExp[] = [];
    for (const pattern of cfg.skipPatterns) {
      try {
        customSkipPatterns.push(new RegExp(pattern, "i"));
      } catch {
        api.logger.warn(`superpowers: invalid skip pattern: ${pattern}`);
      }
    }

    // Resolve memory config: auto-detect from openviking plugin, or use explicit config
    const memoryResolved = resolveMemoryConfig(cfg.memory, api.logger);
    const memoryCfg = memoryResolved.config;
    const memoryAvailable = cfg.memoryEnabled && isMemoryConfigured(memoryCfg);
    // If openviking plugin is installed, it already handles auto-recall — we only capture.
    // If user set explicit baseUrl (no openviking plugin), we do both recall AND capture.
    const shouldDoRecall = memoryAvailable && !memoryResolved.pluginHandlesRecall;
    if (cfg.memoryEnabled && !memoryAvailable) {
      api.logger.info(
        "superpowers: memory requested but no OpenViking config available. " +
        "Install the openviking plugin, or set memory.baseUrl in superpowers config.",
      );
    }

    // --- Tool: superpowers_status ---
    api.registerTool(
      {
        name: "superpowers_status",
        label: "Superpowers 状态",
        description: "查看当前头脑风暴/计划工作流的状态。Check current brainstorming/planning workflow status.",
        parameters: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Session key (optional)" },
          },
          additionalProperties: false,
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const sessionKey = params.sessionKey as string | undefined;
          if (sessionKey) {
            const session = getSession(sessionKey);
            if (session) {
              return {
                content: [{
                  type: "text",
                  text: `Superpowers 状态:\n- 阶段: ${PHASE_LABELS[session.phase]}\n- 任务: ${session.taskSummary}\n- 轮次: ${session.turnCount}\n- 开始于: ${new Date(session.startedAt).toISOString()}`,
                }],
                details: session,
              };
            }
          }
          return {
            content: [{
              type: "text",
              text: "没有活跃的 Superpowers 会话。\n\n工作流: brainstorming → design review → spec → planning → execution → verification\n调试流: root cause → pattern → hypothesis → fix → verify\n\n当检测到任务或错误时会自动激活。",
            }],
          };
        },
      },
      { name: "superpowers_status" },
    );

    // --- Tool: superpowers_advance ---
    api.registerTool(
      {
        name: "superpowers_advance",
        label: "Superpowers 推进阶段",
        description: "手动推进到下一个工作流阶段。Manually advance workflow phase.",
        parameters: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Session key" },
            targetPhase: {
              type: "string",
              description: "Target phase (optional, defaults to next)",
              enum: ["brainstorming", "design_review", "spec_writing", "spec_review", "planning", "plan_review", "executing", "verifying", "debugging"],
            },
          },
          additionalProperties: false,
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const sessionKey = params.sessionKey as string;
          const targetPhase = params.targetPhase as WorkflowPhase | undefined;
          if (!sessionKey) {
            return { content: [{ type: "text", text: "需要 sessionKey。" }] };
          }
          const session = getSession(sessionKey);
          if (!session) {
            return { content: [{ type: "text", text: "没有活跃的会话。" }] };
          }
          let updated: SessionState | undefined;
          if (targetPhase) {
            updated = updateSession(sessionKey, { phase: targetPhase, turnCount: 0 });
          } else {
            updated = advancePhase(sessionKey);
          }
          if (!updated) {
            return { content: [{ type: "text", text: "推进失败。" }] };
          }
          return {
            content: [{ type: "text", text: `阶段已推进到: ${PHASE_LABELS[updated.phase]}` }],
            details: { phase: updated.phase },
          };
        },
      },
      { name: "superpowers_advance" },
    );

    // --- Tool: superpowers_reset ---
    api.registerTool(
      {
        name: "superpowers_reset",
        label: "Superpowers 重置",
        description: "重置当前会话，返回空闲状态。Reset brainstorming session.",
        parameters: {
          type: "object",
          properties: {
            sessionKey: { type: "string", description: "Session key" },
          },
          additionalProperties: false,
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const sessionKey = params.sessionKey as string;
          if (sessionKey) endSession(sessionKey);
          return { content: [{ type: "text", text: "Superpowers 会话已重置。" }] };
        },
      },
      { name: "superpowers_reset" },
    );

    // --- Tool: superpowers_spec_review ---
    api.registerTool(
      {
        name: "superpowers_spec_review",
        label: "Superpowers Spec 自检",
        description: "对当前 spec 文档进行自检。Run self-review on the current spec document.",
        parameters: {
          type: "object",
          properties: {
            specContent: { type: "string", description: "Spec document content to review" },
          },
          required: ["specContent"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, _params: Record<string, unknown>) {
          return {
            content: [{ type: "text", text: SPEC_REVIEWER_PROMPT }],
          };
        },
      },
      { name: "superpowers_spec_review" },
    );

    // --- Tool: superpowers_remember ---
    api.registerTool(
      {
        name: "superpowers_remember",
        label: "Superpowers 记忆存储",
        description: "将设计决策、调试教训、或重要发现存入 OpenViking 长期记忆。Store decisions, lessons, or findings to long-term memory.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "要记忆的内容（结构化文本）" },
            sessionKey: { type: "string", description: "Session key for grouping" },
            type: {
              type: "string",
              description: "Memory type: decision, lesson, preference, debug_fix",
              enum: ["decision", "lesson", "preference", "debug_fix"],
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          if (!memoryAvailable) {
            return { content: [{ type: "text", text: "记忆功能不可用。请安装 openviking 插件，或在 superpowers 配置中设置 memory.baseUrl。" }] };
          }
          const text = params.text as string;
          const sessionKey = (params.sessionKey as string) || `manual-${Date.now()}`;
          const memType = (params.type as string) || "decision";

          const taggedText = `[${memType}] ${text}`;
          const result = await captureMemory(
            { text: taggedText, sessionId: sessionKey },
            memoryCfg,
            api.logger,
          );

          return {
            content: [{
              type: "text",
              text: result.success
                ? `已存入记忆（提取了 ${result.memoriesExtracted} 条记忆）。`
                : "记忆存储失败，请检查 OpenViking 连接。",
            }],
            details: result,
          };
        },
      },
      { name: "superpowers_remember" },
    );

    // --- Hook: before_prompt_build (with memory recall + budget control) ---
    api.on("before_prompt_build", async (event: unknown, ctx?: HookAgentContext) => {
      if (!cfg.autoDetect) return;

      const sessionKey = ctx?.sessionKey ?? ctx?.sessionId ?? "";
      if (!sessionKey) return;

      const eventObj = (event ?? {}) as { messages?: unknown[]; prompt?: string };
      const userText =
        extractLatestUserText(eventObj.messages) ||
        (typeof eventObj.prompt === "string" ? eventObj.prompt.trim() : "");

      if (!userText) return;

      const existingSession = getSession(sessionKey);
      let injection: InjectionParts = { prompt: null, memory: null, safety: null };
      let phase: WorkflowPhase = "idle";
      let isFirstTurn = false;

      if (existingSession && existingSession.phase !== "idle") {
        // Active session: continuation
        phase = existingSession.phase;
        incrementTurn(sessionKey);

        injection.prompt = getPromptForPhase(phase, false);

        // Config safety only when message mentions config files
        const freshDetection = detectPrompt(userText, customSkipPatterns);
        if (freshDetection.needsConfigSafety) {
          injection.safety = CONFIG_SAFETY_PROMPT;
        }

        // Memory is NOT re-recalled on continuation turns (biggest token saver)

        // Append compaction suggestion if conversation is getting long
        const compactHint = getCompactionSuggestion(phase, existingSession.turnCount + 1);
        if (compactHint && injection.prompt) {
          injection.prompt += compactHint;
        }

        api.logger.info(
          `superpowers: ${phase} continuation (turn=${existingSession.turnCount + 1}, task="${existingSession.taskSummary.slice(0, 60)}")`,
        );
      } else {
        // No active session: detect prompt type
        const detection = detectPrompt(userText, customSkipPatterns);

        if (detection.mode === "skip") return;
        if (detection.mode === "continuation") return;

        // Start new session
        const summary = userText.length > 120 ? userText.slice(0, 120) + "..." : userText;
        phase = detection.mode === "debug" ? "debugging" : "brainstorming";
        isFirstTurn = true;
        startSession(sessionKey, summary);
        updateSession(sessionKey, { phase });

        // Mode-specific prompt (full version for first turn)
        injection.prompt = getPromptForMode(detection.mode);

        // Config safety overlay
        if (detection.needsConfigSafety) {
          injection.safety = CONFIG_SAFETY_PROMPT;
        }

        // Memory recall: only if openviking plugin is NOT installed (otherwise it duplicates)
        if (shouldDoRecall && shouldRecallMemory(phase, 0)) {
          try {
            if (detection.mode === "debug") {
              injection.memory = await buildDebugMemoryContext(userText, memoryCfg, api.logger);
            } else {
              injection.memory = await buildBrainstormMemoryContext(userText, memoryCfg, api.logger);
            }
          } catch (err) {
            api.logger.warn(`superpowers: memory recall failed: ${String(err)}`);
          }
        }

        api.logger.info(
          `superpowers: new session (mode=${detection.mode}, confidence=${detection.confidence}, configSafety=${detection.needsConfigSafety}, task="${summary}")`,
        );
      }

      // Apply budget constraints
      const budget = applyBudget(injection, phase, isFirstTurn);

      if (budget.parts.length > 0) {
        if (budget.trimmed) {
          api.logger.info(
            `superpowers: context trimmed to fit budget (~${budget.totalTokens} tokens)`,
          );
        }
        return { prependContext: budget.parts.join("\n\n") };
      }
    }, { priority: 50 });

    // --- Hook: agent_end (phase transition + memory capture) ---
    api.on("agent_end", async (event: unknown, ctx?: HookAgentContext) => {
      const sessionKey = ctx?.sessionKey ?? ctx?.sessionId ?? "";
      if (!sessionKey) return;

      const session = getSession(sessionKey);
      if (!session || session.phase === "idle") return;

      const eventObj = (event ?? {}) as { messages?: unknown[]; success?: boolean };
      const assistantText = extractLatestAssistantText(eventObj.messages);

      if (!assistantText) return;

      const oldPhase = session.phase;
      const newPhase = detectPhaseTransition(assistantText, session.phase);
      if (newPhase) {
        updateSession(sessionKey, { phase: newPhase, turnCount: 0 });

        // Log phase transition with compaction hint
        const transitionHint = getPhaseTransitionHint(oldPhase, newPhase);
        api.logger.info(
          `superpowers: phase ${oldPhase} → ${newPhase} (task="${session.taskSummary.slice(0, 60)}")` +
          (transitionHint ? ` — ${transitionHint}` : ""),
        );

        // Auto-capture memories on key phase transitions
        if (memoryAvailable) {
          // Capture when design is finalized (design_review → spec)
          if (oldPhase === "design_review" && (newPhase === "spec_writing" || newPhase === "spec_review")) {
            const summary = buildDecisionSummary({
              task: session.taskSummary,
              decision: "设计方案已批准",
              approach: assistantText.length > 500 ? assistantText.slice(0, 500) + "..." : assistantText,
            });
            captureMemory({ text: `[design_decision] ${summary}`, sessionId: sessionKey }, memoryCfg, api.logger)
              .catch(() => {});
          }

          // Capture when plan is finalized
          if (oldPhase === "planning" && newPhase === "plan_review") {
            const summary = `[plan_completed] 任务: ${session.taskSummary}\n计划已完成，进入审核阶段。`;
            captureMemory({ text: summary, sessionId: sessionKey }, memoryCfg, api.logger)
              .catch(() => {});
          }

          // Capture when debugging finds root cause and fix
          if (oldPhase === "debugging" && newPhase === "verifying") {
            const summary = buildDebugSummary({
              symptom: session.taskSummary,
              rootCause: "见 agent 回复",
              fix: assistantText.length > 500 ? assistantText.slice(0, 500) + "..." : assistantText,
            });
            captureMemory({ text: `[debug_fix] ${summary}`, sessionId: sessionKey }, memoryCfg, api.logger)
              .catch(() => {});
          }

          // Capture when work is verified complete
          if (newPhase === "verifying" && oldPhase === "executing") {
            const summary = `[task_completed] 任务: ${session.taskSummary}\n执行完成，进入验证阶段。`;
            captureMemory({ text: summary, sessionId: sessionKey }, memoryCfg, api.logger)
              .catch(() => {});
          }
        }
      }
    });

    // --- Hook: before_reset ---
    api.on("before_reset", (_event: unknown, ctx?: HookAgentContext) => {
      const sessionKey = ctx?.sessionKey ?? ctx?.sessionId ?? "";
      if (sessionKey) {
        const session = getSession(sessionKey);
        if (session) {
          api.logger.info(`superpowers: ending session on reset (phase=${session.phase})`);
          endSession(sessionKey);
        }
      }
    });

    // --- Service ---
    api.registerService({
      id: "openclaw-superpowers",
      start: () => {
        api.logger.info(
          `superpowers: initialized (autoDetect=${cfg.autoDetect}, specDir=${cfg.specDir}, planDir=${cfg.planDir})`,
        );
      },
      stop: () => {
        api.logger.info("superpowers: stopped");
      },
    });
  },
};

export default superpowersPlugin;
