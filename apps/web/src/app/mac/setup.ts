/// Where the Your Mac tab runs: practice mode's pretend Mac, the relay on this page's own origin, or nothing.
///
/// The phone reaches the Mac only from the API's own origin (`/app/` there), because the passkey is tied to that exact
/// host and the relay lives beside it: the Mac names the same host for both (apps/desktop/src/remote/host.ts,
/// `relyingParty`). A page served from anywhere else says "not available yet", as the tab does while the relay is off.
import type { ApiMode } from "../../api";
import { liveBackend, relayFromHealth } from "./live";
import { phoneName } from "./pair";
import { browserPasskeys } from "./passkeys";
import { PRACTICE_MAC_OFF, practiceBackend, type PracticeBackend } from "./practice";
import { browserConnect } from "./relay";
import type { MacBackend } from "./remote";
import { indexedDbVault, memoryVault } from "./vault";

export type MacSetup = { readonly backend: MacBackend; readonly practice: PracticeBackend | null };

/// The pairing link a page was opened with (`/app/#pair=…`), taken out of the address at once so the code's secret stays
/// in no history entry, and whether the page runs as the installed app.
export type OpenedLink = { readonly link: string; readonly installed: boolean };

/// Whether this page runs as the app on the Home Screen. On an iPhone a link opened from the camera or a message lands
/// in Safari, whose storage the installed app does not share, so a pairing made there would be lost to it.
export function runsInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone || (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
}

/// The pairing link in this page's address, if it has one: taken out of the address and its history entry at once
/// (`#mac` stays), and returned with whether the page runs installed. Nothing is paired from it here.
export function takeOpenedLink(): OpenedLink | null {
  if (typeof window === "undefined" || !window.location.hash.startsWith("#pair=")) return null;
  const link = window.location.href;
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#mac`);
  return { link, installed: runsInstalled() };
}

/// `label` is the passkey's name in the phone's passwords.
export function macSetup(mode: ApiMode, label: string, apiOrigin: string | undefined = import.meta.env.VITE_API_ORIGIN): MacSetup {
  if (mode === "fake") {
    const off = window.location.search.includes(PRACTICE_MAC_OFF);
    const practice = practiceBackend(off ? { relay: "off", paired: true } : { relay: "on" });
    return { backend: practice, practice };
  }
  const origin = window.location.origin;
  const api = apiOrigin?.trim() === "same-origin" ? origin : apiOrigin?.trim();
  const here = api === origin;
  const backend = liveBackend({
    origin,
    connect: browserConnect,
    vault: here && typeof indexedDB !== "undefined" ? indexedDbVault() : memoryVault(),
    passkeys: browserPasskeys(),
    relay: async () => (here ? relayFromHealth(origin) : "off"),
    name: phoneName(navigator.userAgent),
    label,
  });
  return { backend, practice: null };
}
