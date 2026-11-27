import type { diff as en } from "../en/diff";

export const diff: Record<keyof typeof en, string> = {
  "diff.new": "新規",
  "diff.deleted": "削除",
  "diff.more": "あと{n}行",
  "diff.renamed": "{from} から名前を変更",
  "diff.binary": "バイナリファイルのため、表示する行はありません。",
  "diff.tooLarge": "大きすぎて表示できません。",
  "diff.leftOut": "表示していません。この一覧がすでに長いためです。",
};
