// Computer use on the page (item 82, docs/computer-use.md): what Settings › Computer reads from the shell
// (src-tauri/src/computer/mod.rs) and the two panes of System Settings it opens, behind one interface so the tests use a
// stand-in. The shell reads both permissions without asking for either, and opening a pane grants nothing.
//
// In a plain browser (dev, e2e) with `window.__manutComputerMock` set, a stand-in answers with the status in
// `window.__manutComputer` and records each pane it was asked to open; without it the page says computer use is on the
// Mac only, as it does on Windows and Linux.
import { isMacPlatform } from "../lib/power";
import type { Key } from "../i18n";
import type { ComputerAsk } from "../lib/protocol";

export type { ComputerAsk };

/** Where things stand, as the shell read it. */
export interface ComputerStatus {
  /** macOS lets Manut AI use accessibility: read windows' text and controls, and act in them. */
  accessibility: boolean;
  /** macOS lets Manut AI capture the screen: pictures of windows. */
  screen: boolean;
  /** This copy is signed with a Developer ID, so macOS keeps both permissions across updates. */
  signed: boolean;
}

/** A pane of System Settings › Privacy & Security the page may open, by name: the shell holds the addresses. */
export type Pane = "accessibility" | "screen";

export interface ComputerShell {
  status(): Promise<ComputerStatus>;
  open(pane: Pane): Promise<void>;
}

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
type MockGlobals = { __manutComputerMock?: boolean; __manutComputer?: ComputerMock };
const mockOn = () => typeof window !== "undefined" && !!(window as unknown as MockGlobals).__manutComputerMock;

/** Computer use is offered in the Mac app, and in a browser test that asks for the stand-in. */
export const computerOffered = (): boolean => (inTauri() && isMacPlatform()) || mockOn();

/** The shell's two commands. */
export function tauriComputer(): ComputerShell {
  return {
    async status() {
      const { invoke } = await import("@tauri-apps/api/core");
      const s = await invoke<ComputerStatus & { mac: boolean }>("computer_status");
      return { accessibility: s.accessibility, screen: s.screen, signed: s.signed };
    },
    async open(pane) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("computer_open", { pane });
    },
  };
}

/** The browser stand-in's state and record (e2e). */
export interface ComputerMock {
  status: ComputerStatus;
  opened: Pane[];
}

function mockShell(): ComputerShell {
  const g = window as unknown as MockGlobals;
  const m: ComputerMock = (g.__manutComputer ??= { status: { accessibility: false, screen: false, signed: false }, opened: [] });
  return {
    async status() {
      return { ...m.status };
    },
    async open(pane) {
      m.opened.push(pane);
    },
  };
}

let shell: ComputerShell | null = null;
/** The shell this page uses, made once. */
export function getComputerShell(): ComputerShell {
  shell ??= mockOn() && !inTauri() ? mockShell() : tauriComputer();
  return shell;
}

/** The page's one status line: ready when both are on, else what is still missing. Looking at windows needs only
 *  Accessibility; pictures of them need Screen capture too. */
export function statusLine(s: ComputerStatus): Key {
  if (s.accessibility && s.screen) return "computer.ready";
  if (s.accessibility) return "computer.needScreen";
  if (s.screen) return "computer.needAccessibility";
  return "computer.needBoth";
}

/** What a computer use card can be about: a first look at an app, or one of the four actions. */
const ACTS: readonly ComputerAsk["act"][] = ["look", "click", "set", "key", "menu"];

/** Invisible format characters (Unicode's general category Cf: bidi overrides and isolates, zero-width spaces). The
 *  shell takes them out of what an app says and refuses text to type that holds any (room.rs `clean`); the page takes
 *  them out again, so a card can never read otherwise than what it names. */
const FORMAT = /\p{Cf}/gu;
const clean = (t: string) => t.replace(FORMAT, "");

/** The largest picture of a control a card draws (base64 of the shell's 256 KB cap), and the shape of base64. */
const PICTURE_CHARS = 350_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** `v` as a computer use card's fields, or null when it is not one this page can draw whole. */
export function computerAsk(v: unknown): ComputerAsk | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" ? clean(x) : undefined);
  if (!ACTS.includes(c.act as ComputerAsk["act"]) || typeof c.app !== "string" || !clean(c.app)) return null;
  const menu = Array.isArray(c.menu) && c.menu.every((m) => typeof m === "string") ? (c.menu as string[]).map(clean) : undefined;
  if (c.menu !== undefined && !menu) return null;
  for (const k of ["window", "control", "text", "keys"]) if (c[k] !== undefined && text(c[k]) === undefined) return null;
  // a picture that is not a small base64 PNG is left out: the card is whole without it
  const picture = typeof c.picture === "string" && c.picture.length <= PICTURE_CHARS && BASE64.test(c.picture) ? c.picture : undefined;
  return {
    act: c.act as ComputerAsk["act"],
    app: clean(c.app),
    ...(text(c.window) !== undefined ? { window: text(c.window) } : {}),
    ...(text(c.control) !== undefined ? { control: text(c.control) } : {}),
    ...(text(c.text) !== undefined ? { text: text(c.text) } : {}),
    ...(text(c.keys) !== undefined ? { keys: text(c.keys) } : {}),
    ...(menu ? { menu } : {}),
    ...(picture ? { picture } : {}),
  };
}
