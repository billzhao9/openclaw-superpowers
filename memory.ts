/**
 * Memory integration for superpowers.
 *
 * Connects to OpenViking (same backend as the openviking plugin) to:
 *  - Recall past decisions, preferences, and lessons before brainstorming
 *  - Store new decisions, specs, and learnings after brainstorming
 *  - Recall past bug fixes during debugging
 *
 * Config resolution priority:
 *  1. Explicit superpowers plugin config (`plugins.entries.openclaw-superpowers.config.memory`)
 *  2. Auto-detected from openviking plugin config (`plugins.entries.openviking.config`)
 *  3. Disabled (no hardcoded defaults for URL/key — each install is different)
 *
 * Inspired by claude-mem's lifecycle approach:
 *  - SessionStart → inject relevant memories
 *  - After key decisions → capture as memories
 *  - Progressive disclosure → search first, detail on demand
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type MemoryConfig = {
  baseUrl: string;
  apiKey: string;
  agentId: string;
  timeoutMs: number;
  recallLimit: number;
  recallScoreThreshold: number;
  recallMaxChars: number;
  recallTokenBudget: number;
};

/**
 * Sensible defaults for recall behavior — but NO hardcoded URL/key.
 * baseUrl and apiKey must come from openviking plugin or explicit config.
 */
const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  baseUrl: "",
  apiKey: "",
  agentId: "main",
  timeoutMs: 8000,
  recallLimit: 5,
  recallScoreThreshold: 0.12,
  recallMaxChars: 400,
  recallTokenBudget: 1500,
};

/**
 * Try to read OpenViking plugin config from openclaw.json.
 * Returns partial MemoryConfig with baseUrl/apiKey/agentId if found.
 */
export function detectOpenVikingConfig(): Partial<MemoryConfig> | null {
  try {
    const configPath = join(
      process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw"),
      "openclaw.json",
    );
    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw) as {
      plugins?: {
        entries?: {
          openviking?: {
            enabled?: boolean;
            config?: {
              baseUrl?: string;
              apiKey?: string;
              agentId?: string;
              mode?: string;
            };
          };
        };
      };
    };

    const ovEntry = config?.plugins?.entries?.openviking;
    if (!ovEntry || ovEntry.enabled === false) return null;

    const ovConfig = ovEntry.config;
    if (!ovConfig?.baseUrl) return null;

    return {
      baseUrl: ovConfig.baseUrl,
      apiKey: ovConfig.apiKey || "",
      agentId: ovConfig.agentId || "main",
    };
  } catch {
    return null;
  }
}

export type MemoryConfigSource = "explicit" | "openviking_plugin" | "none";

export type ResolvedMemoryConfig = {
  config: MemoryConfig;
  source: MemoryConfigSource;
  /** If source is openviking_plugin, the plugin already does auto-recall — we should NOT duplicate */
  pluginHandlesRecall: boolean;
};

/**
 * Resolve the final memory config.
 *
 * Priority:
 *  1. Explicit superpowers config (user set memory.baseUrl) → superpowers does its own recall
 *  2. Auto-detected from openviking plugin → openviking already does recall, we only capture
 *  3. Empty → memory disabled
 */
export function resolveMemoryConfig(
  explicitConfig: Partial<MemoryConfig>,
  logger?: { info: (msg: string) => void; warn: (msg: string) => void },
): ResolvedMemoryConfig {
  // If explicit config has a baseUrl, user wants superpowers to handle memory directly
  if (explicitConfig.baseUrl) {
    const config = { ...DEFAULT_MEMORY_CONFIG, ...explicitConfig };
    logger?.info(
      `superpowers-memory: using explicit config (baseUrl=${config.baseUrl}) — superpowers will handle recall`,
    );
    return { config, source: "explicit", pluginHandlesRecall: false };
  }

  // Try auto-detect from openviking plugin
  const detected = detectOpenVikingConfig();
  if (detected?.baseUrl) {
    const config = { ...DEFAULT_MEMORY_CONFIG, ...detected, ...explicitConfig };
    logger?.info(
      `superpowers-memory: auto-detected openviking plugin (baseUrl=${config.baseUrl}) — openviking handles recall, superpowers only captures`,
    );
    return { config, source: "openviking_plugin", pluginHandlesRecall: true };
  }

  // No config available
  logger?.info(
    "superpowers-memory: no OpenViking config found. Memory disabled. " +
    "To enable: install openviking plugin, or set memory.baseUrl in superpowers config.",
  );
  return { config: { ...DEFAULT_MEMORY_CONFIG, ...explicitConfig }, source: "none", pluginHandlesRecall: false };
}

