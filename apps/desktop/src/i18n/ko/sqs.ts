import type { sqs as en } from "../en/sqs";

export const sqs: Record<keyof typeof en, string> = {
  // steer queue sessions
  "sqs.handed": "이미 {agent}에게 넘어갔어요 · 곧 읽어요",
  "sqs.noSteer": "{agent}는 답하는 중에 메시지를 받을 수 없어요",
};
