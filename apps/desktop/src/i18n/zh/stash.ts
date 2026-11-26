import type { stash as en } from "../en/stash";

export const stash: Record<keyof typeof en, string> = {
  "stash.put": "已放到主页顶部的草稿里。",
  "stash.failed": "未能放到草稿 · {error}",
  "stash.missing": "这些文件没能一起带过来：{names}",
};
