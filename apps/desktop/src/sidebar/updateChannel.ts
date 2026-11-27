// Which update channel this Mac follows (item 111, owner 27 Nov 2026): Stable, the releases the owner publishes, or
// Nightly, a build of pilot/week-1 made each night that changed. The choice is kept on this Mac in the page's storage and
// is read at every check, so changing it needs no restart.
//
// The page names a channel and never an address: `@tauri-apps/plugin-updater` 2.14.1's `check` cannot take an endpoint, so
// Nightly goes through the shell's `check_update_channel` (src-tauri/src/update_channel.rs), which maps the name to the
// feed. Stable keeps using the plugin's own check and the endpoint in tauri.conf.json. The addresses are repeated here only
// to show and to test; update_channel.rs is the one that acts on them, and a test pins the two files together.
//
// The Mac App Store edition has no channel: the store updates it (updater.ts `updateHost`), and Settings does not show the
// row there.

export type UpdateChannel = "stable" | "nightly";
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "nightly"];

const KEY = "manut.update.channel";
/** Sent on `window` after the choice changes, so a watching button asks the new channel at once. */
export const CHANNEL_EVENT = "manut:update-channel";

/** The feed each channel reads. */
export const FEEDS: Record<UpdateChannel, string> = {
  stable: "https://github.com/mygogocash/manut-ai/releases/latest/download/latest.json",
  nightly: "https://github.com/mygogocash/manut-ai/releases/download/nightly/nightly.json",
};

/** Anything but the exact word "nightly" is Stable, so a damaged value can never put someone on the nightly builds. */
export function parseChannel(raw: string | null | undefined): UpdateChannel {
  return raw === "nightly" ? "nightly" : "stable";
}

/** The feed a channel reads. */
export function feedFor(channel: UpdateChannel): string {
  return FEEDS[channel];
}

function read(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The channel this Mac follows (Stable until the person chooses Nightly). */
export const updateChannel = (): UpdateChannel => parseChannel(read());

/** Keep the choice on this Mac. Stable removes the key, so the default is the absence of a choice. */
export function setUpdateChannel(channel: UpdateChannel): void {
  try {
    if (channel === "nightly") localStorage.setItem(KEY, "nightly");
    else localStorage.removeItem(KEY);
  } catch {
    /* no storage: the choice lasts only until the page closes, which is Stable */
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event(CHANNEL_EVENT));
}
