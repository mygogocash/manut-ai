import type { time as en } from "../en/time";

export const time: Record<keyof typeof en, string> = {
  // time words for the pages
  "time.now": "现在",
  "time.inMin": "{n} 分钟后",
  "time.inHours": "{n} 小时后",
  "time.inDays": "{n} 天后",
  "time.tomorrow": "明天 {at}",
  "time.today": "今天 {at}",
  "time.nowShort": "刚刚",
  "time.todayDay": "今天",
  "time.yesterday": "昨天",
};
