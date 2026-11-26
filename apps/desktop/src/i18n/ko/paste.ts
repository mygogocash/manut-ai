import type { paste as en } from "../en/paste";

export const paste: Record<keyof typeof en, string> = {
  "paste.label": "붙여넣기 확인",
  "paste.title": "{n}줄을 붙여넣을까요?",
  "paste.titleOne": "줄바꿈으로 끝나는 텍스트를 붙여넣을까요?",
  "paste.hint": "각 줄이 프롬프트에 들어가면 명령으로 실행돼요.",
  "paste.more": "외 {n}줄",
  "paste.ok": "붙여넣기",
  "paste.cancel": "취소",
};
