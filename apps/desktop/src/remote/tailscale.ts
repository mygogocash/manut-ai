// Tailscale on this Mac, as Settings, Sharing and access will show it (item 78f, docs/remote-access.md, "The second
// road: Tailscale"). The shell's `tailscale_state` (src-tauri/src/tailscale.rs) runs only `tailscale status --json
// --peers=false` and answers one of four states, with this Mac's name on the tailnet when it is ready. Nothing shows
// these words yet: the page that does is item 78b's.
//
// The page checks the shell's answer again instead of trusting its shape: a state it does not know is "signed_out", a
// name that is not plain DNS labels under ts.net is "needs_https", and only the state and the name are kept.
//
// In a plain browser (dev, e2e) with `window.__manutTailscale` set, that value stands in for the shell's answer.
import { t, type Lang } from "../i18n";
import { inTauri } from "../lib/tauri";

/** Tailscale on this Mac: not installed, not running and signed in, running without MagicDNS and HTTPS for this Mac,
 *  or ready under `name` (`mac.tail1234.ts.net`). */
export type TailscaleState = { state: "missing" } | { state: "signed_out" } | { state: "needs_https" } | { state: "ready"; name: string };

/** The rule tailscale.rs `name_ok` keeps: lowercase DNS labels of 1 to 63 letters, digits and hyphens, none starting
 *  or ending with a hyphen, at most 253 characters, under ts.net with at least one label of its own. */
export function tailscaleNameOk(name: string): boolean {
  const labels = name.split(".");
  return name.length <= 253 && name.endsWith(".ts.net") && labels.length >= 3 && labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/** The shell's answer as one of the four states, nothing else of it kept. */
export function tailscaleState(raw: unknown): TailscaleState {
  if (typeof raw !== "object" || raw === null) return { state: "signed_out" };
  const r = raw as { state?: unknown; name?: unknown };
  switch (r.state) {
    case "missing":
    case "signed_out":
    case "needs_https":
      return { state: r.state };
    case "ready":
      return typeof r.name === "string" && tailscaleNameOk(r.name) ? { state: "ready", name: r.name } : { state: "needs_https" };
    default:
      return { state: "signed_out" };
  }
}

type Globals = { __manutTailscale?: unknown };
const standIn = (): unknown => (typeof window === "undefined" ? undefined : (window as unknown as Globals).__manutTailscale);

/** Reads Tailscale's state through the shell. The page sends nothing. A call that fails is "signed_out", as the
 *  shell's own failed read is: never "ready". */
export async function readTailscale(): Promise<TailscaleState> {
  const mock = standIn();
  if (mock !== undefined && !inTauri()) return tailscaleState(mock);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return tailscaleState(await invoke("tailscale_state"));
  } catch {
    return { state: "signed_out" };
  }
}

/** The line Settings shows for `s`, in language `l` (the current one by default). */
export function tailscaleLine(s: TailscaleState, l?: Lang): string {
  switch (s.state) {
    case "missing":
      return t("tailscale.missing", undefined, l);
    case "signed_out":
      return t("tailscale.signedOut", undefined, l);
    case "needs_https":
      return t("tailscale.needsHttps", undefined, l);
    case "ready":
      return t("tailscale.ready", { name: s.name }, l);
  }
}
