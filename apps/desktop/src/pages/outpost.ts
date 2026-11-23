// Customize › Connections: what the Outposts box says about this Mac and what its one button does (OutpostPane.tsx
// draws it). The canvas's row reads "This Mac. Running 2 jobs. Online"; this Mac holds browser steps, not jobs, so the
// row counts steps. The words come from where the outpost stands (the shell's view, src/runtime/http/outpost.ts) and
// from whether anyone is signed in to a shop at all; nothing here is a guess about the API.
import { t, type Key } from "../i18n";
import type { OutpostView, Registered } from "../runtime/http/outpost";

/** Where the page stands before the shell is asked: Practice (or a test bridge), Connected with nobody signed in, or
 *  signed in to a shop, with what the shell said (null until it has). */
export type OutpostContext = { kind: "practice" } | { kind: "signed_out" } | { kind: "signed_in"; view: OutpostView | null };

export type OutpostAction = "register" | "stop" | "start";

export interface OutpostRow {
  /** the line under "This Mac" ("" while the shell has not answered) */
  line: string;
  /** Online, Asleep, or no tag */
  tag: "online" | "asleep" | null;
  /** the row's one button */
  action: OutpostAction | null;
}

/** "Running 2 steps", "Running 1 step", or "Waiting for work". */
export function stepsLine(steps: number): string {
  if (steps <= 0) return t("outpost.waiting");
  return steps === 1 ? t("outpost.running1") : t("outpost.running", { n: steps });
}

export function outpostRow(context: OutpostContext): OutpostRow {
  if (context.kind === "practice") return { line: t("outpost.practice"), tag: null, action: null };
  if (context.kind === "signed_out") return { line: t("outpost.signedOut"), tag: null, action: null };
  const view = context.view;
  if (!view) return { line: "", tag: null, action: null };
  switch (view.state) {
    case "unavailable":
      return { line: t("outpost.unavailable"), tag: null, action: null };
    case "unregistered":
      return { line: t("outpost.notSetUp"), tag: null, action: "register" };
    case "refused":
      return { line: t("outpost.refused"), tag: "asleep", action: "register" };
    case "stopped":
      return { line: t("outpost.stopped"), tag: "asleep", action: "start" };
    case "idle":
      return { line: t("outpost.notRunning"), tag: "asleep", action: "start" };
    case "running":
      return { line: stepsLine(view.steps), tag: view.online ? "online" : "asleep", action: "stop" };
  }
}

const REGISTER_ERRORS: Record<Exclude<Registered, "registered">, Key> = {
  owner_only: "outpost.err.ownerOnly",
  too_many: "outpost.err.tooMany",
  signed_out: "outpost.err.signedOut",
  offline: "outpost.err.offline",
  keychain: "outpost.err.keychain",
  failed: "outpost.err.failed",
};

/** What the page says after a registration: nothing when it worked, else why it did not. */
export function registeredError(result: Registered): string | null {
  return result === "registered" ? null : t(REGISTER_ERRORS[result]);
}

/** The words on the row's button. */
export function actionLabel(action: OutpostAction, busy: boolean): string {
  if (action === "register") return busy ? t("outpost.registering") : t("outpost.register");
  return action === "stop" ? t("outpost.stop") : t("outpost.start");
}
