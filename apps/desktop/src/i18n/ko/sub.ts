import type { sub as en } from "../en/sub";

export const sub: Record<keyof typeof en, string> = {
  "sub.queued": "대기",
  "sub.running": "실행 중",
  "sub.thinking": "생각 중",
  "sub.done": "완료",
  "sub.failed": "실패",
  "sub.cancelled": "중단",
  "sub.stopped": "응답 없음",
  "sub.waiting": "대기 중",
  "sub.untitled": "서브에이전트 {n}",
  "sub.runningDone": "실행 중 · {n}개 중 {done}개 완료 · {t}",
  "sub.waitingDone": "대기 중 · {n}개 중 {done}개 완료 · {t}",
  "sub.ran1": "서브에이전트 1개 실행함 · {t}",
  "sub.ranN": "서브에이전트 {n}개 실행함 · {t}",
  "sub.nfailed": "{n}개 실패",
};
