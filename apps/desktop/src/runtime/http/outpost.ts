// This Mac as one of the shop's outposts, as the page sees it (src-tauri/src/outpost/, docs/browser-control.md). The shell
// runs the outpost: its heartbeat, its steps, its browser and every call they make, with a credential the page never
// holds. The page only tells the shell who is signed in, registers this Mac through its own session, presses Start and
// Stop, and reads where the outpost stands.
//
// Registering is the one request whose answer the page must not see: it holds the outpost's credential. So the session
// sends it (refreshing first, and once more after a 401, as for every write), but through the shell's own command
// rather than `api_request`: the shell keeps the credential in the keychain and hands back the status, the shop and the
// outpost's name, or a refusal's code. Nothing the page can call ever returns the credential.
import { LinkDown, type FetchLike } from "./shell";
import type { ApiSession } from "./session";

/** Where this Mac's outpost stands for the shop the page is signed in to (the shell's `View`):
 *  - `unavailable`: this computer keeps no keychain item (only macOS does), or its keychain said no;
 *  - `unregistered`: this Mac is not that shop's outpost;
 *  - `running`, or `stopped` by the owner;
 *  - `refused`: the API no longer takes its credential (an operator removed it, or gave it a new one);
 *  - `idle`: registered, but not running. */
export type OutpostState = "unavailable" | "unregistered" | "running" | "stopped" | "refused" | "idle";

export interface OutpostView {
  state: OutpostState;
  /** online as the API counts it: running, with a heartbeat in the last 90 seconds */
  online: boolean;
  /** how many browser steps it holds: handed out, and not yet reported */
  steps: number;
  name: string | null;
}

export const UNAVAILABLE: OutpostView = { state: "unavailable", online: false, steps: 0, name: null };

const STATES: readonly OutpostState[] = ["unavailable", "unregistered", "running", "stopped", "refused", "idle"];

/** The shell's answer as a view; anything this build does not read as one is `unavailable`, never a guess. */
export function decodeView(value: unknown): OutpostView {
  const v = value as Partial<Record<keyof OutpostView, unknown>> | null;
  if (!v || typeof v !== "object" || !STATES.includes(v.state as OutpostState)) return UNAVAILABLE;
  const steps = typeof v.steps === "number" && Number.isInteger(v.steps) && v.steps >= 0 ? v.steps : 0;
  const name = typeof v.name === "string" && v.name.trim() ? v.name : null;
  return { state: v.state as OutpostState, online: v.online === true, steps, name };
}

/** What the page asks of the shell about the outpost. */
export interface OutpostShell {
  status(origin: string, tenant: string): Promise<OutpostView>;
  /** someone is signed in to `tenant` at `origin`: the outpost runs if this Mac is that shop's and is not stopped */
  signedIn(origin: string, tenant: string, title: string): Promise<OutpostView>;
  /** nobody is: the outpost stops and its window closes */
  signedOut(): Promise<void>;
  /** the owner's Start (`on`) and Stop */
  run(origin: string, tenant: string, on: boolean): Promise<OutpostView>;
  /** The `fetch` a registration is sent through: the shell's own command, which keeps the answer's credential.
   *  `refused` hears why the shell itself said no (its keychain, or no keychain here), which a session's answer cannot say. */
  registerFetch(refused: (why: "keychain" | "unavailable") => void): FetchLike;
}

const inShell = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inShell()) throw new Error("unavailable");
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

function bearerOf(headers: Record<string, string>): string {
  const value = headers.authorization ?? headers.Authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
}

/** The outpost through the desktop shell's commands. Outside the desktop app there is no outpost: every view is
 *  `unavailable`, and nothing is started or stopped. */
export function shellOutpost(): OutpostShell {
  const view = async (cmd: string, args: Record<string, unknown>) => {
    try {
      return decodeView(await invoke<unknown>(cmd, args));
    } catch {
      return UNAVAILABLE;
    }
  };
  return {
    status: (origin, tenant) => view("outpost_status", { origin, tenant }),
    signedIn: (origin, tenant, title) => view("outpost_signed_in", { origin, tenant, title }),
    signedOut: async () => {
      await invoke<void>("outpost_signed_out").catch(() => undefined);
    },
    run: async (origin, tenant, on) => decodeView(await invoke<unknown>("outpost_run", { origin, tenant, on })),
    registerFetch: (refused) => async (url, init) => {
      if (!inShell()) {
        refused("unavailable");
        throw new LinkDown("unsupported");
      }
      let answer: { status: number; body: string };
      try {
        answer = await invoke("outpost_register", { url, bearer: bearerOf(init.headers), body: init.body ?? "" });
      } catch (e) {
        if (e === "keychain" || e === "unavailable") refused(e);
        throw new LinkDown(e === "offline" ? "offline" : "failed");
      }
      return { status: answer.status, text: async () => answer.body };
    },
  };
}

/** How registering this Mac went, as the Connections page says it. */
export type Registered =
  | "registered"
  /** a helper's session: only the shop's owner adds an outpost */
  | "owner_only"
  /** the shop already has the 20 outposts it may */
  | "too_many"
  | "signed_out"
  | "offline"
  /** registered on the API, but this Mac could not keep its credential (the keychain said no, or there is none) */
  | "keychain"
  | "failed";

/** Registers this Mac as one of the shop's outposts, named `name`, through `session`. The shell keeps the credential
 *  and starts the outpost; the page learns only how it went. */
export async function registerThisMac(session: ApiSession, shell: OutpostShell, name: string): Promise<Registered> {
  const shellSaid: { why: "keychain" | "unavailable" | null } = { why: null };
  const through = shell.registerFetch((why) => {
    shellSaid.why = why;
  });
  const answer = await session.writeVia("/v1/outposts/register", { name, kind: "this_mac" }, through);
  switch (answer.kind) {
    case "ok":
      return "registered";
    case "signed_out":
      return "signed_out";
    case "offline":
      return "offline";
    case "refused":
      if (answer.code === "owner_only") return "owner_only";
      if (answer.code === "too_many_outposts") return "too_many";
      if (answer.code === "unlinked" || answer.code === "unauthorized") return "signed_out";
      return "failed";
    default:
      return shellSaid.why !== null ? "keychain" : "failed";
  }
}

/** A session's `onEnd` that also stops this Mac's outpost. A sign-out calls it before it waits on the API to end the
 *  session (which can take as long as the API takes to answer), so the outpost stops as the person signs out, not after;
 *  `also` is what the session forgot at its end before (the saved read of the shop). */
export function stopOnEnd(shell: OutpostShell, also: () => unknown): () => Promise<unknown> {
  return () => Promise.all([also(), shell.signedOut()]);
}

/** The outpost follows `session`: while it is signed in to a shop the shell is told who, so this Mac's outpost runs if
 *  it is that shop's; when it signs out, or the API ends it, the outpost stops. `title` is the outpost's window title in
 *  the page's language, read each time it is sent. Answers how to stop following. */
export function followSignIn(session: ApiSession, shell: OutpostShell, title: () => string): () => void {
  return session.subscribe((state) => {
    if (state.kind === "signed_in") void shell.signedIn(session.origin, state.tenant, title()).catch(() => undefined);
    else if (state.kind === "signed_out" || state.kind === "no_keychain") void shell.signedOut().catch(() => undefined);
  });
}
