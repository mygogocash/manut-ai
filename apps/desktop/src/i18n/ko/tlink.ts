import type { tlink as en } from "../en/tlink";

export const tlink: Record<keyof typeof en, string> = {
  // terminal links (manut://terminal/<id>)
  "tlink.copy": "링크 복사",
  "tlink.copied": "링크를 복사했어요",
  "tlink.gone": "이 컴퓨터에 없는 터미널",
  "tlink.st.working": "작업 중",
  "tlink.st.waiting": "대기 중",
  "tlink.st.done": "완료",
  "tlink.st.ended": "끝남",
};
