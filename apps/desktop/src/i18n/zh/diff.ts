import type { diff as en } from "../en/diff";

export const diff: Record<keyof typeof en, string> = {
  "diff.new": "新文件",
  "diff.deleted": "已删除",
  "diff.more": "还有 {n} 行",
  "diff.renamed": "由 {from} 重命名",
  "diff.binary": "二进制文件，没有可显示的行。",
  "diff.tooLarge": "太大，无法显示。",
  "diff.leftOut": "未显示：这个列表已经很长了。",
};
