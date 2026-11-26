// Settings › General › Titles and words (item 96): whether a coding agent of the person's own writes a chat's title and a pull
// request's words, and with which model.
//
// It is OFF unless the person turns it on. Each title is a separate run of their own Claude Code, counted in their own plan's usage
// (src-tauri/src/title_run.rs: no tools, no project, the person's own settings only, one run at a time, a time limit, a few a
// minute). Only Claude Code can do it for now, because only its `--help` was checked for the three switches such a run needs; the
// setting says so. A title it writes never replaces a name the person gave (sessions/titles.ts), and nothing is written to a
// pull request until the person has read it and pressed the button of the ask (code/Review.tsx).
import { useSyncExternalStore } from "react";

export const TITLE_MODEL_KEY = "manut.titleModel";

/** The agents that may write titles (the shell refuses any other). */
export const TITLE_AGENTS: readonly string[] = ["claude"];

/** Claude Code's own model aliases, which `--model` takes as they are, and the efforts a title needs at most. "" is its own default. */
export const TITLE_MODELS = ["", "haiku", "sonnet", "opus"] as const;
export const TITLE_EFFORTS = ["", "low", "medium", "high"] as const;

export interface TitleModel {
  on: boolean;
  /** "" for Claude Code's own default. */
  model: (typeof TITLE_MODELS)[number];
  effort: (typeof TITLE_EFFORTS)[number];
}

export const TITLE_MODEL_DEFAULTS: TitleModel = { on: false, model: "", effort: "" };

/** The saved setting; a value that is not usable is the default. Off for anything but a boolean true. */
export function parseTitleModel(text: string | null): TitleModel {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = text ? JSON.parse(text) : {};
    if (v && typeof v === "object") o = v as Record<string, unknown>;
  } catch {
    /* damaged: the defaults */
  }
  return {
    on: o.on === true,
    model: TITLE_MODELS.find((m) => m === o.model) ?? "",
    effort: TITLE_EFFORTS.find((e) => e === o.effort) ?? "",
  };
}

function read(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(TITLE_MODEL_KEY);
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let cache: { text: string | null; value: TitleModel } | null = null;

export function titleModel(): TitleModel {
  const text = read();
  if (!cache || cache.text !== text) cache = { text, value: parseTitleModel(text) };
  return cache.value;
}

export function setTitleModel(patch: Partial<TitleModel>): void {
  try {
    localStorage.setItem(TITLE_MODEL_KEY, JSON.stringify(parseTitleModel(JSON.stringify({ ...titleModel(), ...patch }))));
  } catch {
    /* no storage: nothing is kept, so it stays off */
  }
  listeners.forEach((l) => l());
}

export function useTitleModel(): TitleModel {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    titleModel,
    titleModel,
  );
}

/** Whether a chat with `agent` may have its title written by the model right now: the switch is on and the agent can. */
export const titlesFor = (agent: string, s: TitleModel = titleModel()): boolean => s.on && TITLE_AGENTS.includes(agent);
