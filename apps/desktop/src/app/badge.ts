// The Dock (macOS) or launcher (Linux desktops that show counts) count of what waits on the person: the requests that
// wait for them and nothing else (the canvas: "The number on the Dock icon is the number of requests waiting"). That is
// every approval and question open in any bot's chat or SESSIONS chat (the Needs-you list), and a bot's request to type
// into a terminal, which waits on the person too. An answer nobody has read yet is news, not a request: it no longer counts.
// Windows has no count, so the shell lays a small dot over the taskbar button instead (src-tauri/src/lib.rs `asks_badge`).
//
// On macOS the page sets it with Tauri's window badge count (the capability is in src-tauri/capabilities). A count of 0
// removes the badge, and macOS needs no count at all for that: the runtime draws a count of 0 as the label "0"
// (tauri-runtime-wry: `set_badge_label(count.map(to_string))`), whatever the API's doc says.
import { useEffect } from "react";
import { selectAsks, useStore } from "../state/store";
import { getHost } from "../sessions/host";
import { usePendingRequests } from "../sessions/termShare";
import { DOCK_MAX, dockCount } from "../lib/outside";
import { isMacPlatform } from "../lib/power";
import { inTauri } from "../lib/tauri";

/** The number shown: every request waiting, at most 99 (the Dock cuts longer labels). */
export const badgeCount = (asks: number) => Math.min(Math.max(0, asks), DOCK_MAX);

/** The requests waiting on the person, as a number: notify-rules' count of them, and nothing else. */
export const dockRequests = (asks: readonly unknown[], terminalRequests: readonly unknown[]): number => dockCount([...asks, ...terminalRequests]);

/** What the window's badge count is given for `n`: no count at all for 0, which removes the badge. */
export const dockArg = (n: number): number | undefined => (n > 0 ? n : undefined);


/** Show `n` on the Dock icon; 0 removes it. On macOS in the desktop app that is the window's badge count; anywhere else it
 *  is the shell's own command (Windows' dot, Linux's count), or the page's stand-in in a plain browser. */
export async function setDockBadge(n: number, host: { badge(count: number): Promise<void> } = getHost()): Promise<void> {
  if (inTauri() && isMacPlatform()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setBadgeCount(dockArg(n));
    return;
  }
  await host.badge(n);
}

export function useAsksBadge(): void {
  const s = useStore();
  // a bot waiting to type into a terminal waits on the person too
  const terminal = usePendingRequests();
  const n = dockRequests(selectAsks(s), terminal);
  useEffect(() => {
    void setDockBadge(n).catch(() => undefined);
  }, [n]);
}
