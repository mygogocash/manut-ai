import type { sub as en } from "../en/sub";

export const sub: Record<keyof typeof en, string> = {
  "sub.queued": "排队",
  "sub.running": "运行中",
  "sub.thinking": "思考中",
  "sub.done": "完成",
  "sub.failed": "失败",
  "sub.cancelled": "已停止",
  "sub.stopped": "无回应",
  "sub.waiting": "等待中",
  "sub.untitled": "子代理 {n}",
  "sub.runningDone": "运行中 · 已完成 {done}/{n} · {t}",
  "sub.waitingDone": "等待中 · 已完成 {done}/{n} · {t}",
  "sub.ran1": "运行了 1 个子代理 · {t}",
  "sub.ranN": "运行了 {n} 个子代理 · {t}",
  "sub.nfailed": "{n} 个失败",
};
