// What the microphone and voice mode share (voice.ts): the person's choices and where they are kept, when listening may
// start and when the person's yes to Apple comes first, the words in the box, and an answer made fit to read aloud.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t } from "../i18n";
import { chunks, decide, DEFAULT_PREFS, onPrefs, readPrefs, refusalOf, refusalText, savePrefs, speakable, SPOKEN, withHeard, type HearStatus } from "./voice";

afterEach(() => setLang("en"));

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const status = (over: Partial<HearStatus> = {}): HearStatus => ({ lang: "th-TH", supported: true, available: true, onDevice: false, speech: "notAsked", mic: "notAsked", ...over });

describe("the person's voice choices", () => {
  it("start on Thai, on this Mac only, with the Mac's default voices", () => {
    expect(SPOKEN).toEqual(["th-TH", "en-US"]);
    expect(readPrefs(memory())).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toEqual({ lang: "th-TH", where: "device", voices: {} });
  });

  it("keep a language, the yes to Apple and a voice, and read anything else as the default", () => {
    const store = memory();
    const heard = vi.fn();
    const off = onPrefs(heard);
    savePrefs({ lang: "en-US" }, store);
    savePrefs({ where: "apple", voices: { "th-TH": "com.apple.voice.compact.th-TH.Kanya" } }, store);
    expect(readPrefs(store)).toEqual({ lang: "en-US", where: "apple", voices: { "th-TH": "com.apple.voice.compact.th-TH.Kanya" } });
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    // a language the shell does not take, an unknown choice, a broken voice list
    store.m.set("manut.voice.lang", "fr-FR");
    store.m.set("manut.voice.where", "cloud");
    store.m.set("manut.voice.voices", "{not json");
    expect(readPrefs(store)).toEqual(DEFAULT_PREFS);
    store.m.set("manut.voice.voices", JSON.stringify({ "th-TH": 3, "en-US": "Samantha", "fr-FR": "x" }));
    expect(readPrefs(store).voices).toEqual({ "en-US": "Samantha" });
    // no storage at all: the defaults, and saving does not throw
    const broken = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
    expect(readPrefs(broken)).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs({ lang: "en-US" }, broken)).not.toThrow();
  });
});

describe("when listening may start", () => {
  it("listens on this Mac for a language it recognizes by itself, whatever the person allowed", () => {
    expect(decide(status({ lang: "en-US", onDevice: true }), "device")).toEqual({ kind: "listen", apple: false });
    expect(decide(status({ lang: "en-US", onDevice: true }), "apple")).toEqual({ kind: "listen", apple: false });
  });

  it("asks the person before a language goes to Apple's servers, and goes there only after the yes", () => {
    expect(decide(status(), "device")).toEqual({ kind: "ask" });
    expect(decide(status(), "apple")).toEqual({ kind: "listen", apple: true });
    // the yes comes before the network: offline, Thai still asks first, then says it cannot now
    expect(decide(status({ available: false }), "device")).toEqual({ kind: "ask" });
    expect(decide(status({ available: false }), "apple")).toEqual({ kind: "refuse", why: "unavailable" });
  });

  it("lets macOS ask for a permission never asked, and says how to turn one back on", () => {
    expect(decide(status({ onDevice: true, mic: "notAsked", speech: "notAsked" }), "device").kind).toBe("listen");
    expect(decide(status({ onDevice: true, mic: "denied" }), "device")).toEqual({ kind: "refuse", why: "mic-denied" });
    expect(decide(status({ onDevice: true, mic: "restricted" }), "device")).toEqual({ kind: "refuse", why: "mic-denied" });
    expect(decide(status({ onDevice: true, speech: "denied" }), "device")).toEqual({ kind: "refuse", why: "speech-denied" });
    expect(decide(status({ supported: false }), "apple")).toEqual({ kind: "refuse", why: "unsupported" });
    expect(refusalText("mic-denied", "th-TH")).toContain("System Settings");
    expect(refusalText("unsupported", "th-TH")).toContain("Thai");
  });

  it("reads the shell's refusals, and any error of the recognizer as one that says it stopped", () => {
    for (const code of ["apple-not-allowed", "mic-denied", "busy", "input", "not-here"]) expect(refusalOf(code)).toBe(code);
    expect(refusalOf("failed:kAFAssistantErrorDomain:1110")).toBe("failed");
    expect(refusalOf(new Error("anything else"))).toBe("failed");
  });

  it("has words for every refusal in every language", () => {
    for (const l of LANGS) {
      setLang(l);
      for (const why of ["unsupported", "mic-denied", "speech-denied", "apple-not-allowed", "unavailable", "input", "busy", "not-here", "failed", "nothing"] as const) {
        expect(refusalText(why, "th-TH").length, `${l} ${why}`).toBeGreaterThan(5);
      }
    }
    setLang("en");
    expect(t("voice.lang.th")).toContain("ไทย");
  });
});

