import type { sqs as en } from "../en/sqs";

export const sqs: Record<keyof typeof en, string> = {
  // steer queue sessions
  "sqs.handed": "已交给 {agent} · 它接下来会读",
  "sqs.noSteer": "{agent} 无法在回答中途接收消息",
};
