import type { drafts as en } from "../en/drafts";

export const drafts: Record<keyof typeof en, string> = {
  "drafts.title": "임시 보관함",
  "drafts.count": "{max}개 중 {n}개",
  "drafts.backTo": "{place}에 다시 넣기",
  "drafts.move": "옮기기",
  "drafts.moveOf": "“{words}” 옮길 곳",
  "drafts.onlyFiles": "파일만",
  "drafts.delete": "삭제",
  "drafts.deleteOf": "“{words}” 임시 글 삭제",
  "drafts.letGo": "임시 보관함은 {max}개까지라 가장 오래된 것을 뺐습니다: {words}",
  "drafts.undo": "되돌리기",
  "drafts.home": "홈",
  "drafts.toHome": "홈 입력창 (새 채팅)",
  "drafts.toChat": "{name}의 채팅",
  "drafts.toProject": "{name} (코딩 채팅)",
  "drafts.file": "파일 1개",
  "drafts.files": "파일 {n}개",
  "drafts.from": "{place}에서",
};
