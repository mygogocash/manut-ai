import type { pv as en } from "../en/pv";

export const pv: Record<keyof typeof en, string> = {
  "pv.loading": "불러오는 중…",
  "pv.opened": "{cmd}로 터미널을 열었어요. 거기서 키를 입력하세요. 돌아오면 목록을 새로고침해요.",
  "pv.manual": "터미널에서 {cmd}를 실행하세요.",
  "pv.openFailed": "터미널을 열지 못했어요 ({error}). {cmd}를 직접 실행하세요.",
  "pv.addKey": "키 추가",
  "pv.addKeyFor": "키를 추가할 곳",
  "pv.addApiKeyFor": "API 키를 추가할 곳",
  "pv.setup": "Hermes에서 설정 · {cmd}",
  "pv.copyCmd": "명령 복사",
  "pv.copy": "복사",
  "pv.copied": "복사됨",
  "pv.inUse": "사용 중",
  "pv.addApiKey": "{name} API 키 추가",
  "pv.filter": "모델 {n}개에서 찾기",
  "pv.filterOf": "{name} 모델 찾기",
  "pv.noModels": "모델 없음",
  "pv.noMatch": "“{q}”에 맞는 모델이 없어요",
  "pv.model1": "모델 1개",
  "pv.models": "모델 {n}개",
};
