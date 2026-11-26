import type { zone as en } from "../en/zone";

export const zone: Record<keyof typeof en, string> = {
  // A time that is on another zone's clock than this computer's (src/lib/zone.ts)
  "zone.city": "{place}时间",
  "zone.with": "{words}（{zone}）",
};
