// Which edition of Manut AI this page belongs to. The Mac App Store edition (docs/app-store.md) is built with
// MANUT_APP_STORE=1, the one flag both halves read at build time: vite.config.ts turns it into `__MANUT_APP_STORE__`
// here, and the shell's build.rs into `cfg(app_store)`. That edition never updates itself and never offers to install a
// program, because the App Store refuses an app that does (Guideline 2.4.5), so it says so where a person would look.

declare const __MANUT_APP_STORE__: boolean | undefined;

const BUILT_FOR_STORE = typeof __MANUT_APP_STORE__ === "boolean" && __MANUT_APP_STORE__;

/**
 * Whether this is the App Store edition. `globalThis.__manutAppStore = true` is e2e's stand-in, so the edition's words
 * can be seen without building it; it can only turn the edition on, so nothing at run time turns the updater back on.
 */
export function isAppStore(): boolean {
  if (BUILT_FOR_STORE) return true;
  return (globalThis as { __manutAppStore?: unknown }).__manutAppStore === true;
}

/** What the shell answers when the App Store edition's sandbox refused a terminal (app_store.rs `TERMINAL_REFUSED`). */
export const TERMINAL_REFUSED = "why:sandbox_terminal";

/** A start error in the person's words: the sandbox's refusal of a terminal is said plainly, anything else as it came. */
export function sandboxSaid(error: string, say: (key: "ss.sandboxTerminal") => string): string {
  return error === TERMINAL_REFUSED ? say("ss.sandboxTerminal") : error;
}
