import type { note as en } from "../en/note";

export const note: Record<keyof typeof en, string> = {
  "note.approval": "{bot} 需要你批准",
  "note.mayHoldKey": "这条命令可能含有密钥，请打开 Manut AI 查看。",
  "note.question": "{bot} 有个问题",
  "note.error": "{bot} 因出错而停止",
  "note.failed": "这次回复失败了。",
  "note.session.ended": "{name} 会话已结束",
  "note.session.endedBody": "程序已退出。",
  "note.session.failed": "{name} 会话无法启动",
  "note.session.bell": "{name} 会话在等你确认",
  "note.session.bellBody": "它响了终端铃。",
  "note.waiting": "正在等你。",
  "note.watchMany": "{bot}：{n} 条监视提醒",
  "note.atShop": "{shop} 的 {bot}",
};
