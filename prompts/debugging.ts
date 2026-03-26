export const DEBUGGING_PROMPT = `
<superpowers-debug>
系统化调试模式。禁止猜测修复，必须先找根因：
1. 读错误信息 → 2. 稳定复现 → 3. 追踪数据流 → 4. 形成假设 → 5. 最小改动验证
≥3次修复失败 → 停下质疑架构。涉及 openclaw.json 问题先跑 openclaw doctor。
</superpowers-debug>
`.trim();
