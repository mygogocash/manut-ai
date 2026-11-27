import type { use as en } from "../en/use";

export const use: Record<keyof typeof en, string> = {
  "use.stale": "최근 기록 없음",
  "use.none": "아직 사용량 없음",
  "use.resetsIn": "{t} 후 초기화",
  "use.near": "한도에 가까움",
  "use.ok": "정상",
  "use.noRecord": "기록 없음",
  "use.claudeNext": "Manut AI에서 다음 Claude 응답 뒤에 보여요",
  "use.cpaLogin": "CLIProxyAPI 로그인",
  "use.meter": "{name} 사용량: {value}",
  "use.card": "{name} 사용량",
  "use.logins": "로그인 {n}개",
};
