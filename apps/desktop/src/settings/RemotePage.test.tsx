// Settings › Sharing and access (item 78b): the switch off until consent, the consent sheet's words with the owner's
// placeholder, the code for two minutes, the field for the four digits, how a pairing ended, the phone list with Unpair,
// and the one quiet line while a phone is connected. What each control does is tested where it is done (src/remote/).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { DICT, LANGS, setLang } from "../i18n";
import type { RemoteSnapshot } from "../remote/host";
import { memoryKeyring } from "../remote/keys";
import { CONSENT_VERSION, consentCovers, readChoice, remoteMac, resetRemoteForTests, resumeRemote, turnOn, writeChoice } from "../remote/state";
import { FakeChats } from "../remote/testkit/chats";
import { APP_PAGES } from "./pages";
import { CONSENT_POINTS, RemoteView, type RemoteViewProps } from "./RemotePage";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const NOW = 1_800_000_000_000;
const LINK = `https://dev.manut.xyz/app/#pair=${"A".repeat(151)}`;

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}

function view(snapshot: Partial<RemoteSnapshot>, more: Partial<RemoteViewProps> = {}): string {
  const noop = () => undefined;
  const props: RemoteViewProps = {
    snapshot: { on: false, link: "stopped", pairing: { phase: "idle" }, phones: [], ...snapshot },
    consenting: false,
    now: NOW,
    copied: false,
    onSwitch: noop,
    onAccept: noop,
    onDecline: noop,
    onPair: noop,
    onCancel: noop,
    onCopy: noop,
    onCode: noop,
    onUnpair: noop,
    ...more,
  };
  return renderToString(<RemoteView {...props} />);
}

beforeEach(() => setLang("en"));
afterEach(() => {
  vi.unstubAllGlobals();
  resetRemoteForTests();
});

