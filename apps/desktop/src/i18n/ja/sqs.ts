import type { sqs as en } from "../en/sqs";

export const sqs: Record<keyof typeof en, string> = {
  // steer queue sessions
  "sqs.handed": "すでに {agent} に渡しました · 次に読みます",
  "sqs.noSteer": "{agent} は回答中にメッセージを受け取れません",
};
