import type { find as en } from "../en/find";

export const find: Record<keyof typeof en, string> = {
  "find.label": "터미널에서 찾기",
  "find.placeholder": "찾기",
  "find.count": "{n} / {total}",
  "find.countMore": "{n} / {total}+",
  "find.none": "결과 없음",
  "find.prev": "이전 결과",
  "find.next": "다음 결과",
  "find.close": "찾기 닫기",
  "find.matchCase": "대소문자 구분",
  "find.matchCaseTip": "대소문자 구분 (Alt+C)",
  "find.regex": "정규식",
  "find.regexTip": "정규식 (Alt+R)",
  "find.badRegex": "잘못된 패턴",
};
