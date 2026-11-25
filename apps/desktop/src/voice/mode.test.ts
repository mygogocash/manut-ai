// Voice mode (mode.ts): the state machine walked event by event, then the runner with stand-ins for the shell's listening,
// the Mac's voice, the chat and the clock. What is sent when, what is read aloud, and that an ask is never answered by
// voice: it pauses, says so, and goes on only after the person decided with the card.
import { describe, expect, it } from "vitest";
import type { Ears, HearCallbacks, Mouth } from "./engine";
import { createVoiceMode, OFF, PAUSE_MS, step, TICK_MS, WAIT_START_MS, type ModeEffect, type ModeEvent, type ModeState } from "./mode";

/** Runs events through `step` from `from`, and gives the state and every effect in order. */
function walk(events: ModeEvent[], from: ModeState = OFF) {
  let s = from;
  const effects: ModeEffect[] = [];
  for (const e of events) {
    const r = step(s, e);
    s = r.state;
    effects.push(...r.effects);
  }
  return { s, effects, types: effects.map((e) => e.type) };
}
const chat = (running: boolean, asking: boolean, answer: string | null, at = 0): ModeEvent => ({ type: "chat", running, asking, answer, at });

describe("voice mode, step by step", () => {
  it("listens, sends what was said once the person pauses, reads the answer aloud, and listens again", () => {
    const { s, effects } = walk([
      { type: "start", running: false, asking: false, at: 0 },
      { type: "listening", route: "onDevice" },
      { type: "heard", text: "how many", at: 100 },
      { type: "heard", text: "how many orders today", at: 900 },
      { type: "tick", at: 900 + PAUSE_MS - 1 },
    ]);
    expect(s.phase).toBe("listening");
    expect(s.heard).toBe("how many orders today");
    expect(effects).toEqual([{ type: "listen" }]);

    const paused = walk([{ type: "tick", at: 900 + PAUSE_MS }], s);
    expect(paused.s.phase).toBe("finishing");
    expect(paused.types).toEqual(["finish"]);

    // the last words come, the recognition ends, and what was said goes as the message
    const sent = walk([{ type: "heard", text: "How many orders today?", at: 3000 }, { type: "ended", at: 3100 }], paused.s);
    expect(sent.s.phase).toBe("waiting");
    expect(sent.effects).toEqual([{ type: "mark" }, { type: "send", text: "How many orders today?" }]);

    // the turn has not started yet: nothing is read; then it runs, then it ends with an answer
    const answered = walk([chat(false, false, null), chat(true, false, null), chat(true, false, "**Three** orders."), chat(false, false, "**Three** orders.")], sent.s);
    expect(answered.s.phase).toBe("speaking");
    expect(answered.effects).toEqual([{ type: "speak", text: "Three orders." }]);

    const again = walk([{ type: "spoken" }], answered.s);
    expect(again.s.phase).toBe("starting");
    expect(again.effects).toEqual([{ type: "listen" }]);
  });

  it("sends nothing while the person has said nothing, however long the silence", () => {
    const { s, types } = walk([
      { type: "start", running: false, asking: false, at: 0 },
      { type: "listening", route: "onDevice" },
      { type: "tick", at: 60_000 },
      { type: "heard", text: "  ", at: 61_000 },
      { type: "tick", at: 90_000 },
    ]);
    expect(s.phase).toBe("listening");
    expect(types).toEqual(["listen"]);
    // the recognizer's own end with nothing heard: it listens again, and sends nothing
    const ended = walk([{ type: "ended", at: 91_000 }], s);
    expect(ended.types).toEqual(["listen"]);
  });

  it("never answers an ask by voice: it stops listening, says so, and waits for the card", () => {
    const listening = walk([
      { type: "start", running: false, asking: false, at: 0 },
      { type: "listening", route: "onDevice" },
      { type: "heard", text: "yes do it", at: 10 },
    ]).s;
    const asked = walk([chat(true, true, null)], listening);
    expect(asked.s.phase).toBe("paused");
    // what was heard is dropped, never sent: the ask is decided with its card
    expect(asked.effects).toEqual([{ type: "drop" }, { type: "announceAsk" }]);
    expect(asked.s.heard).toBe("");
    // while it waits, nothing heard and no clock sends anything
    const still = walk([{ type: "heard", text: "approve", at: 20 }, { type: "tick", at: 99_000 }, { type: "ended", at: 99_001 }, chat(true, true, null)], asked.s);
    expect(still.s.phase).toBe("paused");
    expect(still.effects).toEqual([]);
    // decided on the card: the agent goes on, its answer is read, then it listens
    const decided = walk([chat(true, false, null), chat(false, false, "Done. I sent the message.")], still.s);
    expect(decided.types).toEqual(["speak"]);
    expect(decided.s.phase).toBe("speaking");
  });

  it("stops reading aloud when an ask comes, and when started over an ask it waits for it first", () => {
    const speaking = walk([chat(false, false, "Here is the plan.")], { ...OFF, phase: "waiting", sawRun: true }).s;
    expect(speaking.phase).toBe("speaking");
    const asked = walk([chat(true, true, "Here is the plan.")], speaking);
    expect(asked.effects).toEqual([{ type: "hush" }, { type: "announceAsk" }]);

    const started = walk([{ type: "start", running: true, asking: true, at: 0 }]);
    expect(started.s.phase).toBe("paused");
    expect(started.types).toEqual(["mark", "announceAsk"]);
  });

  it("started while a turn runs, it reads that answer when it lands, then listens", () => {
    const { s, types } = walk([{ type: "start", running: true, asking: false, at: 0 }, chat(true, false, null), chat(false, false, "Done.")]);
    expect(types).toEqual(["mark", "speak"]);
    expect(s.phase).toBe("speaking");
  });

  it("a message sent from the box by hand while it listens: it stops listening and reads that answer", () => {
    const listening = walk([{ type: "start", running: false, asking: false, at: 0 }, { type: "listening", route: "apple" }]).s;
    const { s, types } = walk([chat(true, false, null)], listening);
    expect(types).toEqual(["drop", "mark"]);
    expect(s.phase).toBe("waiting");
  });

  it("listens again when no answer comes, and says so", () => {
    const sent = walk([{ type: "start", running: false, asking: false, at: 0 }, { type: "listening", route: "onDevice" }, { type: "heard", text: "hi", at: 0 }, { type: "ended", at: 10 }]).s;
    // the turn ran and ended with no answer to read
    const empty = walk([chat(true, false, null), chat(false, false, null)], sent);
    expect(empty.types).toEqual(["listen"]);
    expect(empty.s.note).toBe("noAnswer");
    // the turn never started (the send failed): after a while it listens again
    const never = walk([{ type: "tick", at: 10 + WAIT_START_MS - 1 }], sent);
    expect(never.s.phase).toBe("waiting");
    expect(walk([{ type: "tick", at: 10 + WAIT_START_MS }], sent).types).toEqual(["listen"]);
    // an answer of code alone has nothing to read aloud: it listens again, with no note
    const code = walk([chat(true, false, null), chat(false, false, "```\nls -la\n```")], sent);
    expect(code.types).toEqual(["listen"]);
    expect(code.s.note).toBeNull();
  });

  it("one press stops it from any state, and a refusal ends it with words for it", () => {
    for (const phase of ["starting", "listening", "finishing", "waiting", "speaking", "paused"] as const) {
      const r = step({ ...OFF, phase }, { type: "stop" });
      expect(r.state).toEqual(OFF);
      expect(r.effects).toEqual([{ type: "drop" }, { type: "hush" }]);
    }
    expect(step(OFF, { type: "stop" }).effects).toEqual([]);
    const refused = walk([{ type: "start", running: false, asking: false, at: 0 }, { type: "failed", why: "apple-not-allowed" }]);
    expect(refused.s).toEqual({ ...OFF, note: "apple-not-allowed" });
    const broke = walk([{ type: "start", running: false, asking: false, at: 0 }, { type: "listening", route: "onDevice" }, { type: "ended", error: "failed:x:1", at: 5 }]);
    expect(broke.s).toEqual({ ...OFF, note: "failed" });
  });
});

