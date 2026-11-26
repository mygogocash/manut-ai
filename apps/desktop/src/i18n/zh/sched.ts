import type { sched as en } from "../en/sched";

export const sched: Record<keyof typeof en, string> = {
  "sched.everyMin": "每 {n} 分钟",
  "sched.everyHours": "每 {n} 小时",
  "sched.everyDays": "每 {n} 天",
  "sched.daily": "每天 {at}",
  "sched.weekdays": "工作日 {at}",
  "sched.weekly": "每{day} {at}",
  "sched.monthly": "每月 {d} 日 {at}",
  "sched.yearly": "每年{date} {at}",
  "sched.once": "仅一次，{date} {at}",
};
