// The chat box's microphone (mic.ts), with a stand-in for the shell's listening: the words land in the text after what
// was typed, nothing is ever sent, a second press or Esc finishes, typing drops the rest, and a refusal comes back as
// words to show.
import { describe, expect, it } from "vitest";
import type { Ears, HearCallbacks } from "./engine";
import { createMic, type MicView } from "./mic";
import type { Spoken } from "./voice";

/** A stand-in for the shell's listening that a test speaks into. */
function fakeEars(opts: { refuse?: string } = {}) {
  const calls: string[] = [];
  let live: HearCallbacks | null = null;
  let resolveStart: (() => void) | null = null;
  const ears: Ears = {
    status: async (lang) => ({ lang, supported: true, available: true, onDevice: true, speech: "allowed", mic: "allowed" }),
    listen: (lang: Spoken, apple: boolean, on: HearCallbacks) => {
      calls.push(`listen ${lang} ${apple ? "apple" : "device"}`);
      if (opts.refuse) return Promise.reject(opts.refuse);
      live = on;
      return new Promise((resolve) => {
        resolveStart = () =>
          resolve({
            route: apple ? "apple" : "onDevice",
            stop: () => calls.push("stop"),
            cancel: () => {
              calls.push("cancel");
              live = null;
            },
          });
      });
    },
  };
  return {
    ears,
    calls,
    started: () => resolveStart?.(),
    say: (text: string, final = false) => live?.heard(text, final),
    end: (error?: string) => live?.ended(error),
  };
}

function setup(typed = "", opts: { refuse?: string } = {}) {
  const f = fakeEars(opts);
  const box = { text: typed };
  const views: MicView["kind"][] = [];
  const notes: string[] = [];
  const mic = createMic({
    ears: f.ears,
    text: () => box.text,
    setText: (t) => void (box.text = t),
    onView: (v) => views.push(v.kind),
    onRefusal: (why) => notes.push(why),
  });
  return { f, box, views, notes, mic };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the microphone", () => {
  it("puts the words heard after what was typed, replacing each guess with the next, and sends nothing", async () => {
    const { f, box, views, mic } = setup("Ask Pim");
    const going = mic.start("th-TH", false);
    expect(mic.view.kind).toBe("starting");
    f.started();
    await going;
    expect(mic.view).toEqual({ kind: "listening", route: "onDevice" });
    f.say("about");
    expect(box.text).toBe("Ask Pim about");
    f.say("about the late order");
    expect(box.text).toBe("Ask Pim about the late order");
    // press again: it finishes, the last words come, and the box keeps them
    mic.stop();
    expect(mic.view.kind).toBe("stopping");
    f.say("about the late order.", true);
    f.end();
    expect(box.text).toBe("Ask Pim about the late order.");
    expect(views).toEqual(["starting", "listening", "stopping", "off"]);
    expect(f.calls).toEqual(["listen th-TH device", "stop"]);
  });

  it("listens through Apple's servers only when the caller passes the person's yes", async () => {
    const { f, mic } = setup();
    const going = mic.start("th-TH", true);
    f.started();
    await going;
    expect(f.calls).toEqual(["listen th-TH apple"]);
    expect(mic.view).toEqual({ kind: "listening", route: "apple" });
  });

  it("stops at once when the person types, keeping the words already in the box", async () => {
    const { f, box, mic } = setup();
    const going = mic.start("en-US", false);
    f.started();
    await going;
    f.say("hello there");
    mic.cancel();
    expect(mic.view.kind).toBe("off");
    // a late guess from the dropped recognition changes nothing
    f.say("hello there friend");
    expect(box.text).toBe("hello there");
    expect(f.calls).toEqual(["listen en-US device", "cancel"]);
  });

  it("dropped while it starts, it lets the recognition go as soon as it comes", async () => {
    const { f, mic } = setup();
    const going = mic.start("en-US", false);
    mic.stop(); // Esc before the shell answered
    expect(mic.view.kind).toBe("off");
    f.started();
    await going;
    expect(f.calls).toEqual(["listen en-US device", "cancel"]);
    expect(mic.view.kind).toBe("off");
  });

  it("says why it could not start, or that nothing was heard", async () => {
    const refused = setup("", { refuse: "apple-not-allowed" });
    await refused.mic.start("th-TH", false);
    expect(refused.notes).toEqual(["apple-not-allowed"]);
    expect(refused.mic.view.kind).toBe("off");

    const quiet = setup();
    const going = quiet.mic.start("en-US", false);
    quiet.f.started();
    await going;
    quiet.f.end();
    expect(quiet.notes).toEqual(["nothing"]);

    const broke = setup();
    const going2 = broke.mic.start("en-US", false);
    broke.f.started();
    await going2;
    broke.f.say("half a");
    broke.f.end("failed:kAFAssistantErrorDomain:1101");
    // words were heard: they stay, and the button going off says it stopped
    expect(broke.box.text).toBe("half a");
    expect(broke.notes).toEqual([]);
    await flush();
  });

  it("starts only once at a time", async () => {
    const { f, mic } = setup();
    const going = mic.start("en-US", false);
    void mic.start("en-US", false);
    f.started();
    await going;
    expect(f.calls).toEqual(["listen en-US device"]);
  });
});
