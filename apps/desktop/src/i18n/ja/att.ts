import type { att as en } from "../en/att";

export const att: Record<keyof typeof en, string> = {
  "att.attach": "添付",
  "att.addFiles": "写真とファイルを追加",
  "att.plugins": "スキルとツール",
  "att.pluginsLoading": "プラグインを読み込み中…",
  "att.pluginsManage": "プラグインを管理",
  "att.pluginsNone": "プラグインはまだありません · 追加",
  "att.usePlugin": "{plugin} を使って: ",
  "att.removeOf": "{name} を外す",
  "att.drop": "ドロップして添付",
  "att.tooMany": "{n} 個を超えています",
  "att.tooBig": "100 MB を超えています",
  "att.failed": "{name} を添付できませんでした · {error}",
  "att.readFailed": "ファイルを読み込めませんでした",
};
