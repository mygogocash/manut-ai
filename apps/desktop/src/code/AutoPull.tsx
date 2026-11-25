// Settings › Source control › Automatically pull, where it shows: one line in the project's own place on the Code page (Kit's
// panel for that project) saying what the last pull of its default branch did, or why it did nothing. The pull is asked for when
// the page opens the project and when the window is looked at again, at most once every fifteen minutes for a project and never on
// a timer (`lib/sourceControl.ts`), and only while the switch is on. The shell decides whether the checkout may move
// (src-tauri/src/git_pull.rs: clean, on the default branch, a fast-forward only); this file only asks and says.
//
// `AutoPullView` draws a given answer so a test can draw each one; `AutoPull` asks the shell and keeps the last answer of each
// project while the app runs, so going back to a project shows what happened there.
import { useEffect, useSyncExternalStore } from "react";
import { t, type Key } from "../i18n";
import { getHost } from "../sessions/host";
import { lastPull, markPull, pullDue, sourceSettings, useSourceSettings } from "../lib/sourceControl";
import type { Pulled, PullCode } from "./source";

/** The codes that say nothing on the page: the folder is not a repository, or it is a lane's (whose branch is the lane's). */
const QUIET: readonly PullCode[] = ["not_a_repository", "lane"];

/** What the line says for `p`, or null for nothing. */
export function pullLine(p: Pulled): string | null {
  if (QUIET.includes(p.why)) return null;
  const vars = { branch: p.branch || "?", remote: p.remote || "?", n: p.count, from: p.from, to: p.to, setting: p.setting || "?" };
  if (p.why === "pulled") return t(p.count === 1 ? "pull.why.pulledOne" : "pull.why.pulled", vars);
  return t(`pull.why.${p.why}` as Key, vars);
}

export function AutoPullView({ pulled }: { pulled: Pulled | null }) {
  const line = pulled ? pullLine(pulled) : null;
  if (!pulled || !line) return null;
  const moved = pulled.why === "pulled" || pulled.why === "current";
  return (
    <p className={`lline${moved ? " mut" : ""}`} role="status" data-testid="auto-pull" data-why={pulled.why}>
      {line}
    </p>
  );
}

/** The last answer for each project while the app runs. */
const lastByRoot = new Map<string, Pulled>();
const listeners = new Set<() => void>();
let version = 0;
function keep(root: string, p: Pulled): void {
  lastByRoot.set(root, p);
  version++;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Asks for a pull of `root` when the switch is on and one is due; the answer is kept for the project. */
export async function pullIfDue(root: string, now: number): Promise<Pulled | null> {
  const host = getHost();
  if (!root || !host.sourcePull || !sourceSettings().autoPull || !pullDue(now, lastPull(root))) return null;
  markPull(root, now);
  try {
    const got = await host.sourcePull(root);
    if (got) keep(root, got);
    return got;
  } catch {
    return null;
  }
}

/** Tests: forget every answer. */
export function resetAutoPull(): void {
  lastByRoot.clear();
  version++;
}

export function AutoPull({ root }: { root: string }) {
  const on = useSourceSettings().autoPull;
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    if (!root || !on) return;
    const run = () => void pullIfDue(root, Date.now());
    run();
    window.addEventListener("focus", run);
    return () => window.removeEventListener("focus", run);
  }, [root, on]);
  return <AutoPullView pulled={on ? (lastByRoot.get(root) ?? null) : null} />;
}
