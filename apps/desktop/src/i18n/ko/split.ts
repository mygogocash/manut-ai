import type { split as en } from "../en/split";

export const split: Record<keyof typeof en, string> = {
  "split.closeSide": "이쪽의 {name} 닫기",
  "split.grip": "{name} 옮기기: 창의 가장자리로 끌거나, 클릭해 메뉴 열기",
  "split.zoomed": "확대됨: 창 {n}개 중 하나",
  "split.inSplit": "열린 분할에 있음: {name}",
  "split.focusedPane": "열린 분할의 포커스 창: {name}",
  "split.map": "분할",
  "split.mapFocus": "{name}에 포커스",
};
