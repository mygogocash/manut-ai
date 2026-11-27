import type { drafts as en } from "../en/drafts";

export const drafts: Record<keyof typeof en, string> = {
  "drafts.title": "草稿",
  "drafts.count": "{n} / {max}",
  "drafts.backTo": "放回 {place}",
  "drafts.move": "移到",
  "drafts.moveOf": "把“{words}”移到",
  "drafts.onlyFiles": "只有文件",
  "drafts.delete": "删除",
  "drafts.deleteOf": "删除草稿“{words}”",
  "drafts.letGo": "草稿最多保留 {max} 条，所以移除了最早的一条：{words}",
  "drafts.undo": "撤销",
  "drafts.home": "主页",
  "drafts.toHome": "主页输入框（新聊天）",
  "drafts.toChat": "{name} 的聊天",
  "drafts.toProject": "{name}（编程聊天）",
  "drafts.file": "1 个文件",
  "drafts.files": "{n} 个文件",
  "drafts.from": "来自 {place}",
};
