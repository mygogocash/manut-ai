import type { side as en } from "../en/side";

export const side: Record<keyof typeof en, string> = {
  "side.noBot": "“{q}”라는 봇이 없어요",
  "side.noSession": "“{q}”와 맞는 세션이 없어요",
  // spacing: the BOTS | TERMINALS divider
  "side.split": "봇과 터미널 높이 조절",
  "side.splitTip": "끌어서 봇이나 터미널 영역을 넓혀요. 더블클릭하면 자동 크기로 돌아가요.",
  "side.hide": "사이드 메뉴 숨기기",
  "side.show": "사이드 메뉴 표시",
  "side.resize": "사이드 메뉴 너비",
  "side.resizeTip": "끌어서 너비를 바꾸세요. 두 번 클릭하면 원래대로 돌아갑니다.",
};
