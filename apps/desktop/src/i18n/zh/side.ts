import type { side as en } from "../en/side";

export const side: Record<keyof typeof en, string> = {
  "side.noBot": "没有名为“{q}”的机器人",
  "side.noSession": "没有与“{q}”匹配的会话",
  // spacing: the BOTS | TERMINALS divider
  "side.split": "调整机器人和终端的高度",
  "side.splitTip": "拖动为机器人或终端留出更多空间。双击恢复自动。",
  "side.hide": "隐藏侧边菜单",
  "side.show": "显示侧边菜单",
  "side.resize": "侧边菜单宽度",
  "side.resizeTip": "拖动以更改宽度。双击恢复默认宽度。",
};
