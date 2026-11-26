import type { rn as en } from "../en/rn";

export const rn: Record<keyof typeof en, string> = {
  "rn.close": "关闭节点",
  "rn.attempt": "第 {n}/{total} 次尝试",
  "rn.notStarted": "未开始",
  "rn.route": "路由：{why}",
  "rn.why": "原因：",
  "rn.open": "进行中",
  "rn.noHandoff": "没有写交接说明。",
  "rn.ask": "在聊天中请求",
  "rn.askHint": "会把重试请求放入消息框，不会发送。",
  "rn.chainHead": "chain head",
  "rn.fallback": "fallback",
  "rn.exhausted": "链已用尽",
  "rn.task": "任务 {n}",
  "rn.from": "（来自 {from}）",
  "rn.retryMsg": "重试运行 {run} 中的 {node}",
};
