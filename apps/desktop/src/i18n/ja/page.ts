import type { page as en } from "../en/page";

export const page: Record<keyof typeof en, string> = {
  // shared words of both pages
  "page.cancel": "キャンセル",
  "page.close": "閉じる",
  "page.back": "戻る",
  "page.offline": "{bot} はオフラインです。戻ってからもう一度お試しください。",
  "page.failed": "実行できませんでした: {error}",
  "page.on": "オン",
  "page.off": "オフ",
  "page.more": "{name} のその他の操作",
};
