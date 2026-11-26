import type { time as en } from "../en/time";

export const time: Record<keyof typeof en, string> = {
  // time words for the pages
  "time.now": "지금",
  "time.inMin": "{n}분 뒤",
  "time.inHours": "{n}시간 뒤",
  "time.inDays": "{n}일 뒤",
  "time.tomorrow": "내일 {at}",
  "time.today": "오늘 {at}",
  "time.nowShort": "방금",
  "time.todayDay": "오늘",
  "time.yesterday": "어제",
};
