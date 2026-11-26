import type { ask as en } from "../en/ask";

export const ask: Record<keyof typeof en, string> = {
  // the "say it in words" box on Automations and Plugins
  "ask.to": "发给 {bot}",
  "ask.pickBot": "选择机器人",
  "ask.send": "发送到 {bot} 的聊天",
  "ask.offline": "{bot} 已离线。请先启动它的网关，再试一次。",
  "ask.allowCmd": "允许 {cmd}？",
  "ask.allowThis": "允许这条命令？",
  "ask.questions": "{n} 个问题：{first}",
  "ask.sessionEnded": "这个会话已结束",
};
