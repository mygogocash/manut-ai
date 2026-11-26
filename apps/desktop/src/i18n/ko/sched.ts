import type { sched as en } from "../en/sched";

export const sched: Record<keyof typeof en, string> = {
  "sched.everyMin": "{n}분마다",
  "sched.everyHours": "{n}시간마다",
  "sched.everyDays": "{n}일마다",
  "sched.daily": "매일 {at}",
  "sched.weekdays": "평일 {at}",
  "sched.weekly": "매주 {day} {at}",
  "sched.monthly": "매월 {d}일 {at}",
  "sched.yearly": "매년 {date} {at}",
  "sched.once": "한 번, {date} {at}",
};
