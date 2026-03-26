export const CONFIG_SAFETY_PROMPT = `
<openclaw-safety>
配置修改规则：先完整读取→同步更新 plugins.allow/entries/installs→验证 JSON→保持 ID 一致。
soul.md 只在用户明确要求时改。SKILL.md 保持 frontmatter 格式。
</openclaw-safety>
`.trim();
