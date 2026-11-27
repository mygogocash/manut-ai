import type { stash as en } from "../en/stash";

export const stash: Record<keyof typeof en, string> = {
  "stash.put": "ホームの上の「下書き」に取っておきました。",
  "stash.failed": "取っておけませんでした · {error}",
  "stash.missing": "次のファイルは一緒に移せませんでした：{names}",
};
