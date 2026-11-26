import type { sq as en } from "../en/sq";

export const sq: Record<keyof typeof en, string> = {
  // steer queue
  "sq.sendNow": "立即发送",
  "sq.sendNowTip": "停止当前回答，接着发送这条",
  "sq.steer": "Steer",
  "sq.steerTip": "不停止，交给当前回答",
  "sq.edit": "编辑",
  "sq.editTip": "放回输入框",
  "sq.delete": "删除",
  "sq.deleteTip": "不发送",
  "sq.unknown": "可能已经在回答里了",
  "sq.unused": "未使用 · 回答先停止了",
  "sq.send": "发送",
  "sq.sendTip": "作为新消息发送",
};
