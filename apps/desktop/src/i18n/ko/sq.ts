import type { sq as en } from "../en/sq";

export const sq: Record<keyof typeof en, string> = {
  // steer queue
  "sq.sendNow": "지금 보내기",
  "sq.sendNowTip": "진행 중인 답을 멈추고 이 메시지를 다음으로 보내요",
  "sq.steer": "Steer",
  "sq.steerTip": "멈추지 않고 진행 중인 답에 전달해요",
  "sq.edit": "수정",
  "sq.editTip": "입력창으로 되돌려요",
  "sq.delete": "삭제",
  "sq.deleteTip": "보내지 않아요",
  "sq.unknown": "이미 답에 들어갔을 수 있어요",
  "sq.unused": "쓰이지 않음 · 답이 먼저 멈췄어요",
  "sq.send": "보내기",
  "sq.sendTip": "새 메시지로 보내요",
};