describe("the words heard in the box", () => {
  it("go after what was typed, and each update replaces the last", () => {
    expect(withHeard("", "สวัสดี")).toBe("สวัสดี");
    expect(withHeard("Ask Pim", "about the order")).toBe("Ask Pim about the order");
    expect(withHeard("Ask Pim ", "about")).toBe("Ask Pim about");
    expect(withHeard("Ask Pim", "  ")).toBe("Ask Pim");
    expect(withHeard("  ", "hello")).toBe("hello");
  });
});

describe("an answer read aloud", () => {
  it("reads the words and leaves out marks, code and addresses", () => {
    const md = [
      "## Today's orders",
      "",
      "You have **3 new orders** and _one_ is late. See [the list](https://example.com/orders).",
      "- Order 1: `#1043`",
      "1. Pack it",
      "> Kit says hi",
      "```ts",
      "const x = 1;",
      "```",
      "Details at https://shop.example.com/x",
      "| a | b |",
      "| --- | --- |",
    ].join("\n");
    expect(speakable(md)).toBe(["Today's orders", "You have 3 new orders and one is late. See the list.", "Order 1: #1043", "Pack it", "Kit says hi", "Details at", "a b"].join("\n"));
    expect(speakable("```\nonly code\n```")).toBe("");
    expect(speakable("วันนี้มี **3** ออเดอร์")).toBe("วันนี้มี 3 ออเดอร์");
  });

  it("cuts a long answer into short pieces at a sentence or a space, losing nothing", () => {
    const long = `${"The order is packed. ".repeat(20)}Done`;
    const parts = chunks(long, 100);
    expect(parts.length).toBeGreaterThan(4);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(long.trim().replace(/\s+/g, " "));
    // Thai has no full stops: it is cut at a space; a word longer than the limit is cut where it must be
    const thai = "สวัสดีค่ะ ".repeat(40).trim();
    for (const p of chunks(thai, 50)) expect(p.length).toBeLessThanOrEqual(50);
    expect(chunks("x".repeat(120), 50).map((p) => p.length)).toEqual([50, 50, 20]);
    expect(chunks("one\n\ntwo")).toEqual(["one", "two"]);
  });
});

describe("what the page's voice code keeps", () => {
  it("logs nothing, and reaches the shell only to read, listen and stop", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
    const files = ["voice/voice.ts", "voice/engine.ts", "voice/mic.ts", "voice/mode.ts", "chat/box/Voice.tsx", "settings/VoicePage.tsx"];
    for (const f of files) expect(src(f), f).not.toMatch(/console\.|indexedDB|sessionStorage|\bfetch\(/);
    const engine = src("voice/engine.ts");
    expect([...engine.matchAll(/invoke(?:<[^>]*>)?\("([\w_]+)"/g)].map((m) => m[1]).sort()).toEqual(["voice_listen", "voice_status", "voice_stop", "voice_stop"]);
    // what is kept in this computer's storage: the three choices, never words or audio
    expect([...src("voice/voice.ts").matchAll(/"(manut\.voice\.\w+)"/g)].map((m) => m[1]).sort()).toEqual(["manut.voice.lang", "manut.voice.voices", "manut.voice.where"]);
  });
});