/**
 * Check if memory is usable (has a valid baseUrl).
 */
export function isMemoryConfigured(cfg: MemoryConfig): boolean {
  return !!cfg.baseUrl;
}

type FindResultItem = {
  uri: string;
  level?: number;
  abstract?: string;
  overview?: string;
  category?: string;
  score?: number;
};

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

function clamp01(v: number | undefined): number {
  if (typeof v !== "number" || Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

// --- HTTP client ---

async function ovRequest<T>(
  cfg: MemoryConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": cfg.apiKey,
      "X-OpenViking-Agent": cfg.agentId,
    };
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> || {}) },
      signal: controller.signal,
    });
    const payload = (await res.json().catch(() => ({}))) as {
      status?: string;
      result?: T;
      error?: { message?: string };
    };
    if (!res.ok || payload.status === "error") {
      throw new Error(payload.error?.message || `HTTP ${res.status}`);
    }
    return (payload.result ?? payload) as T;
  } finally {
    clearTimeout(timer);
  }
}

// --- Recall ---

export type RecallResult = {
  memories: Array<{ category: string; content: string; score: number; uri: string }>;
  injectionText: string;
  estimatedTokens: number;
};

/**
 * Recall memories relevant to a query.
 * Searches both user and agent memory spaces, deduplicates, and builds
 * injection text within token budget.
 */
export async function recallMemories(
  query: string,
  cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG,
  logger?: Logger,
): Promise<RecallResult> {
  const empty: RecallResult = { memories: [], injectionText: "", estimatedTokens: 0 };

  if (!query || query.length < 5) return empty;
  if (!isMemoryConfigured(cfg)) return empty;

  try {
    const requestLimit = Math.max(cfg.recallLimit * 4, 20);

    // Search ALL memory spaces (no target_uri — avoids space-resolution mismatch)
    const searchResult = await ovRequest<{ memories?: FindResultItem[] }>(cfg, "/api/v1/search/find", {
      method: "POST",
      body: JSON.stringify({
        query,
        limit: requestLimit,
        score_threshold: 0,
      }),
    });

    const allMems = searchResult.memories || [];

    // Dedupe by URI
    const uriSet = new Set<string>();
    const all = allMems.filter((m) => {
      if (uriSet.has(m.uri)) return false;
      uriSet.add(m.uri);
      return true;
    });

    const sorted = all
      .filter((m) => m.level === 2 && clamp01(m.score) >= cfg.recallScoreThreshold)
      .sort((a, b) => clamp01(b.score) - clamp01(a.score));

    // Dedupe by abstract
    const seen = new Set<string>();
    const filtered: FindResultItem[] = [];
    for (const item of sorted) {
      const key = (item.abstract || item.overview || "").trim().toLowerCase() || item.uri;
      if (seen.has(key)) continue;
      seen.add(key);
      filtered.push(item);
      if (filtered.length >= cfg.recallLimit) break;
    }

    if (filtered.length === 0) return empty;

    // Build injection text with token budget
    let budgetRemaining = cfg.recallTokenBudget;
    const memories: RecallResult["memories"] = [];
    const lines: string[] = [];

    for (const item of filtered) {
      if (budgetRemaining <= 0) break;

      let content = (item.abstract || item.overview || item.uri).trim();

      // Try to read full content for leaf memories
      if (item.level === 2) {
        try {
          const full = await ovRequest<string>(cfg, `/api/v1/content/read?uri=${encodeURIComponent(item.uri)}`);
          if (typeof full === "string" && full.trim()) {
            content = full.trim();
          }
        } catch {
          // Use abstract
        }
      }

      if (content.length > cfg.recallMaxChars) {
        content = content.slice(0, cfg.recallMaxChars) + "...";
      }

      const line = `- [${item.category || "memory"}] ${content}`;
      const lineTokens = estimateTokens(line);

      if (lineTokens > budgetRemaining && lines.length > 0) break;

      lines.push(line);
      memories.push({
        category: item.category || "memory",
        content,
        score: clamp01(item.score),
        uri: item.uri,
      });
      budgetRemaining -= lineTokens;
    }

    const injectionText = lines.length > 0
      ? lines.join("\n")
      : "";
    const totalTokens = cfg.recallTokenBudget - budgetRemaining;

    logger?.info(`superpowers-memory: recalled ${memories.length} memories (~${totalTokens} tokens)`);

    return { memories, injectionText, estimatedTokens: totalTokens };
  } catch (err) {
    logger?.warn(`superpowers-memory: recall failed: ${String(err)}`);
    return empty;
  }
}

