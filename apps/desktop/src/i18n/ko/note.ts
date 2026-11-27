import type { note as en } from "../en/note";

export const note: Record<keyof typeof en, string> = {
  "note.approval": "{bot}가 승인을 기다려요",
  "note.mayHoldKey": "키가 들어 있을 수 있는 명령이에요. Manut AI를 열어 확인하세요.",
  "note.question": "{bot}가 질문했어요",
  "note.error": "{bot}가 오류로 멈췄어요",
  "note.failed": "요청이 실패했어요.",
  "note.session.ended": "{name} 세션이 끝났어요",
  "note.session.endedBody": "프로그램이 종료됐어요.",
  "note.session.failed": "{name} 세션을 시작하지 못했어요",
  "note.session.bell": "{name} 세션이 확인을 기다려요",
  "note.session.bellBody": "터미널 벨을 울렸어요.",
  "note.waiting": "기다리고 있어요.",
  "note.watchMany": "{bot}: 모니터링 알림 {n}건",
  "note.atShop": "{shop}의 {bot}",
};
