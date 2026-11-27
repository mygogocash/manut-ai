import type { unit as en } from "../en/unit";

export const unit: Record<keyof typeof en, string> = {
  // accounts, usage, update, sidebar, time units (i18n 0.2.5)
  "unit.s": "{n} 秒",
  "unit.m": "{n} 分钟",
  "unit.h": "{n} 小时",
  "unit.d": "{n} 天",
  "unit.ms": "{m} 分 {s} 秒",
  "unit.hm": "{h} 小时 {m} 分",
  "unit.dh": "{d} 天 {h} 小时",
  "unit.lt1m": "不到 1 分钟",
};
