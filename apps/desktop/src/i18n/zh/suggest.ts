import type { suggest as en } from "../en/suggest";

export const suggest: Record<keyof typeof en, string> = {
  "suggest.group": "下一条消息建议",
  "suggest.title": "建议下一句话",
  "suggest.hintCost": "编程聊天完成一轮后，空输入框会以灰色显示一条建议的下一条消息。按 Tab 使用，或直接输入。它绝不会自动发送任何内容。每条建议都会在每一轮之后多用一次你自己 AI 套餐的请求，所以在你打开之前它是关闭的。它对打开之后新开的聊天生效。",
  "suggest.agents": "支持的智能体",
  "suggest.agentsHint": "Codex 和其他编程智能体暂时没有请求建议的方式，所以它们的聊天不会显示建议。",
  "suggest.agentsValue": "Claude Code",
  "suggest.hint": "建议的下一条消息。按 Tab 使用，输入则会替换它。",
};
