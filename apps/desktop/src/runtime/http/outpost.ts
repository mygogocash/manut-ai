// This Mac as one of the shop's outposts, as the page sees it (src-tauri/src/outpost/, docs/browser-control.md). The shell
// runs the outpost: its heartbeat, its steps, its browser and every call they make, with a credential the page never
// holds. The page only tells the shell which shops the person acts for as owner (the one the sign-in is for, and each one
// whose owner session it holds), registers this Mac through a session, presses Start and Stop, and reads where the
// outpost stands. It never learns which shop the keychain's item is for: the shell, which alone reads it, decides.
//
// Registering is the one request whose answer the page must not see: it holds the outpost's credential. So the session
// sends it (refreshing first, and once more after a 401, as for every write), but through the shell's own command
// rather than `api_request`: the shell keeps the credential in the keychain and hands back the status, the shop and the
// outpost's name, or a refusal's code. Nothing the page can call ever returns the credential. Which session sends it is
// the shop the page shows: that shop's own owner session (shops.ts), or the sign-in while the person is in no shops, so a
// pilot shop the operator made, which no sign-in carries, can have this Mac as its outpost (docs/several-shops.md).
import { OpError } from "../mock/host";
import type { OwnerLink } from "./connections";
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
  /** Someone is signed in at `origin` and acts as owner for `tenants`: the outpost runs if this Mac is one of those
   *  shops' and is not stopped, and stops if it no longer is. Rejects when the shell did not take it. */
  signedIn(origin: string, tenants: readonly string[], title: string): Promise<void>;
  /** nobody is: the outpost stops and its window closes. Rejects when the shell did not take it. */
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
    signedIn: async (origin, tenants, title) => {
      await invoke<void>("outpost_signed_in", { origin, tenants, title });
    },
    signedOut: async () => {
      await invoke<void>("outpost_signed_out");
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
  /** a shop the person helps at, or a helper's session: only the shop's owner adds an outpost */
  | "owner_only"
  /** the shop already has the 20 outposts it may */
  | "too_many"
  | "signed_out"
  | "offline"
  /** registered on the API, but this Mac could not keep its credential (the keychain said no, or there is none) */
  | "keychain"
  /** the person's place in the shop ended (their account unlinked from it, or the shop gone); the account row says how */
  | "left"
  | "failed";

/** The API's route for registering this Mac (`ownerOutpostRoute` in apps/api/src/browser-control.ts). */
export const REGISTER_PATH = "/v1/outposts/register";

/** What a registration needs of the host (`HttpHost.ownerLink`, as the Connections ops use it): its word on the person's
 *  shops, each shop's own session, and where to say that the person's place in a shop ended. */
export type RegisterLink = Pick<OwnerLink, "live" | "viewed" | "roleAt" | "writeVia" | "departed">;

/** Registers this Mac as one of `shop`'s outposts, named `name`: the shop the page shows, or null for the signed-in tenant
 *  while the person is in no shops. It goes with that shop's own owner session, or the sign-in, as a change to the shop's
 *  vault does (connections.ts), and never to another shop because the switcher moved meanwhile. The shell keeps the
 *  credential and starts the outpost; the page learns only how it went. */
export async function registerThisMac(link: RegisterLink, shop: string | null, shell: OutpostShell, name: string): Promise<Registered> {
  let viewed: Awaited<ReturnType<RegisterLink["viewed"]>>;
  try {
    // Nothing is sent while only a kept read of the shop is shown, and the person's shops are read first if they were not
    // yet, so a person in shops never registers this Mac for their own signed-in tenant by mistake.
    link.live();
    viewed = await link.viewed();
  } catch (e) {
    const code = e instanceof OpError ? e.code : "";
    return code === "offline" ? "offline" : code === "signed_out" ? "signed_out" : "failed";
  }
  // The signed-in tenant is the person's own, and theirs to register for, only while they are in no shops; a shop must be
  // one of theirs, and theirs to own. A helper's session is never sent: the API would refuse it `owner_only` anyway.
  const role = shop === null ? (viewed === null ? "owner" : undefined) : link.roleAt(shop);
  if (role === undefined) return "failed";
  if (role !== "owner") return "owner_only";
  const shellSaid: { why: "keychain" | "unavailable" | null } = { why: null };
  const through = shell.registerFetch((why) => {
    shellSaid.why = why;
  });
  const answer = await link.writeVia(shop, REGISTER_PATH, { name, kind: "this_mac" }, through);
  switch (answer.kind) {
    case "ok":
      return "registered";
    case "left":
      // The host says so in the account row, in the departure's words, as it does when a read finds it.
      if (shop !== null) link.departed(shop, answer.departure);
      return "left";
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

/** The tenants this Mac's outpost may run for now: the one the sign-in is for, which is the person's own, and each shop they
 *  hold an owner session for that has not ended (its 30 days), with when the first of those ends (null when none will).
 *  Null while nobody is signed in. A helper's session never counts: only a shop's owner may have an outpost run for it, as
 *  only its owner may register one. The page never learns which of them the keychain's item is for; the shell decides. */
export function ownedTenants(session: ApiSession, now: number): { tenants: string[]; until: number | null } | null {
  const own = session.signedInTenant;
  if (own === null) return null;
  const owned = session
    .heldShops()
    .map((shop) => ({ shop, held: session.shopSession(shop) }))
    .filter(({ shop, held }) => shop !== own && held?.role === "owner" && held.expiresAt > now)
    .sort((a, b) => (a.shop < b.shop ? -1 : 1));
  const until = owned.reduce<number | null>((first, { held }) => (first === null || held!.expiresAt < first ? held!.expiresAt : first), null);
  return { tenants: [own, ...owned.map(({ shop }) => shop)], until };
}

/** How long the follower waits at most before it looks at the shop sessions again: a timer cannot wait out 30 days, and a
 *  day is soon enough to find one that ended while nothing else changed. */
export const LOOK_AGAIN_MS = 24 * 3_600_000;

/** The outpost follows `session` and the shop sessions it holds: the shell is told every tenant the person acts for as owner
 *  (`ownedTenants`) whenever that changes, so this Mac's outpost runs while one of them is the shop it is registered for,
 *  and stops when none is: at sign-out, when the API ends the session, when the person's place in the shop ends (an
 *  unlinking, a shop gone from their list), or when the shop's owner session ends and is not opened again. The shell's
 *  commands run side by side, so what is told goes one call at a time, in order, each the latest, and never twice the
 *  same. `title` is the outpost's window title in the page's language, read each time it is sent. Answers how to stop. */
export function followSignIn(session: ApiSession, shell: OutpostShell, title: () => string, now: () => number = Date.now): () => void {
  let following = true;
  let telling = false;
  let again = false;
  /** what the shell last took: the origin and the tenants, or "out"; undefined before it took anything */
  let told: string | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tell = async (): Promise<void> => {
    if (telling) {
      again = true;
      return;
    }
    telling = true;
    try {
      do {
        again = false;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (!following) return;
        const owned = ownedTenants(session, now());
        // An owner session that ends with nothing else changing must still stop the outpost, so the follower looks again
        // then; a shop session opened again before its end replaces it, which it hears.
        if (owned?.until != null) timer = setTimeout(() => void tell(), Math.min(Math.max(owned.until - now(), 0), LOOK_AGAIN_MS));
        const say = owned ? JSON.stringify([session.origin, owned.tenants]) : "out";
        if (say === told) continue;
        try {
          if (owned) await shell.signedIn(session.origin, owned.tenants, title());
          else await shell.signedOut();
          told = say;
        } catch {
          // The shell did not take it: the next change tells it again.
        }
      } while (again && following);
    } finally {
      telling = false;
    }
  };

  const offState = session.subscribe(() => void tell());
  const offShops = session.onShops(() => void tell());
  if (session.state.kind !== "loading") void tell();
  return () => {
    following = false;
    offState();
    offShops();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
