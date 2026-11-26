import type { harness as en } from "../en/harness";

export const harness: Record<keyof typeof en, string> = {
  "harness.working": "작업 중: {who}",
  "harness.trail": "현재 위치",
  "harness.openChat": "채팅으로 열기",
  "harness.closeChat": "계획으로 돌아가기",
  "harness.loading": "세션을 읽는 중…",
  "harness.error": "세션을 읽지 못했어요: {error}",
  "harness.none": "이 부분의 세션을 아직 찾지 못했어요.",
  "harness.noCli": "{agent}이(가) 이 부분을 맡았지만, 그 세션이 이 컴퓨터에 없어요.",
  "harness.openChild": "{name} 열기",
  "harness.session": "세션",
};
