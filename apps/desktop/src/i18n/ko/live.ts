import type { live as en } from "../en/live";

export const live: Record<keyof typeof en, string> = {
  "live.running": "실행 중",
  "live.reading": "읽는 중",
  "live.searching": "검색 중",
  "live.searchingWeb": "웹 검색 중",
  "live.editing": "편집 중",
  "live.asking": "맡기는 중",
  "live.usingSkill": "스킬 사용 중",
  "live.waitApproval": "확인 필요",
  "live.retrying": "다시 시도 중 {n}/{max}",
  "live.waitAnswer": "답 기다리는 중",
  "live.lost": "연결이 끊겼어요",
};