describe("voice mode, run with stand-ins", () => {
  function rig(opts: { mouth?: boolean } = {}) {
    let clockFn: (() => void) | null = null;
    let now = 0;
    const calls: string[] = [];
    let live: HearCallbacks | null = null;
    let speaking: (() => void) | null = null;
    const answers: { id: string; text: string }[] = [{ id: "a0", text: "an older answer" }];
    const ears: Ears = {
      status: async (lang) => ({ lang, supported: true, available: true, onDevice: true, speech: "allowed", mic: "allowed" }),
      listen: async (lang, apple, on) => {
        calls.push(`listen ${lang}${apple ? " apple" : ""}`);
        live = on;
        return {
          route: "onDevice",
          stop: () => {
            calls.push("finish");
            live?.heard("What sold best this week?", true);
            const l = live;
            live = null;
            l?.ended();
          },
          cancel: () => {
            calls.push("drop");
            live = null;
          },
        };
      },
    };
    const mouth: Mouth = {
      voices: () => [],
      speak: (text, lang, voice, done) => {
        calls.push(`speak ${lang} ${voice ?? "default"}: ${text}`);
        speaking = done;
      },
      cancel: () => {
        calls.push("hush");
        speaking = null;
      },
    };
    const mode = createVoiceMode({
      ears,
      mouth: opts.mouth === false ? null : mouth,
      lang: () => "th-TH",
      apple: () => false,
      voice: () => "com.apple.voice.compact.th-TH.Kanya",
      send: (text) => calls.push(`send ${text}`),
      answers: () => answers,
      announceAsk: () => calls.push("announce"),
      onView: () => {},
      now: () => now,
      every: (fn, ms) => {
        expect(ms).toBe(TICK_MS);
        clockFn = fn;
        return () => void (clockFn = null);
      },
    });
    const tickTo = (t: number) => {
      now = t;
      clockFn?.();
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { mode, calls, answers, tickTo, flush, say: (t: string) => live?.heard(t, false), doneSpeaking: () => speaking?.(), clockOn: () => clockFn !== null };
  }

  it("goes round once: listens, sends at the pause, reads only the new answer with the chosen voice, listens again", async () => {
    const r = rig();
    r.mode.chat(false, false);
    r.mode.start();
    await r.flush();
    expect(r.mode.state.phase).toBe("listening");
    r.say("What sold");
    r.tickTo(500);
    r.say("What sold best this week");
    r.tickTo(1_000);
    r.tickTo(1_000 + PAUSE_MS);
    expect(r.calls).toEqual(["listen th-TH", "finish", "send What sold best this week?"]);
    expect(r.mode.state.phase).toBe("waiting");
    r.mode.chat(true, false);
    r.answers.push({ id: "a1", text: "Iced coffee sold best: **42** cups." });
    r.mode.chat(false, false);
    expect(r.calls.at(-1)).toBe("speak th-TH com.apple.voice.compact.th-TH.Kanya: Iced coffee sold best: 42 cups.");
    r.doneSpeaking();
    await r.flush();
    expect(r.calls.at(-1)).toBe("listen th-TH");
    expect(r.mode.state.phase).toBe("listening");
    r.mode.stop();
    expect(r.calls.slice(-2)).toEqual(["drop", "hush"]);
    expect(r.clockOn()).toBe(false);
  });

  it("an ask pauses it with a spoken notice, and nothing heard meanwhile is sent", async () => {
    const r = rig();
    r.mode.start();
    await r.flush();
    r.say("go ahead");
    r.mode.chat(true, true);
    expect(r.calls).toEqual(["listen th-TH", "drop", "announce"]);
    r.tickTo(60_000);
    expect(r.calls.filter((c) => c.startsWith("send"))).toEqual([]);
    expect(r.mode.state.phase).toBe("paused");
  });

  it("with no voice to read with, the answer stays on screen and it listens again", async () => {
    const r = rig({ mouth: false });
    r.mode.chat(true, false);
    r.mode.start();
    r.answers.push({ id: "a1", text: "Done." });
    r.mode.chat(false, false);
    await r.flush();
    await r.flush();
    expect(r.calls).toEqual(["listen th-TH"]);
  });
});
