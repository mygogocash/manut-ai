/// What the owner's web app's service worker (sw.ts) does with a push (item 78d, docs/remote-access.md, "Push"), as plain
/// values and functions so they are tested on their own: the one notification it ever shows, and where opening it goes.
///
/// A push from the relay carries nothing, and whatever a push might carry is never read: the notification is always the
/// same few words, with no chat, ask, name or count in it, so nothing of the person's work reaches the lock screen or
/// the push service. Opening it opens the Your Mac tab, which connects to the Mac and shows what waits.
///
/// Only sw.ts imports this file, so the worker stays one script of its own (swRules.ts says why). Its words are the
/// strings table's `mac.pushTitle` (strings.ts), which a test holds them to.

/// The notification's title, and its only words.
export const PUSH_TITLE = "Your Mac needs you";
/// One notification at a time: a newer push replaces the one still shown, and alerts again.
export const PUSH_TAG = "manut-mac";
/// Where opening it goes: the app's Your Mac tab.
export const MAC_URL = "/app/#mac";
export const PUSH_ICON = "/app/icons/icon-192.png";

/// The options the notification is shown with: no body, no data, nothing from the push. No `badge`: Android draws it as a
/// one-colour shape, and the app's opaque icon would show there as a plain square.
export function pushNotice(): { tag: string; renotify: boolean; icon: string } {
  return { tag: PUSH_TAG, renotify: true, icon: PUSH_ICON };
}

/// Which of the app's open windows opening the notification brings forward: the first under `/app/` on this origin, or
/// none, and a new one opens on the Your Mac tab.
export function windowToOpen(urls: readonly string[], origin: string): number {
  return urls.findIndex((url) => {
    try {
      const at = new URL(url);
      return at.origin === origin && at.pathname.startsWith("/app/");
    } catch {
      return false;
    }
  });
}
