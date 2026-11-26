import type { later as en } from "../en/later";

export const later: Record<keyof typeof en, string> = {
  "later.title": "等待额度重置的消息",
  "later.limit": "此账号在 {when} 之前已达上限。按 Enter 仍会现在发送。",
  "later.limitFiles": "此账号在 {when} 之前已达上限。带文件的消息无法等待。",
  "later.sendAt": "在 {when} 发送",
  "later.waiting": "等待在 {when} 发送：",
  "later.waitingReady": "等待账号重新可用：",
  "later.late": "这条消息从 {since} 开始等待。现在发送吗？",
  "later.lateOf": "发给 {name} 的消息从 {since} 开始等待。现在发送吗？",
  "later.sendNow": "现在发送",
  "later.open": "打开",
  "later.cancel": "取消",
  "later.aChat": "一个聊天",
};
