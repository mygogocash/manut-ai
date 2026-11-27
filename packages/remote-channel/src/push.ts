/// A paired phone's push address (item 78d, docs/remote-access.md, "Push"): the endpoint of its Web Push subscription,
/// which the phone sends the Mac inside the channel and the Mac hands the relay, so the relay can wake the phone with a
/// push that carries nothing. The phone, the Mac and the relay check it by this one rule; the relay's own copy is
/// `apps/api/src/web-push.ts`, held to this list by its tests.
///
/// Only the three push services the browsers that can run the Your Mac tab subscribe with are taken, each by its exact
/// host: Apple's (Safari, and the installed app on an iPhone), Google's (Chrome) and Mozilla's (Firefox). An address
/// anywhere else is refused, so a phone, a Mac or anything that speaks for them cannot turn the relay into a client
/// that sends signed requests to a host of its choosing (docs/remote-access.md, "Attacks considered").

/// The push services' hosts. Apple's page for web push ("Sending web push notifications in web apps and browsers") asks
/// a server behind a firewall to allow `*.push.apple.com`; its subscriptions are on `web.push.apple.com`, the one host
/// taken here. Mozilla names `updates.push.services.mozilla.com` as its service's origin (its VAPID post, 23 Aug 2016),
/// and Chrome's subscriptions are on `fcm.googleapis.com`.
export const PUSH_HOSTS: readonly string[] = ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"];

/// The longest push address taken, in characters. The services' addresses are a few hundred characters at most.
export const MAX_PUSH_ADDRESS = 2_048;

/// Whether `value` is a push address the relay may send to: an https URL on one of `PUSH_HOSTS` at the default port,
/// with a path, no user, no fragment, and already in the form the URL parser writes, so what is kept and compared is
/// exactly what is sent to.
export function pushAddressOk(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PUSH_ADDRESS) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.href === value &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.hash === "" &&
    url.pathname.length > 1 &&
    PUSH_HOSTS.includes(url.hostname)
  );
}
