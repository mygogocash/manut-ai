import type { later as en } from "../en/later";

export const later: Record<keyof typeof en, string> = {
  "later.title": "한도 초기화를 기다리는 메시지",
  "later.limit": "이 계정은 {when}까지 한도에 도달했습니다. Enter로 지금 보낼 수도 있습니다.",
  "later.limitFiles": "이 계정은 {when}까지 한도에 도달했습니다. 파일이 있는 메시지는 기다리게 할 수 없습니다.",
  "later.sendAt": "{when}에 보내기",
  "later.waiting": "{when}에 보내려고 기다리는 중:",
  "later.waitingReady": "계정을 다시 쓸 수 있을 때까지 기다리는 중:",
  "later.late": "{since}부터 기다리던 메시지입니다. 지금 보낼까요?",
  "later.lateOf": "{name}에게 보낼 메시지가 {since}부터 기다리고 있었습니다. 지금 보낼까요?",
  "later.sendNow": "지금 보내기",
  "later.open": "열기",
  "later.cancel": "취소",
  "later.aChat": "채팅",
};
