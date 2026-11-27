import { describe, expect, it } from "vitest";
import { MAX_PUSH_ADDRESS, PUSH_HOSTS, pushAddressOk } from "../src/index";

/// A phone's push address (item 78d): only the three push services' own hosts, over https at the default port, with a
/// path, and in the URL parser's own form. The relay checks the same rule (apps/api/src/web-push.ts), and its tests hold
/// its list to this one.

describe("a push address", () => {
  it("is taken from Apple's, Google's and Mozilla's push services", () => {
    expect(PUSH_HOSTS).toEqual(["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"]);
    for (const address of [
      "https://web.push.apple.com/QGuQyavXutnMH8iVgwGGgVwKbd5Wfa1DXQWCeQGAkdaBJgJ1wUtklzp9KgAoWwPbIaHRdQ0v7gkTSDNDUPkIWRtNlVhLwtiO4Lq",
      "https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91bHqjZxM0VImWWqDRN7U0a3AycjUf4O-byuxb_wJsKRaKvV_iKw56s16ekq6FUqoCF7k2nICUpd8fHPxVTgqLunFeVeB9lLCQZyohyAztTH8ZQL9WCxKpA6dvTG_TUIhQUFq_n",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABjZ3cK-something_long",
    ]) {
      expect(pushAddressOk(address), address).toBe(true);
    }
  });

  it("is refused anywhere else, and in any other form", () => {
    for (const address of [
      "https://example.com/push/1",
      "https://push.apple.com/abc",
      "https://web.push.apple.com.example.com/abc",
      "https://evil.fcm.googleapis.com/fcm/send/abc",
      "https://notify.windows.com/w/?token=abc",
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pass@fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com/fcm/send/abc#frag",
      "https://fcm.googleapis.com/",
      "https://fcm.googleapis.com",
      "https://FCM.googleapis.com/fcm/send/abc",
      " https://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com/fcm/send/a b",
      "https://fcm.googleapis.com/fcm/send/../../x",
      `https://fcm.googleapis.com/${"a".repeat(MAX_PUSH_ADDRESS)}`,
      "javascript:alert(1)",
      "",
    ]) {
      expect(pushAddressOk(address), address).toBe(false);
    }
    for (const value of [null, undefined, 42, {}, ["https://fcm.googleapis.com/fcm/send/abc"]]) expect(pushAddressOk(value)).toBe(false);
  });
});
