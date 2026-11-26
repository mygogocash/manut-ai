import type { find as en } from "../en/find";

export const find: Record<keyof typeof en, string> = {
  "find.label": "在终端中查找",
  "find.placeholder": "查找",
  "find.count": "{n} / {total}",
  "find.countMore": "{n} / {total}+",
  "find.none": "无匹配",
  "find.prev": "上一个匹配",
  "find.next": "下一个匹配",
  "find.close": "关闭查找",
  "find.matchCase": "区分大小写",
  "find.matchCaseTip": "区分大小写 (Alt+C)",
  "find.regex": "正则表达式",
  "find.regexTip": "正则表达式 (Alt+R)",
  "find.badRegex": "无效的模式",
};
