// What the connected runtime needs from the desktop shell (src-tauri/src/api_link.rs): a way to reach the API and a
// place to keep the session.
//
// Requests go through a Rust command rather than the webview's own fetch. The webview is held to CORS, and the API's
// session routes answer no CORS on purpose (docs/pilot-api.md); the packaged app's content security policy also
// allows no outside origin. The fork already reaches the outside through programs the shell runs (`gh` for GitHub),
// so the command runs the system's `curl` with the request on its standard input, and adds no HTTP library.
//
// The session (access and refresh tokens) is kept in the operating system's keychain, one item that only this app's
// commands name, never in localStorage, a log or an address. On a computer whose shell has no keychain support yet
// (anything but macOS today) the vault answers `VaultUnavailable` and Connected cannot sign in.
//
// Both take `fetch`'s shape and a three-call vault, so the runtime's tests hand in fakes and never need the shell.

export interface FetchInit {
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  body?: string;
}
export interface FetchAnswer {
  status: number;
  text(): Promise<string>;
}
/** `fetch`, narrowed to what the runtime uses. A request that gets no answer at all rejects, as `fetch` does. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchAnswer>;

/** Why a request got no answer: the host could not be reached (`offline`), the shell could not make the request (no
 *  `curl`, an address it refuses: `failed`), or there is no desktop shell at all, as in the browser preview
 *  (`unsupported`). */
export class LinkDown extends Error {
  constructor(readonly kind: "offline" | "failed" | "unsupported") {
    super(kind);
    this.name = "LinkDown";
  }
}

/** The keychain item that holds the session: read it (null when there is none), replace it, remove it. */
export interface SessionVault {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

/** This computer's shell keeps no keychain item (not macOS, or not the desktop app). */
export class VaultUnavailable extends Error {
  constructor(message = "no keychain") {
    super(message);
    this.name = "VaultUnavailable";
  }
}

const inShell = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

/** The bearer token of an `Authorization` header, which the shell takes apart from the address and the body. */
function bearerOf(headers: Record<string, string>): string | null {
  const value = headers.authorization ?? headers.Authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : null;
}

/** `fetch` through the shell's `api_request` command. The shell itself refuses any address but an https origin (or
 *  plain http on this computer) and any path outside `/v1/`, whatever the page asks. */
export function shellFetch(): FetchLike {
  return async (url, init) => {
    if (!inShell()) throw new LinkDown("unsupported");
    let answer: { status: number; body: string };
    try {
      answer = await invoke("api_request", { url, method: init.method, bearer: bearerOf(init.headers), body: init.body ?? null });
    } catch (e) {
      throw new LinkDown(e === "offline" ? "offline" : "failed");
    }
    return { status: answer.status, text: async () => answer.body };
  };
}

/** The session's keychain item through the shell's `api_session_read`, `api_session_write` and `api_session_clear`. */
export function shellVault(): SessionVault {
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (!inShell()) throw new VaultUnavailable("no desktop shell");
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      // Only the shell's own "unavailable" means there is no keychain; a refusal (a locked keychain, a denied
      // prompt) is a plain failure, so the person is told the keychain said no rather than that it is missing.
      throw e === "unavailable" ? new VaultUnavailable() : new Error("keychain");
    }
  };
  return {
    read: () => call<string | null>("api_session_read"),
    write: (value) => call<void>("api_session_write", { value }),
    clear: () => call<void>("api_session_clear"),
  };
}
