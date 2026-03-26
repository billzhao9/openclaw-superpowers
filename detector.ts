/**
 * Smart detection for superpowers.
 *
 * INVERTED LOGIC: Instead of detecting what IS a task (hard, fragile),
 * we detect what is clearly NOT a task, and brainstorm everything else.
 *
 * Philosophy from original superpowers:
 * "Every project goes through this process. A todo list, a single-function
 *  utility, a config change — all of them."
 *
 * So the default is: brainstorm. Only skip for things that obviously don't need it.
 */

// --- Things that are clearly NOT tasks (skip brainstorming) ---

const SKIP_PATTERNS = [
  // Very short responses / confirmations
  /^.{0,5}$/,
  /^(?:ok|好|嗯|嗯嗯|行|是|是的|对|对的|没错|yes|no|yep|nope|sure|thanks|谢|谢谢|明白|知道了|了解|收到|好的|可以|继续|next|done|go)$/i,

  // Slash commands
  /^\/[a-z]/i,

  // Greetings
  /^(?:hi|hello|hey|你好|早|晚安|嗨|哈喽)[\s!！.。]*$/i,

  // Pure emoji or reactions
  /^[\p{Emoji}\s]+$/u,
];

// --- Things that are clearly debug/error situations ---

const DEBUG_PATTERNS = [
  /(?:报错|错误|失败|出错|异常|崩溃|挂了|不工作|不正常|有问题|有bug|bug)/i,
  /(?:修|修复|修一下|fix|debug|调试|排查|排错)/i,
  /(?:为什么|为啥).{0,15}(?:报错|失败|不工作|不行|出问题|出错)/i,
  /(?:error|bug|crash|fail|broken|not working|doesn't work)\b/i,
  /(?:why (?:is|does|did|doesn't|isn't)).{0,20}(?:fail|error|crash|break|work)/i,
];

// --- Config file modifications ---

const CONFIG_PATTERNS = [
  /openclaw\.json/i,
  /soul\.md/i,
  /skill\.md/i,
  /openclaw\.plugin\.json/i,
  /(?:修改|改|编辑|更新|调整).{0,15}(?:配置|设置|config|soul|skill)/i,
  /(?:edit|modify|change|update)\s+(?:the\s+)?(?:config|settings|soul|skill)/i,
];

// --- Continuation patterns (user responding to brainstorming) ---

const CONTINUATION_PATTERNS = [
  /方案\s*[abc123一二三]/i,
  /(?:option|approach|方案)\s*(?:a|b|c|1|2|3)/i,
  /(?:第一个|第二个|第三个|推荐的|你推荐的)/i,
  /(?:同意|赞成|就这样|就这个|选这个|用这个|没问题|批准|approved)/i,
  /(?:不太好|不行|换一个|再想想|其他方案|不同意)/i,
  /(?:approve|looks good|lgtm|go ahead|proceed|sounds good)/i,
  /(?:change|modify|adjust|tweak|instead|but what about|what if)/i,
];

// --- Types ---

export type DetectionMode =
  | "brainstorm"     // Default: new task needing design
  | "debug"          // Error/bug needing systematic debugging
  | "config_safety"  // Config file modification
  | "continuation"   // Continuing an active session
  | "skip";          // Clearly not a task

export type DetectionResult = {
  mode: DetectionMode;
  confidence: "high" | "moderate" | "low";
  reason: string;
  needsConfigSafety: boolean;
};

export function detectPrompt(
  text: string,
  customSkipPatterns?: RegExp[],
): DetectionResult {
  const trimmed = text.trim();

  if (!trimmed) {
    return { mode: "skip", confidence: "high", reason: "empty", needsConfigSafety: false };
  }

  // 1. Check explicit skip patterns
  const allSkipPatterns = [...SKIP_PATTERNS, ...(customSkipPatterns || [])];
  for (const p of allSkipPatterns) {
    if (p.test(trimmed)) {
      return { mode: "skip", confidence: "high", reason: `skip:${p.source.slice(0, 25)}`, needsConfigSafety: false };
    }
  }

  // 2. Check config safety (can overlay on other modes)
  let needsConfigSafety = false;
  for (const p of CONFIG_PATTERNS) {
    if (p.test(trimmed)) {
      needsConfigSafety = true;
      break;
    }
  }

  // 3. Check continuation
  for (const p of CONTINUATION_PATTERNS) {
    if (p.test(trimmed)) {
      return { mode: "continuation", confidence: "high", reason: "continuation", needsConfigSafety };
    }
  }

  // 4. Check debug
  for (const p of DEBUG_PATTERNS) {
    if (p.test(trimmed)) {
      return { mode: "debug", confidence: "high", reason: `debug:${p.source.slice(0, 25)}`, needsConfigSafety };
    }
  }

  // 5. DEFAULT: brainstorm everything else
  // This is the key insight — instead of trying to detect tasks,
  // we assume everything that isn't skipped IS a task.
  return { mode: "brainstorm", confidence: "moderate", reason: "default_brainstorm", needsConfigSafety };
}
