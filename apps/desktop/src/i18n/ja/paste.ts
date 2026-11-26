import type { paste as en } from "../en/paste";

export const paste: Record<keyof typeof en, string> = {
  "paste.label": "貼り付けの確認",
  "paste.title": "{n}行を貼り付けますか?",
  "paste.titleOne": "改行で終わるテキストを貼り付けますか?",
  "paste.hint": "プロンプトに届くと各行がコマンドとして実行されます。",
  "paste.more": "ほか{n}行",
  "paste.ok": "貼り付け",
  "paste.cancel": "キャンセル",
};
