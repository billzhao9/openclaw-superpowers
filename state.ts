/**
 * Session state management for superpowers workflow.
 *
 * Tracks where each conversation is in the brainstorming → planning → execution pipeline.
 * State is kept in-memory per session (reset on restart, which is fine since
 * brainstorming sessions are ephemeral).
 */

export type WorkflowPhase =
  | "idle"              // No active brainstorming
  | "brainstorming"     // Gathering requirements, proposing approaches
  | "design_review"     // Design presented, waiting for approval
  | "spec_writing"      // Writing the spec document
  | "spec_review"       // Spec written, waiting for user review
  | "planning"          // Writing implementation plan
  | "debugging"         // Systematic debugging in progress
  | "plan_review"       // Plan written, waiting for user review
  | "executing"         // Executing the plan
  | "verifying";        // Verifying completion

export type SessionState = {
  phase: WorkflowPhase;
  taskSummary: string;      // Brief description of what's being brainstormed
  turnCount: number;        // How many turns in current phase
  specPath?: string;        // Path to written spec file
  planPath?: string;        // Path to written plan file
  startedAt: number;        // Timestamp when brainstorming started
  lastUpdatedAt: number;    // Timestamp of last state update
};

const sessions = new Map<string, SessionState>();

export function getSession(sessionKey: string): SessionState | undefined {
  return sessions.get(sessionKey);
}

export function startSession(sessionKey: string, taskSummary: string): SessionState {
  const state: SessionState = {
    phase: "brainstorming",
    taskSummary,
    turnCount: 0,
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
  };
  sessions.set(sessionKey, state);
  return state;
}

export function updateSession(
  sessionKey: string,
  updates: Partial<SessionState>,
): SessionState | undefined {
  const existing = sessions.get(sessionKey);
  if (!existing) return undefined;

  const updated = {
    ...existing,
    ...updates,
    lastUpdatedAt: Date.now(),
  };
  sessions.set(sessionKey, updated);
  return updated;
}

export function advancePhase(sessionKey: string): SessionState | undefined {
  const existing = sessions.get(sessionKey);
  if (!existing) return undefined;

  const phaseOrder: WorkflowPhase[] = [
    "brainstorming",
    "design_review",
    "spec_writing",
    "spec_review",
    "planning",
    "plan_review",
    "executing",
    "verifying",
  ];

  const currentIndex = phaseOrder.indexOf(existing.phase);
  if (currentIndex < 0 || currentIndex >= phaseOrder.length - 1) {
    return existing;
  }

  return updateSession(sessionKey, {
    phase: phaseOrder[currentIndex + 1],
    turnCount: 0,
  });
}

export function incrementTurn(sessionKey: string): SessionState | undefined {
  const existing = sessions.get(sessionKey);
  if (!existing) return undefined;

  return updateSession(sessionKey, {
    turnCount: existing.turnCount + 1,
  });
}

export function endSession(sessionKey: string): void {
  sessions.delete(sessionKey);
}

export function isActiveSession(sessionKey: string): boolean {
  const state = sessions.get(sessionKey);
  return !!state && state.phase !== "idle";
}

/**
 * Detect phase transitions from agent response text.
 * Returns the new phase if a transition is detected, or null otherwise.
 */
export function detectPhaseTransition(
  responseText: string,
  currentPhase: WorkflowPhase,
): WorkflowPhase | null {
  const lower = responseText.toLowerCase();

  switch (currentPhase) {
    case "brainstorming":
      // Detect when agent presents a design or asks for design approval
      if (
        /(?:方案如下|设计如下|架构如下|here'?s (?:the|my) (?:design|proposal|approach))/i.test(responseText) ||
        /(?:你觉得|what do you think|does this look|approve|approval)/i.test(responseText)
      ) {
        return "design_review";
      }
      break;

    case "design_review":
      // Detect when writing spec
      if (
        /(?:写入|保存|saved|writing|wrote).{0,30}(?:spec|设计文档|design doc)/i.test(responseText) ||
        /(?:spec|设计文档).{0,20}(?:如下|written|saved|created)/i.test(responseText)
      ) {
        return "spec_review";
      }
      break;

    case "spec_review":
      // Detect transition to planning
      if (
        /(?:开始|transition|moving|进入).{0,20}(?:计划|planning|implementation plan)/i.test(responseText) ||
        /(?:实施计划|implementation plan).{0,20}(?:如下|follows|begin)/i.test(responseText)
      ) {
        return "planning";
      }
      break;

    case "planning":
      // Detect plan completion
      if (
        /(?:计划完成|plan (?:is )?(?:complete|done|ready|written))/i.test(responseText) ||
        /(?:写入|保存|saved).{0,30}(?:plan|计划)/i.test(responseText)
      ) {
        return "plan_review";
      }
      break;

    case "plan_review":
      // Detect execution start
      if (
        /(?:开始执行|starting execution|executing task|begin implementation)/i.test(responseText)
      ) {
        return "executing";
      }
      break;

    case "executing":
      // Detect completion claims
      if (
        /(?:完成|done|complete|finished|all tasks)/i.test(responseText) &&
        /(?:验证|verify|test|check)/i.test(responseText)
      ) {
        return "verifying";
      }
      break;

    case "debugging":
      // Debugging can transition to brainstorming if root cause requires a redesign
      if (
        /(?:需要重构|需要重新设计|architectural problem|question the architecture|质疑架构)/i.test(responseText)
      ) {
        return "brainstorming";
      }
      // Or to verifying if fix is applied
      if (
        /(?:修复已|fix (?:applied|implemented|verified)|已修复|bug.*(?:fixed|resolved))/i.test(responseText) &&
        /(?:验证|verify|test|confirm)/i.test(responseText)
      ) {
        return "verifying";
      }
      break;
  }

  return null;
}
