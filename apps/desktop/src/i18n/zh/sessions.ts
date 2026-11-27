import type { sessions as en } from "../en/sessions";

export const sessions: Record<keyof typeof en, string> = {
  // sessions (SESSIONS in the sidebar)
  "sessions.choose": "选择文件夹…",
  "sessions.recent": "最近",
  "sessions.back": "返回",
  "sessions.new": "新建聊天或终端",
  "sessions.home": "主目录",
  "sessions.start": "开始",
  "sessions.agent": "代理",
  "sessions.folder": "文件夹",
  "sessions.firstSend": "发送第一条消息后，{agent} 会在 {folder} 中启动",
  "sessions.firstStart": "按“开始”后，{agent} 会在 {folder} 的终端中打开",
  "sessions.pressStart": "按“开始”在终端中打开 {agent}",
  "sessions.findingHome": "正在查找主目录…",
  "sessions.notInstalled": "未安装",
};
