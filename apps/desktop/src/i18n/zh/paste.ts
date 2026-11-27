import type { paste as en } from "../en/paste";

export const paste: Record<keyof typeof en, string> = {
  "paste.label": "确认粘贴",
  "paste.title": "粘贴 {n} 行?",
  "paste.titleOne": "粘贴以换行结尾的文本?",
  "paste.hint": "每一行到达提示符时都会作为命令运行。",
  "paste.more": "还有 {n} 行",
  "paste.ok": "粘贴",
  "paste.cancel": "取消",
};
