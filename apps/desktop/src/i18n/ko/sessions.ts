import type { sessions as en } from "../en/sessions";

export const sessions: Record<keyof typeof en, string> = {
  // sessions (SESSIONS in the sidebar)
  "sessions.choose": "폴더 선택…",
  "sessions.recent": "최근",
  "sessions.back": "뒤로",
  "sessions.new": "새 채팅 또는 터미널",
  "sessions.home": "홈",
  "sessions.start": "시작",
  "sessions.agent": "에이전트",
  "sessions.folder": "폴더",
  "sessions.firstSend": "첫 메시지를 보내면 {agent}가 {folder}에서 시작해요",
  "sessions.firstStart": "시작을 누르면 {agent}가 {folder}에서 터미널로 열려요",
  "sessions.pressStart": "시작을 누르면 {agent}가 터미널로 열려요",
  "sessions.findingHome": "홈 폴더를 찾는 중…",
  "sessions.notInstalled": "설치 안 됨",
};
