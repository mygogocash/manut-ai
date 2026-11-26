import type { time as en } from "../en/time";

export const time: Record<keyof typeof en, string> = {
  // time words for the pages
  "time.now": "今",
  "time.inMin": "{n} 分後",
  "time.inHours": "{n} 時間後",
  "time.inDays": "{n} 日後",
  "time.tomorrow": "明日 {at}",
  "time.today": "今日 {at}",
  "time.nowShort": "今",
  "time.todayDay": "今日",
  "time.yesterday": "昨日",
};
