// The Customize page's routines on the connected runtime: the shop's schedules, as the runtime already reads them from the
// API (shop.ts), shown as routines and never changed (a schedule is made, paused or resumed with the API's own routes, which
// no session has yet; see host.ts). The API's schedule says when to run and what to ask the team to do, but not what kind of
// work that is or whether it asks first, so a row says `null` for both and the page shows nothing about them.
import { describeTrigger, type Trigger } from "@manut/routine-rules";
import { t } from "../../i18n";
import type { RoutineRow } from "../routines";
import type { ShopSchedule, ShopSnapshot } from "./shop";

const two = (n: number) => String(n).padStart(2, "0");

/** When a schedule runs, as `@manut/routine-rules` writes a trigger. The API counts Sunday as 1 and a routine as 0 (the
 *  package's own `toSchedule` shifts the same way the other direction), and a schedule that names all seven days runs every
 *  day. null when it has no time of day or no day to run on. */
function triggerOf(s: ShopSchedule): Trigger | null {
  if (s.hour === null || s.minute === null || s.weekdays.length === 0) return null;
  const at = `${two(s.hour)}:${two(s.minute)}`;
  const days = [...new Set(s.weekdays.map((d) => d - 1))].sort((a, b) => a - b);
  return days.length === 7 ? { kind: "daily", at } : { kind: "weekly", weekdays: days, at };
}

/** The timing in words, or that it is not known. The package only describes a routine it accepts, so a schedule with no
 *  usable zone is "not known" as well; the stand-in routine built here is never kept, and says nothing about the work. */
function whenOf(s: ShopSchedule): string {
  const trigger = triggerOf(s);
  const words = trigger ? describeTrigger({ id: s.id, name: s.name, action: "draft", timeZone: s.timeZone, trigger, asksFirst: false }) : "";
  return words || t("rt.whenUnknown");
}

/** Every schedule of the shop as a routine, in the order the API sent them. The API's next run is exact, and a schedule that
 *  is switched off has none, whatever the API still names. */
export function shopRoutines(snapshot: ShopSnapshot): RoutineRow[] {
  return snapshot.schedules.map((s) => ({
    id: s.id,
    name: s.name || t("rt.untitled"),
    when: whenOf(s),
    action: null,
    asksFirst: null,
    enabled: s.enabled,
    next: s.enabled && s.nextFire !== null ? s.nextFire / 1000 : null,
    timeZone: s.timeZone,
  }));
}
