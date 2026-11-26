import type { split as en } from "../en/split";

export const split: Record<keyof typeof en, string> = {
  "split.closeSide": "关闭这一侧的 {name}",
  "split.grip": "移动 {name}：拖到某个分屏的一侧，或点击打开菜单",
  "split.zoomed": "已放大: {n} 个分屏之一",
  "split.inSplit": "在打开的分屏中：{name}",
  "split.focusedPane": "打开的分屏中有焦点的分屏：{name}",
  "split.map": "分屏",
  "split.mapFocus": "聚焦 {name}",
};
