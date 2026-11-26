import type { sched as en } from "../en/sched";

export const sched: Record<keyof typeof en, string> = {
  "sched.everyMin": "{n}分ごと",
  "sched.everyHours": "{n}時間ごと",
  "sched.everyDays": "{n}日ごと",
  "sched.daily": "毎日 {at}",
  "sched.weekdays": "平日 {at}",
  "sched.weekly": "毎週{day} {at}",
  "sched.monthly": "毎月{d}日 {at}",
  "sched.yearly": "毎年{date} {at}",
  "sched.once": "1回のみ、{date} {at}",
};
