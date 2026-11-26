import type { split as en } from "../en/split";

export const split: Record<keyof typeof en, string> = {
  "split.closeSide": "この側の {name} を閉じる",
  "split.grip": "{name} を移動: ペインの端へドラッグ、クリックでメニュー",
  "split.zoomed": "拡大中: {n} 個のペインのうち 1 つ",
  "split.inSplit": "開いている分割に含まれる: {name}",
  "split.focusedPane": "開いている分割のフォーカス中のペイン: {name}",
  "split.map": "分割",
  "split.mapFocus": "{name} にフォーカス",
};
