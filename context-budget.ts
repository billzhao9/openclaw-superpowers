/**
 * Context budget manager for superpowers.
 *
 * Controls total injection size to prevent context bloat.
 *
 * Key insight from OpenClaw context management:
 *  - System prompt: ~9,600 tokens per request
 *  - Tool schemas: ~8,000 tokens per request
 *  - Workspace files: up to ~35,600 tokens per message
 *  - Memory injection hard limit: 8,192 tokens
 *  - Before user's first message: 20,000-40,000 tokens already consumed
 *
 * Our budget must be conservative:
 *  - First turn: full prompt + memory, but well under 8K memory limit
 *  - Continuation: minimal prompt only, NO memory re-injection
 *  - Executing: zero injection
 *  - After 5+ turns in same phase: suggest /compact to user
 *
 * Token estimation: chars / 4 (same heuristic as OpenViking)
 */

import type { WorkflowPhase } from "./state.js";

export type BudgetConfig = {
  /** Max tokens for the full initial injection (prompt + memory + safety) */
  maxInitialTokens: number;
  /** Max tokens for continuation injections */
  maxContinuationTokens: number;
  /** Max tokens for memory recall (must stay under OpenClaw's 8192 limit) */
  maxMemoryTokens: number;
  /** Turn count threshold to suggest compaction */
  compactionSuggestThreshold: number;
};

export const DEFAULT_BUDGET: BudgetConfig = {
  maxInitialTokens: 2500,     // Conservative: ~10K chars, leaves room for system overhead
  maxContinuationTokens: 400, // ~1.6K chars, just the phase reminder
  maxMemoryTokens: 1200,      // Well under the 8192 hard limit
  compactionSuggestThreshold: 6,
};

function estimateTokens(text: string): number {
  return Math.ceil((text || "").length / 4);
}

/**
 * Trim text to fit within a token budget.
 * Tries to cut at a paragraph or sentence boundary.
 */
function trimToTokenBudget(text: string, maxTokens: number): string {
  const currentTokens = estimateTokens(text);
  if (currentTokens <= maxTokens) return text;

  const maxChars = maxTokens * 4;
  let cut = text.slice(0, maxChars);

  // Try to cut at a paragraph boundary
  const lastParagraph = cut.lastIndexOf("\n\n");
  if (lastParagraph > maxChars * 0.6) {
    cut = cut.slice(0, lastParagraph);
  } else {
    // Try sentence boundary
    const lastSentence = cut.lastIndexOf("。");
    const lastPeriod = cut.lastIndexOf(". ");
    const boundary = Math.max(lastSentence, lastPeriod);
    if (boundary > maxChars * 0.6) {
      cut = cut.slice(0, boundary + 1);
    }
  }

  return cut + "\n[...context trimmed for token budget]";
}

export type InjectionParts = {
  prompt: string | null;
  memory: string | null;
  safety: string | null;
};

export type BudgetResult = {
  parts: string[];
  totalTokens: number;
  trimmed: boolean;
};

/**
 * Apply budget constraints to injection parts.
 *
 * Priority order (what gets kept when budget is tight):
 *  1. Prompt (core workflow instructions) — always kept, trimmed last
 *  2. Safety (config safety rules) — kept if space allows
 *  3. Memory (recalled memories) — trimmed first if over budget
 */
