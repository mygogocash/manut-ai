import type { gathered as en } from "../en/gathered";

export const gathered: Record<keyof typeof en, string> = {
  // The gathered answers of a job (item 102c)
  "gathered.tab": "모은 답변 {n}/{total}",
  "gathered.count": "모은 답변: {total}개 중 {n}개 답변 완료",
  "gathered.compare": "채팅에서 비교…",
  "gathered.compareTip": "이 답변들을 채팅의 입력창에 넣습니다. 보내지는 않으며, 그 채팅에서 보내기를 누르기 전에는 아무것도 전송되지 않습니다.",
  "gathered.compareNeed": "비교하려면 답변이 2개 필요합니다.",
  "gathered.answer": "답하기",
  "gathered.waitingCount": "{n}개가 내 답을 기다리는 중",
  "gathered.laneLabel": "{agent}의 답변",
  "gathered.waiting": "내 답을 기다리는 중입니다. 지금까지 쓴 글은 답변으로 세지 않습니다.",
  "gathered.working": "아직 작업 중입니다.",
  "gathered.failed": "답변 없이 멈췄습니다.",
  "gathered.none": "아직 답하지 않았습니다.",
  "gathered.files": "바뀐 파일: {n}",
  "gathered.noFiles": "바뀐 파일 없음",
  "gathered.filesMore": "외 {n}개",
  "gathered.tests": "테스트",
  "gathered.noTests": "실행한 테스트 없음",
  "gathered.put": "{title}의 입력창에 답변 {n}개를 넣었습니다. 그 채팅에서 보내기를 누르기 전에는 아무것도 전송되지 않습니다.",
  "gathered.open": "그 채팅 열기",
  "gathered.gone": "{title}을(를) 더 이상 찾을 수 없습니다.",
};
