import type { update as en } from "../en/update";

export const update: Record<keyof typeof en, string> = {
  // while it answers (Settings › General)
  // update (the sidebar's Update button and its confirm) and resume after a restart
  "update.title": "{version}(으)로 업데이트할까요?",
  "update.body": "Manut AI가 다시 시작돼요. 채팅, 패널, 세션은 하던 곳에서 이어져요.",
  "update.running1": "실행 중인 세션 1개: {list}.",
  "update.runningN": "실행 중인 세션 {n}개: {list}.",
  "update.thenAuto1": "다시 시작한 뒤 이어서 실행돼요.",
  "update.thenAuto": "다시 시작한 뒤 이어서 실행돼요.",
  "update.thenManual1": "다시 시작한 뒤 이어하기 버튼으로 이어 갈 수 있어요.",
  "update.thenManual": "다시 시작한 뒤 이어하기 버튼으로 이어 갈 수 있어요.",
  "update.thenMixed": "Claude Code, Codex, OmO는 이어서 실행되고, 나머지는 다시 시작한 뒤 이어하기 버튼으로 이어 갈 수 있어요.",
  "update.cancel": "취소",
  "update.confirm": "업데이트하고 다시 시작",
};
