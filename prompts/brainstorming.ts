/**
 * Brainstorming prompts — kept SHORT to minimize context overhead.
 * The full superpowers philosophy is embedded; the prompt is a trigger, not a textbook.
 */

export const BRAINSTORMING_PROMPT = `
<superpowers-brainstorming>
【强制规则】你现在禁止写代码、创建文件、或执行任何实现操作。

你必须先完成设计流程：
1. 问用户 1 个关键问题（目的、约束、或范围）— 每次只问一个
2. 收集够信息后，提出 2-3 个方案并推荐一个
3. 用户明确批准方案后，才允许写代码

即使之前做过类似的东西，也必须先确认用户这次的需求。不要假设。
违反此规则（未经确认就写代码）将被视为错误。
</superpowers-brainstorming>
`.trim();

export const BRAINSTORMING_CONTINUATION_PROMPT = `
<superpowers-continue>
继续设计流程：收集需求→提方案→用户批准→才能写代码。
</superpowers-continue>
`.trim();
