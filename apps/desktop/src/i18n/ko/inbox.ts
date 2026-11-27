import type { inbox as en } from "../en/inbox";

export const inbox: Record<keyof typeof en, string> = {
  "inbox.group": "사이드 메뉴",
  "inbox.working": "작업 중 묶음",
  "inbox.workingHint": "작업 중인 채팅은 최근 아래의 조용한 '작업 중' 묶음에서 기다리다가, 끝나면 맨 위로 돌아옵니다. 당신이 필요한 채팅은 항상 최근에 남습니다.",
  "inbox.quiet": "조용한 날이 지나면 완료",
  "inbox.quietHint": "이 기간 동안 어느 쪽에서도 메시지가 없고 당신을 기다리는 것도 없는 채팅이나 레인은 '일단 완료'로 표시됩니다. 잃는 것은 없으며, 열거나 질문이 생기면 다시 돌아옵니다.",
  "inbox.day1": "1일",
  "inbox.days": "{n}일",
  "inbox.merged": "풀 리퀘스트가 병합되면 완료",
  "inbox.mergedHint": "GitHub나 GitLab이 풀 리퀘스트가 병합되었다고 알려 준 레인은 '일단 완료'로 표시됩니다. 잃는 것은 없으며, 열면 다시 돌아옵니다.",
};
