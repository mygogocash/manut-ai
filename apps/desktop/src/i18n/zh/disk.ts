import type { disk as en } from "../en/disk";

export const disk: Record<keyof typeof en, string> = {
  "disk.gb": "{n} GB",
  "disk.noteLow": "磁盘空间不足：剩余 {free}",
  "disk.noteCritical": "磁盘空间几乎用尽：剩余 {free}",
  "disk.noteBody": "请在构建和智能体开始失败之前清理 {volume} 上的空间。",
  "disk.chip": "剩余 {free}",
  "disk.chipTitle": "{volume} 上的磁盘空间所剩无几。打开设置",
  "disk.setting": "磁盘空间低于此值时提醒",
  "disk.settingHint": "Manut AI 每分钟检查一次主文件夹所在的磁盘，不会删除任何内容。",
};
