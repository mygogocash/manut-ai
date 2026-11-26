import type { update as en } from "../en/update";

export const update: Record<keyof typeof en, string> = {
  // while it answers (Settings › General)
  // update (the sidebar's Update button and its confirm) and resume after a restart
  "update.title": "更新到 {version}？",
  "update.body": "Manut AI 将重新启动。聊天、面板和会话会从中断处继续。",
  "update.running1": "1 个会话正在运行：{list}。",
  "update.runningN": "{n} 个会话正在运行：{list}。",
  "update.thenAuto1": "重启后会自动继续。",
  "update.thenAuto": "重启后会自动继续。",
  "update.thenManual1": "重启后可用“继续”按钮恢复。",
  "update.thenManual": "重启后可用“继续”按钮恢复。",
  "update.thenMixed": "Claude Code、Codex 和 OmO 会自动继续，其他会话可用“继续”按钮恢复。",
  "update.cancel": "取消",
  "update.confirm": "更新并重启",
};
