// When a page's rows and body arrive, decided once (item 85c, docs/motion.md "Lists and pages"). The Motion board's Rise
// is for something that ARRIVES, so it plays the first time a page shows its content in a session and never again: not
// on a re-render, a refetch, a filter, a sort, a row added later, or coming back to the page.
//
// Pages name what arrives in their markup, with attributes and no hook (the tests read a page's element tree without
// React, and a view stays a plain function of its props):
//   data-arrive="<key>"      a container whose rows rise; `<key>` is spent for the session once its rows have shown
//   data-arrive-rows="<css>" which descendants are the rows (a selector relative to the container)
//   data-arrive-body="<key>" a page's body, which fades in once (the page's header stays still)
//   data-flip-list           a container whose `data-flip="<key>"` children slide when they are reordered
//   data-flip-scope="<s>"    a change of scope (a filter, a search) is another list, not a row moving: no slide
// One driver (`startMotionDriver`, called once from main.tsx) watches the document and does the rest.
import { moved } from "./flip";

/** How long a page counts as arriving: the last of Rise's four steps (0.5 s and 4 x 50 ms) with a little to spare. */
export const ARRIVING_MS = 800;

const spent = new Set<string>();

/** This page's rows have arrived in this session already. */
export const hasArrived = (key: string): boolean => spent.has(key);
/** Spends the key: the page has shown its content once. */
export const markArrived = (key: string): void => void spent.add(key);
/** For tests: a fresh session. */
export const resetArrived = (): void => spent.clear();

/** Each row's step: its place among the rows that share its parent, so the stagger runs per list and Home's three parts
 *  each start from the first step. The CSS caps it at four. */
export function stepsOf<P>(parents: readonly P[]): number[] {
  const seen = new Map<P, number>();
  return parents.map((p) => {
    const n = seen.get(p) ?? 0;
    seen.set(p, n + 1);
    return n;
  });
}

const done = new WeakSet<Element>();
const lists = new WeakMap<Element, { keys: string; tops: Map<string, number>; scope: string; width: number }>();

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function arrive(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-arrive-body]")) {
    if (done.has(el)) continue;
    done.add(el);
    const key = `body:${el.dataset.arriveBody}`;
    if (hasArrived(key)) continue;
    markArrived(key);
    el.classList.add("arriving");
    setTimeout(() => el.classList.remove("arriving"), ARRIVING_MS);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-arrive]")) {
    if (done.has(el)) continue;
    const rows = [...el.querySelectorAll<HTMLElement>(el.dataset.arriveRows || ":scope > li")];
    // A page with nothing to show yet is looked at again when its rows come.
    if (rows.length === 0) continue;
    done.add(el);
    const key = el.dataset.arrive!;
    if (hasArrived(key)) continue;
    markArrived(key);
    const steps = stepsOf(rows.map((r) => r.parentElement));
    rows.forEach((r, i) => {
      r.style.setProperty("--i", String(steps[i]));
      r.classList.add("mo-rise");
    });
    setTimeout(
      () =>
        rows.forEach((r) => {
          r.classList.remove("mo-rise");
          r.style.removeProperty("--i");
        }),
      ARRIVING_MS,
    );
  }
}

const token = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const ms = (v: string) => (v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000) || 250;

function flip(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-flip-list]")) {
    const base = el.getBoundingClientRect().top;
    const nodes = new Map<string, HTMLElement>();
    const tops = new Map<string, number>();
    for (const c of el.querySelectorAll<HTMLElement>("[data-flip]")) {
      const k = c.dataset.flip!;
      nodes.set(k, c);
      tops.set(k, c.getBoundingClientRect().top - base);
    }
    const keys = [...tops.keys()].join("\u0000");
    const scope = el.dataset.flipScope ?? "";
    const was = lists.get(el);
    lists.set(el, { keys, tops, scope, width: innerWidth });
    // A new scope is another list; a different window width reflowed everything; reduced motion slides nothing.
    if (!was || was.keys === keys || was.scope !== scope || was.width !== innerWidth || reduced()) continue;
    // The plain ease and the Switch's time, from the stylesheet's own tokens: a layout that overshoots reflows twice.
    const duration = ms(token("--move-switch", "0.25s"));
    const easing = token("--ease-plain", "ease-out");
    for (const [k, dy] of moved(was.tops, tops)) nodes.get(k)?.animate?.([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration, easing });
  }
}

let started = false;
/** Watches the document for pages that name their moves, once. Returns a stop for tests. */
export function startMotionDriver(): () => void {
  if (started || typeof MutationObserver === "undefined") return () => {};
  started = true;
  let queued = false;
  const run = () => {
    queued = false;
    arrive();
    flip();
  };
  const watch = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(run);
  });
  watch.observe(document.body, { childList: true, subtree: true });
  run();
  return () => {
    watch.disconnect();
    started = false;
  };
}