describe("Settings › Sharing and access", () => {
  it("is one App page, after Artifacts", () => {
    const ids = APP_PAGES.map((p) => p.id);
    expect(ids.filter((id) => id === "remote")).toHaveLength(1);
    expect(ids.indexOf("remote")).toBe(ids.indexOf("artifacts") + 1);
  });

  it("starts off, says so, and offers no pairing until it is on and the relay answers", () => {
    const html = view({});
    expect(html).toContain('aria-checked="false"');
    expect(words(html)).toContain("Off. Nothing outside this Mac can reach it.");
    expect(words(html)).toContain("Turn on Reach this Mac from your phone first.");
    expect(html).toMatch(/data-testid="remote-pair"[^>]*disabled|disabled=""[^>]*data-testid="remote-pair"/);
    expect(words(html)).toContain("No phones are paired.");
    expect(html).not.toContain("remote-consent");
    const relayOff = view({ on: true, link: "unavailable" });
    expect(words(relayOff)).toContain("Not available yet: the relay isn't switched on.");
    expect(relayOff).toMatch(/data-testid="remote-pair"[^>]*disabled|disabled=""[^>]*data-testid="remote-pair"/);
    expect(words(view({ on: true, link: "no_origin" }))).toContain("Connect this app to your shop first");
  });

  it("asks first with a consent sheet that names no business, its operator sentence left for the owner", () => {
    const html = view({}, { consenting: true });
    expect(html).toContain('data-testid="remote-consent"');
    const text = words(html);
    for (const key of CONSENT_POINTS) expect(text).toContain(DICT.en[key].replace(/'/g, "'"));
    expect(DICT.en["rm.consent.operator"]).toMatch(/^\[Owner to write: .*\]$/);
    for (const l of LANGS) {
      expect(DICT[l]["rm.consent.operator"], l).toMatch(/^\[.*\]$/);
      for (const key of CONSENT_POINTS) expect(DICT[l][key], `${l} ${key}`).not.toMatch(/GoGoCash|Cloudflare|Manut AI|GoSpark|Anthropic/);
    }
    // Encrypted, what the relay sees, how long, what the phone may do, and how to stop.
    expect(text).toContain("encrypted end to end");
    expect(text).toContain("internet addresses");
    expect(text).toContain("unpair a phone, to stop");
  });

  it("shows the code as a QR code and a link to copy, with the time it has left", () => {
    const html = view({ on: true, link: "ready", pairing: { phase: "showing", link: LINK, expiresAt: NOW + 90_000 } });
    expect(html).toContain('data-testid="remote-qr"');
    expect(html).toContain("<svg");
    expect(words(html)).toContain("Works for 1:30 more.");
    expect(words(html)).toContain("Copy link");
    expect(words(view({ on: true, link: "ready", pairing: { phase: "showing", link: LINK, expiresAt: NOW + 90_000 } }, { copied: true }))).toContain("Copied");
  });

  it("hides the code once the phone has started, and then asks for the four digits once", () => {
    const checking = view({ on: true, link: "ready", pairing: { phase: "checking", expiresAt: NOW + 60_000 } });
    expect(checking).not.toContain('data-testid="remote-qr"');
    expect(checking).not.toContain("#pair=");
    const code = view({ on: true, link: "ready", pairing: { phase: "code", expiresAt: NOW + 45_000 } });
    expect(code).not.toContain('data-testid="remote-qr"');
    expect(words(code)).toContain("Type the four digits your phone shows.");
    expect(words(code)).toContain("One try: a wrong code ends this pairing. 0:45 left.");
    expect(code).toContain('inputMode="numeric"');
    expect(code).toContain('maxLength="4"');
  });

  it("says how a pairing ended, and offers a new code", () => {
    expect(words(view({ on: true, link: "ready", pairing: { phase: "failed", reason: "wrong_code" } }))).toContain("That isn't the code on the phone. Show a new code to try again.");
    expect(words(view({ on: true, link: "ready", pairing: { phase: "failed", reason: "expired" } }))).toContain("The code ran out of time.");
    expect(words(view({ on: true, link: "ready", pairing: { phase: "finishing" } }))).toContain("Finish on your phone");
    expect(words(view({ on: true, link: "ready", pairing: { phase: "paired", name: "Somchai's iPhone" } }))).toContain("Somchai's iPhone is paired.");
    const full = view({ on: true, link: "ready", pairing: { phase: "failed", reason: "full" } });
    expect(words(full)).toContain("Unpair one first.");
    expect(words(full)).not.toContain("Show a new code");
  });

  it("lists the paired phones with Unpair, and says quietly which one is connected", () => {
    const phones = [
      { id: "A", name: "Somchai's iPhone", pairedAt: NOW - 86_400_000, lastSeen: NOW, connected: true },
      { id: "B", name: "Pixel", pairedAt: NOW, lastSeen: NOW, connected: false },
    ];
    const html = view({ on: true, link: "ready", phones });
    const text = words(html);
    expect(text).toContain("Somchai's iPhone");
    expect(text).toContain("Pixel");
    expect(text).toContain("last seen");
    expect(html.match(/data-testid="remote-unpair"/g)).toHaveLength(2);
    expect(text).toContain("Somchai's iPhone is connected.");
    expect(words(view({ on: true, link: "ready", phones: phones.map((p) => ({ ...p, connected: true })) }))).toContain("2 phones are connected.");
    expect(view({ on: true, link: "ready", phones: phones.map((p) => ({ ...p, connected: false })) })).not.toContain("remote-connected");
  });
});

describe("the switch and consent, kept on this computer", () => {
  it("reads as off with no consent unless both were kept, and asks again when the words change", () => {
    const store = fakeStorage();
    expect(readChoice(store)).toEqual({ on: false, consent: null });
    writeChoice({ on: true, consent: { at: NOW, version: CONSENT_VERSION } }, store);
    expect(readChoice(store)).toEqual({ on: true, consent: { at: NOW, version: CONSENT_VERSION } });
    expect(consentCovers(readChoice(store))).toBe(true);
    expect(consentCovers(readChoice(store), CONSENT_VERSION + 1)).toBe(false);
    for (const odd of ["not json", "[]", '{"on":"yes"}', '{"on":true,"consent":{"at":"x"}}']) {
      expect(readChoice(fakeStorage({ "manut.remote": odd })).consent).toBeNull();
    }
  });

  it("turns on only after consent, and at launch only for a person who turned it on", async () => {
    const keyring = memoryKeyring();
    const chats = new FakeChats();
    const sockets: string[] = [];
    const deps = {
      keyring,
      origin: "https://dev.manut.xyz",
      connect: (url: string) => {
        sockets.push(url);
        throw new Error("no network in this test");
      },
      probe: async () => "off" as const,
      chats,
      actions: chats.actions,
      now: () => NOW,
    };
    vi.stubGlobal("localStorage", fakeStorage());
    remoteMac(deps);
    expect(await turnOn()).toBe(false);
    resumeRemote();
    await new Promise((r) => setTimeout(r, 0));
    expect(keyring.doc()).toBeNull();
    expect(sockets).toEqual([]);
    // On, but under words since changed: still nothing at launch.
    writeChoice({ on: true, consent: { at: NOW, version: CONSENT_VERSION - 1 } });
    resumeRemote();
    await new Promise((r) => setTimeout(r, 0));
    expect(sockets).toEqual([]);
    writeChoice({ on: true, consent: { at: NOW, version: CONSENT_VERSION } });
    resumeRemote();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(keyring.doc()?.host).toBeTruthy();
  });
});
