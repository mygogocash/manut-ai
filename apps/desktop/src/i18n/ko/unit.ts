import type { unit as en } from "../en/unit";

export const unit: Record<keyof typeof en, string> = {
  // accounts, usage, update, sidebar, time units (i18n 0.2.5)
  "unit.s": "{n}초",
  "unit.m": "{n}분",
  "unit.h": "{n}시간",
  "unit.d": "{n}일",
  "unit.ms": "{m}분 {s}초",
  "unit.hm": "{h}시간 {m}분",
  "unit.dh": "{d}일 {h}시간",
  "unit.lt1m": "1분 미만",
};
