import type { cmp as en } from "../en/cmp";

export const cmp: Record<keyof typeof en, string> = {
  "cmp.skillHint": "{bot} 没有技能列表：请在开头输入完整名称，例如 {example}",
  "cmp.skillSigil": "技能用 $ 输入，可写在消息的任意位置，例如 {example}。/ 命令会原样发给 {bot}。",
  "cmp.removeReply": "移除回复目标",
  "cmp.remove": "移除",
  "cmp.offline": "{bot} 已离线",
  "cmp.replyThere": "告诉 {bot} 要在那里发什么",
  "cmp.asking": "在上方回答，或直接输入回复",
  "cmp.message": "给 {bot} 发消息",
  "cmp.stop": "停止",
  "cmp.send": "发送",
};
