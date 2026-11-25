// The chat box's microphone (item 81): press it, speak, and the words appear in the message's text as they are heard,
// to be read and corrected before sending. Nothing is sent by itself. Press again or Esc to stop (the words stay);
// typing, sending or leaving the chat drops the listening at once, and what is already in the box stays as it is.
// A controller over the Ears interface (engine.ts), so mic.test.ts drives it with a stand-in instead of a microphone.
import type { Ears, Hearing } from "./engine";
import { refusalOf, withHeard, type Refusal, type Route, type Spoken } from "./voice";

export type MicView = { kind: "off" } | { kind: "starting" } | { kind: "listening"; route: Route } | { kind: "stopping"; route: Route };

export interface MicDeps {
  ears: Ears;
  /** The box's text now. */
  text(): string;
  /** Put text in the box (the words heard after what was typed). */
  setText(text: string): void;
  onView(view: MicView): void;
  /** Why listening did not start, or stopped with nothing heard. */
  onRefusal(why: Refusal): void;
}

export function createMic(d: MicDeps) {
  let view: MicView = { kind: "off" };
  let hearing: Hearing | null = null;
  // each start is a session of its own: callbacks of one that was dropped are ignored
  let session = 0;
  const set = (v: MicView) => {
    view = v;
    d.onView(v);
  };
  const cancel = () => {
    if (view.kind === "off") return;
    session += 1;
    hearing?.cancel();
    hearing = null;
    set({ kind: "off" });
  };
  return {
    get view(): MicView {
      return view;
    },
    /** Listen in `lang`, on this Mac or (`apple`, the person's yes) through Apple's servers. The caller has decided. */
    async start(lang: Spoken, apple: boolean): Promise<void> {
      if (view.kind !== "off") return;
      const mine = ++session;
      // what was typed before the press stays in front of the words
      const base = d.text();
      let heardAny = false;
      set({ kind: "starting" });
      try {
        const h = await d.ears.listen(lang, apple, {
          heard(words) {
            if (mine !== session) return;
            heardAny ||= words.trim().length > 0;
            d.setText(withHeard(base, words));
          },
          ended(error) {
            if (mine !== session) return;
            session += 1;
            hearing = null;
            set({ kind: "off" });
            if (!heardAny) d.onRefusal(error ? refusalOf(error) : "nothing");
          },
        });
        if (mine !== session) {
          // dropped while it was starting (typing, sending, leaving)
          h.cancel();
          return;
        }
        hearing = h;
        set({ kind: "listening", route: h.route });
      } catch (e) {
        if (mine !== session) return;
        session += 1;
        set({ kind: "off" });
        d.onRefusal(refusalOf(e));
      }
    },
    /** Press again, or Esc: finish listening; the last words come and stay in the box. */
    stop(): void {
      if (view.kind === "listening" && hearing) {
        set({ kind: "stopping", route: view.route });
        hearing.stop();
      } else if (view.kind === "starting") cancel();
    },
    /** Typing, sending, leaving the chat: stop at once, keeping what is in the box. */
    cancel,
  };
}

export type Mic = ReturnType<typeof createMic>;
