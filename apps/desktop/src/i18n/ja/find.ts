import type { find as en } from "../en/find";

export const find: Record<keyof typeof en, string> = {
  "find.label": "ターミナル内を検索",
  "find.chatLabel": "Find in this chat",
  "find.placeholder": "検索",
  "find.count": "{n} / {total}",
  "find.countMore": "{n} / {total}+",
  "find.none": "一致なし",
  "find.prev": "前の一致",
  "find.next": "次の一致",
  "find.close": "検索を閉じる",
  "find.matchCase": "大文字と小文字を区別",
  "find.matchCaseTip": "大文字と小文字を区別 (Alt+C)",
  "find.regex": "正規表現",
  "find.regexTip": "正規表現 (Alt+R)",
  "find.badRegex": "無効なパターン",
};
