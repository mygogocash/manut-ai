import type { ef as en } from "../en/ef";

export const ef: Record<keyof typeof en, string> = {
  // the effort card (item 132): the chip while it is open, the card's title with no levels, its buttons and the slider
  "ef.select": "생각의 깊이 선택",
  "ef.standard": "표준",
  "ef.none": "이 모델에는 고를 수 있는 생각의 깊이가 없습니다.",
  "ef.reset": "기본값으로 되돌리기",
  "ef.chooseModel": "모델 고르기",
  "ef.selectModel": "모델 선택",
  "ef.back": "뒤로",
  "ef.slider": "생각의 깊이",
  // the one-click Ultrathink row, Claude Code chats only: a visible line in the draft
  "ef.utTitle": "이 메시지에 Ultrathink",
  "ef.utAdds": "이 메시지 맨 위에 “Ultrathink:”를 넣어 Claude Code가 더 꼼꼼히 생각하게 합니다.",
  "ef.utTyped": "끄려면 메시지에서 “ultrathink”를 지우세요.",
  "ef.utSlash": "Claude Code는 슬래시 명령 안의 ultrathink를 읽지 않습니다.",
};
