export const WRITING_PLANS_PROMPT = `
<superpowers-planning>
编写实施计划。每个任务：具体文件路径、完整代码、验证命令。不允许 TBD/TODO/占位符。
涉及 openclaw.json 的步骤必须包含读取→备份→修改→验证环节。
</superpowers-planning>
`.trim();

export const WRITING_PLANS_CONTINUATION_PROMPT = `
<superpowers-planning-continue>
继续编写计划。每个任务要具体、可验证。
</superpowers-planning-continue>
`.trim();