export function applyBudget(
  injection: InjectionParts,
  phase: WorkflowPhase,
  isFirstTurn: boolean,
  config: BudgetConfig = DEFAULT_BUDGET,
): BudgetResult {
  // Executing phase: zero injection
  if (phase === "executing") {
    return { parts: [], totalTokens: 0, trimmed: false };
  }

  const maxTokens = isFirstTurn ? config.maxInitialTokens : config.maxContinuationTokens;
  const parts: string[] = [];
  let remaining = maxTokens;
  let trimmed = false;

  // 1. Prompt (highest priority)
  if (injection.prompt) {
    const promptTokens = estimateTokens(injection.prompt);
    if (promptTokens <= remaining) {
      parts.push(injection.prompt);
      remaining -= promptTokens;
    } else {
      // Trim the prompt to fit
      const trimmedPrompt = trimToTokenBudget(injection.prompt, remaining);
      parts.push(trimmedPrompt);
      remaining = 0;
      trimmed = true;
    }
  }

  // 2. Safety overlay (medium priority) — only on first turn or config-related
  if (injection.safety && remaining > 100) {
    const safetyTokens = estimateTokens(injection.safety);
    if (safetyTokens <= remaining) {
      parts.push(injection.safety);
      remaining -= safetyTokens;
    } else if (isFirstTurn) {
      const trimmedSafety = trimToTokenBudget(injection.safety, remaining);
      parts.push(trimmedSafety);
      remaining = 0;
      trimmed = true;
    }
    // Skip safety entirely on continuation if no budget
  }

  // 3. Memory (lowest priority, trimmed first) — only on first turn
  if (injection.memory && isFirstTurn && remaining > 100) {
    const memoryBudget = Math.min(remaining, config.maxMemoryTokens);
    const memoryTokens = estimateTokens(injection.memory);
    if (memoryTokens <= memoryBudget) {
      parts.push(injection.memory);
      remaining -= memoryTokens;
    } else {
      const trimmedMemory = trimToTokenBudget(injection.memory, memoryBudget);
      parts.push(trimmedMemory);
      remaining -= estimateTokens(trimmedMemory);
      trimmed = true;
    }
  }

  const totalTokens = maxTokens - remaining;
  return { parts, totalTokens, trimmed };
}

/**
 * Determine if memory should be recalled for this turn.
 * Memory is only recalled on the FIRST turn of a new session,
 * not on every continuation — this is the biggest token saver.
 */
export function shouldRecallMemory(
  phase: WorkflowPhase,
  turnCount: number,
): boolean {
  // Only recall on first turn of brainstorming or debugging
  if (turnCount > 0) return false;
  return phase === "brainstorming" || phase === "debugging";
}

/**
 * Check if we should suggest the user to run /compact.
 * Returns a suggestion string if compaction is advisable, null otherwise.
 *
 * Based on OpenClaw best practices:
 *  - Break work into logical segments
 *  - Run /compact between phases
 *  - Above 60% utilization, compact proactively
 */
export function getCompactionSuggestion(
  phase: WorkflowPhase,
  turnCount: number,
  config: BudgetConfig = DEFAULT_BUDGET,
): string | null {
  // Suggest when staying in same phase for too many turns
  if (turnCount >= config.compactionSuggestThreshold) {
    return `\n<superpowers-hint>对话已进行 ${turnCount} 轮，建议运行 /compact 压缩上下文以保持响应速度。</superpowers-hint>`;
  }

  // Suggest compaction at natural transition points
  if (phase === "spec_review" || phase === "plan_review") {
    if (turnCount >= 3) {
      return "\n<superpowers-hint>当前阶段即将完成，建议运行 /compact 再进入下一阶段。</superpowers-hint>";
    }
  }

  return null;
}

/**
 * Generate a phase-transition-aware compaction hint.
 * Called when phase transitions happen to suggest cleanup.
 */
export function getPhaseTransitionHint(
  oldPhase: WorkflowPhase,
  newPhase: WorkflowPhase,
): string | null {
  // Suggest compaction at major boundaries
  const majorTransitions: Array<[WorkflowPhase, WorkflowPhase]> = [
    ["spec_review", "planning"],     // Design done → planning starts
    ["plan_review", "executing"],    // Plan done → execution starts
    ["executing", "verifying"],      // Execution done → verification
    ["debugging", "verifying"],      // Debug done → verification
  ];

  for (const [from, to] of majorTransitions) {
    if (oldPhase === from && newPhase === to) {
      return `superpowers: 阶段转换 ${oldPhase} → ${newPhase}，建议此时 /compact 释放上下文空间`;
    }
  }

  return null;
}
