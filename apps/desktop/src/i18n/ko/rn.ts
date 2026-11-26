import type { rn as en } from "../en/rn";

export const rn: Record<keyof typeof en, string> = {
  "rn.close": "노드 닫기",
  "rn.attempt": "{total}번 중 {n}번째 시도",
  "rn.notStarted": "시작 전",
  "rn.route": "경로: {why}",
  "rn.why": "이유: ",
  "rn.open": "진행 중",
  "rn.noHandoff": "작성된 handoff가 없어요.",
  "rn.ask": "채팅에서 요청",
  "rn.askHint": "입력창에 재시도 요청을 넣어요. 보내지는 않아요.",
  "rn.chainHead": "chain head",
  "rn.fallback": "fallback",
  "rn.exhausted": "chain exhausted",
  "rn.task": "작업 {n}",
  "rn.from": " ({from}에서)",
  "rn.retryMsg": "실행 {run}의 {node} 다시 시도해 줘",
};
