// Settings › Workflows' two choices (item 77b), saved on this computer like the other Settings choices (`lib/worktrees.ts`):
//
// - Workflows: default OFF. A workflow starts coding work by itself, on the person's own agent and plan, so it is the person's to
//   turn on, as T3 Code keeps it under Labs. While off, nothing in the folder runs and nothing is scheduled.
// - Skipped runs kept: how many skipped runs each workflow keeps in its history, 0 to 500, default 50. T3 Code's default is 500
//   for webhook deliveries a workflow ignores; a workflow here skips a time only when the app was closed or the Mac asleep, which
//   50 covers for weeks of a daily one.
import { useSyncExternalStore } from "react";
import { changes } from "../lib/changes";

export interface WorkflowSettings {
  on: boolean;
  skippedKept: number;
}

export const SKIPPED_KEPT_MAX = 500;
export const WORKFLOW_DEFAULTS: WorkflowSettings = { on: false, skippedKept: 50 };

const KEY = "manut.workflows";

function read(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Whether `n` is a number of skipped runs the page takes: a whole number from 0 to 500. */
export const keptOk = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= SKIPPED_KEPT_MAX;

/** The saved choices; a value that is not usable is the default (off, for the switch: a damaged setting never turns it on). */
export function parseWorkflowSettings(text: string | null): WorkflowSettings {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = text ? JSON.parse(text) : {};
    if (v && typeof v === "object") o = v as Record<string, unknown>;
  } catch {
    /* damaged: the defaults */
  }
  return { on: o.on === true, skippedKept: keptOk(o.skippedKept) ? o.skippedKept : WORKFLOW_DEFAULTS.skippedKept };
}

const listeners = changes();
let cache: { text: string | null; value: WorkflowSettings } | null = null;

export function workflowSettings(): WorkflowSettings {
  const text = read();
  if (!cache || cache.text !== text) cache = { text, value: parseWorkflowSettings(text) };
  return cache.value;
}

/** Saves the choices in `patch`; a number of skipped runs the page would refuse is not saved. */
export function setWorkflowSettings(patch: Partial<WorkflowSettings>): void {
  const next = { ...workflowSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(parseWorkflowSettings(JSON.stringify(next))));
  } catch {
    /* no storage: the choice holds for nothing, and the switch reads off */
  }
  listeners.emit();
}

export function onWorkflowSettings(l: () => void): () => void {
  return listeners.subscribe(l);
}

export function useWorkflowSettings(): WorkflowSettings {
  return useSyncExternalStore(onWorkflowSettings, workflowSettings, workflowSettings);
}