// --- Capture ---

export type CaptureInput = {
  /** What to store — a structured summary of the decision/learning */
  text: string;
  /** Session identifier for grouping */
  sessionId: string;
};

/**
 * Capture a decision or learning into OpenViking memory.
 * Uses the session → commit pattern (same as openviking plugin).
 */
export async function captureMemory(
  input: CaptureInput,
  cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG,
  logger?: Logger,
): Promise<{ success: boolean; memoriesExtracted: number }> {
  if (!isMemoryConfigured(cfg)) {
    return { success: false, memoriesExtracted: 0 };
  }
  try {
    const ovSessionId = `sp-${input.sessionId}-${Date.now()}`;

    await ovRequest<unknown>(cfg, `/api/v1/sessions/${encodeURIComponent(ovSessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: input.text }),
    });

    const result = await ovRequest<{
      memories_extracted?: number;
      archived?: boolean;
    }>(cfg, `/api/v1/sessions/${encodeURIComponent(ovSessionId)}/commit?wait=true`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    const count = result.memories_extracted || 0;
    logger?.info(`superpowers-memory: captured ${count} memories from session ${ovSessionId}`);

    return { success: true, memoriesExtracted: count };
  } catch (err) {
    logger?.warn(`superpowers-memory: capture failed: ${String(err)}`);
    return { success: false, memoriesExtracted: 0 };
  }
}

// --- Memory-enriched prompt builders ---

/**
 * Build a memory context block for injection before brainstorming.
 * Searches for memories related to the user's task description.
 */
export async function buildBrainstormMemoryContext(
  taskDescription: string,
  cfg?: Partial<MemoryConfig>,
  logger?: Logger,
): Promise<string> {
  const mergedCfg = { ...DEFAULT_MEMORY_CONFIG, ...cfg };
  const result = await recallMemories(taskDescription, mergedCfg, logger);

  if (result.memories.length === 0) return "";

  return `<superpowers-memory-context>
## 相关记忆（来自 OpenViking）

以下是与当前任务可能相关的过往记忆。在头脑风暴时请参考这些信息，
特别是过去的设计决策、用户偏好、和踩过的坑：

${result.injectionText}

注意：这些记忆来自过去的对话，可能已过时。如果与当前代码状态矛盾，以当前状态为准。
</superpowers-memory-context>`;
}

/**
 * Build a memory context block for injection before debugging.
 * Searches for memories related to the error/bug description.
 */
export async function buildDebugMemoryContext(
  errorDescription: string,
  cfg?: Partial<MemoryConfig>,
  logger?: Logger,
): Promise<string> {
  const mergedCfg = { ...DEFAULT_MEMORY_CONFIG, ...cfg };
  const result = await recallMemories(errorDescription, mergedCfg, logger);

  if (result.memories.length === 0) return "";

  return `<superpowers-debug-memory>
## 相关调试记忆

以下是与当前问题可能相关的过往记忆。
特别注意过去类似问题的根因和解决方案：

${result.injectionText}

注意：过去的修复方案可能不再适用，但可以指导调查方向。
</superpowers-debug-memory>`;
}

/**
 * Build a structured summary for capturing after brainstorming.
 * Called when a design decision or spec is finalized.
 */
export function buildDecisionSummary(params: {
  task: string;
  decision: string;
  approach: string;
  reasoning?: string;
  specPath?: string;
  planPath?: string;
}): string {
  const parts = [
    `任务: ${params.task}`,
    `决策: ${params.decision}`,
    `方案: ${params.approach}`,
  ];
  if (params.reasoning) parts.push(`原因: ${params.reasoning}`);
  if (params.specPath) parts.push(`Spec: ${params.specPath}`);
  if (params.planPath) parts.push(`Plan: ${params.planPath}`);
  return parts.join("\n");
}

/**
 * Build a structured summary for capturing after debugging.
 */
export function buildDebugSummary(params: {
  symptom: string;
  rootCause: string;
  fix: string;
  filesModified?: string[];
  lesson?: string;
}): string {
  const parts = [
    `症状: ${params.symptom}`,
    `根因: ${params.rootCause}`,
    `修复: ${params.fix}`,
  ];
  if (params.filesModified?.length) parts.push(`修改文件: ${params.filesModified.join(", ")}`);
  if (params.lesson) parts.push(`教训: ${params.lesson}`);
  return parts.join("\n");
}

export { DEFAULT_MEMORY_CONFIG, type MemoryConfig };
