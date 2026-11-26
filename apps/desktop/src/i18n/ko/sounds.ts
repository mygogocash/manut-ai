import type { sounds as en } from "../en/sounds";

export const sounds: Record<keyof typeof en, string> = {
  // sounds (Settings › General)
  "sounds.title": "소리",
  "sounds.hint": "보낼 때, 봇이 답하거나 물을 때, 오류가 날 때 작은 소리",
  "sounds.play": "재생",
  "sounds.on": "켬",
  "sounds.off": "끔",
};
