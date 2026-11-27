import type { unit as en } from "../en/unit";

export const unit: Record<keyof typeof en, string> = {
  // accounts, usage, update, sidebar, time units (i18n 0.2.5)
  "unit.s": "{n}秒",
  "unit.m": "{n}分",
  "unit.h": "{n}時間",
  "unit.d": "{n}日",
  "unit.ms": "{m}分{s}秒",
  "unit.hm": "{h}時間{m}分",
  "unit.dh": "{d}日{h}時間",
  "unit.lt1m": "1分未満",
};
