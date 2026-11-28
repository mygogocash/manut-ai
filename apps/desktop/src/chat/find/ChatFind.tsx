// The find bar of a chat (item 150), modelled on the terminal's (sessions/term/find-bar.tsx): a field, "3 of 12",
// Match case (Aa, Alt+C), Previous, Next and Close, at the top right of the chat's column only while it is open, so a
// closed bar covers nothing. Enter and Shift+Enter move between the matches; Esc closes it and gives the keyboard back to
// the chat box. It finds across the chat's messages and its steps, folded groups included (finder.ts, read.ts), paints
// each match without touching the messages (paint.ts) and keeps nothing: what was typed goes with the bar, and nothing
// is sent anywhere.
//
// `FindBarView` draws from props alone, so a test draws each state; `ChatFind` is what a timeline mounts.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKey, type RefObject } from "react";
import { flushSync } from "react-dom";
import "../../sessions/term/find.css";
import "./find.css";
import { ChevronDown, CloseIcon } from "../../ui";
import { composing } from "../../lib/ime";
import { t } from "../../i18n";
import { findCountText } from "../../sessions/term/find-bar";
import { findOptionKey, isFindKey } from "../../sessions/term/engine-input";
import { isMacPlatform } from "../../sessions/term/engine-links";
import type { FindResults } from "../../sessions/term/engine-find";
import { makeChatFinder, type ChatFinder } from "./finder";
import { forceOpen, setFinding } from "./folds";
import { registerFindHost, usedFindHost, type FindHost } from "./host";
import { bringIntoView, makePainter, rangeOf, topBlock } from "./paint";
import { readBlocks, type ElLike } from "./read";
import { FIND_PLAIN, type FindOptions } from "./text";

/** What Match case shows: the letters themselves, the same in every language, as the terminal's bar has it. */
const CASE_GLYPH = "Aa";

export interface FindBarViewProps {
  text: string;
  options: FindOptions;
  results: FindResults;
  inputRef?: RefObject<HTMLInputElement | null>;
  layerRef?: RefObject<HTMLDivElement | null>;
  onText: (text: string) => void;
  onCase: () => void;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}

export function FindBarView(p: FindBarViewProps) {
  const none = !p.text || p.results.count === 0;
  return (
    <>
      <div
        className="tfind cfind"
        role="search"
        aria-label={t("find.chatLabel")}
        data-testid="chat-find"
        onKeyDown={(e) => {
          // Esc closes from the field and from a button the person clicked last, and is not the running answer's Stop
          if (e.key === "Escape" && !composing(e)) {
            e.preventDefault();
            e.stopPropagation();
            p.onClose();
            return;
          }
          if (!composing(e) && findOptionKey(e) === "caseSensitive") {
            e.preventDefault();
            e.stopPropagation();
            p.onCase();
          }
        }}
      >
        <input
          ref={p.inputRef}
          type="text"
          className="tfind-q"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={t("find.placeholder")}
          aria-label={t("find.chatLabel")}
          value={p.text}
          data-testid="chat-find-input"
          onChange={(e) => p.onText(e.target.value)}
          onKeyDown={(e: ReactKey<HTMLInputElement>) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!composing(e) && p.text) p.onStep(e.shiftKey ? -1 : 1);
            } else if (isFindKey(e.nativeEvent, isMacPlatform(), false)) {
              // find again while the bar is open: back to its field, with what is in it selected
              e.preventDefault();
              e.currentTarget.select();
            }
          }}
        />
        <span className="tfind-n" aria-live="polite" data-testid="chat-find-count">
          {findCountText(p.results, p.text)}
        </span>
        <button
          type="button"
          className="tfind-b tfind-opt"
          aria-label={t("find.matchCase")}
          title={t("find.matchCaseTip")}
          aria-pressed={p.options.caseSensitive}
          // a click leaves the keyboard in the field, so Enter goes on to the next match
          onMouseDown={(e) => e.preventDefault()}
          onClick={p.onCase}
          data-testid="chat-find-case"
        >
          {CASE_GLYPH}
        </button>
        <button type="button" className="tfind-b" aria-label={t("find.prev")} title={t("find.prev")} disabled={none} onClick={() => p.onStep(-1)} data-testid="chat-find-prev">
          <span className="tfind-up">
            <ChevronDown />
          </span>
        </button>
        <button type="button" className="tfind-b" aria-label={t("find.next")} title={t("find.next")} disabled={none} onClick={() => p.onStep(1)} data-testid="chat-find-next">
          <ChevronDown />
        </button>
        <button type="button" className="tfind-b" aria-label={t("find.close")} title={t("find.close")} onClick={p.onClose} data-testid="chat-find-close">
          <CloseIcon />
        </button>
      </div>
      {/* the boxes of a web view with no highlights (paint.ts); empty, and out of everyone's way, where it has them */}
      <div className="cf-layer" ref={p.layerRef} aria-hidden="true" />
    </>
  );
}

/** The one short line of the chat that is selected, which is what the person most likely wants to find. */
function selected(root: HTMLElement | null): string {
  const sel = typeof document === "undefined" ? null : document.getSelection();
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount || !root.contains(sel.getRangeAt(0).commonAncestorContainer)) return "";
  const s = sel.toString();
  return s && s.length <= 200 && !/[\r\n]/.test(s) ? s : "";
}

const look = (el: ElLike) => {
  const s = getComputedStyle(el as unknown as Element);
  return { display: s.display, visibility: s.visibility };
};

function FindBar({ chat, scroller, hold, onClose, again }: { chat: string; scroller: RefObject<HTMLDivElement | null>; hold: RefObject<(() => void) | undefined>; onClose: () => void; again: RefObject<(() => void) | null> }) {
  const input = useRef<HTMLInputElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const finder = useRef<ChatFinder | null>(null);
  const [text, setText] = useState(() => selected(scroller.current));
  const [options, setOptions] = useState<FindOptions>(FIND_PLAIN);
  const [results, setResults] = useState<FindResults>({ index: -1, count: 0, capped: false });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let gone = false;
    const painter = makePainter(el, layer.current);
    const f = makeChatFinder({
      read: () => readBlocks(el as unknown as ElLike, { look }),
      top: (blocks) => topBlock(el, blocks),
      // a group held open is drawn at once, so its match can be measured and scrolled to; a bar being torn down is not
      // the time to draw anything (React draws while it commits), and the groups only go back to the person's own state
      fold: (ids) => (gone ? forceOpen(ids) : flushSync(() => forceOpen(ids))),
      paint: (blocks, matches, current) => painter.paint(blocks, matches, current),
      show: (block, match) => {
        const r = rangeOf(block, match.start, match.end);
        const moved = r ? bringIntoView(el, r) : false;
        // Looking at an older match, or in a group the find opened, is the person's own move away from the bottom: the column
        // stops following new messages until they scroll back down. A match already in view, in the open, leaves the view as it
        // was, so a person at the bottom stays there.
        if (moved || block.fold) hold.current?.();
      },
    });
    finder.current = f;
    const off = f.onResults(setResults);
    again.current = () => {
      input.current?.focus();
      input.current?.select();
    };
    again.current();

    // the chat changes while the bar is open (a message, an answer growing): read it again, a moment after it stops moving
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reread = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        f.refresh();
      }, 120);
    };
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(reread);
    mo?.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "open"] });
    // boxes lie over the page and have to follow it; the browser's own highlights follow it by themselves
    let frame = 0;
    const redraw = () => {
      if (painter.kind !== "boxes" || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        f.repaint();
      });
    };
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(redraw);
    ro?.observe(el);
    el.addEventListener("scroll", redraw, { passive: true });

    // The first read and search wait for this commit to end: the folded groups were drawn hidden in the same pass as the
    // bar, and a search that opens one draws the page again, which React does not do from inside a commit.
    const first = text;
    queueMicrotask(() => {
      if (gone) return;
      f.refresh();
      if (first) f.search(first, FIND_PLAIN);
    });

    return () => {
      gone = true;
      if (timer) clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      mo?.disconnect();
      ro?.disconnect();
      el.removeEventListener("scroll", redraw);
      off();
      f.dispose();
      painter.clear();
      finder.current = null;
      again.current = null;
      setFinding(chat, false);
    };
    // the bar is made once for its chat; what is typed after goes through the handlers below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);

  const close = () => {
    const pane = scroller.current?.parentElement;
    onClose();
    // the keyboard goes back to the chat box, or to the timeline itself in a view with no box (a job's side by side)
    (pane?.querySelector<HTMLElement>("[data-testid=composer]:not(:disabled)") ?? scroller.current)?.focus();
  };
  const flip = () => {
    const next = { caseSensitive: !options.caseSensitive };
    setOptions(next);
    finder.current?.search(text, next);
  };

  return (
    <FindBarView
      text={text}
      options={options}
      results={results}
      inputRef={input}
      layerRef={layer}
      onText={(v) => {
        setText(v);
        finder.current?.search(v, options);
      }}
      onCase={flip}
      onStep={(dir) => finder.current?.step(dir)}
      onClose={close}
    />
  );
}

/** Mounted by every timeline (chat/parts/Timeline.tsx). It registers the chat as a place ⌘F can open a bar in (host.ts),
 *  and draws the bar while it is open. `hold` tells the timeline to stop following new messages. */
export function ChatFind({ chat, scroller, hold }: { chat: string; scroller: RefObject<HTMLDivElement | null>; hold?: () => void }) {
  // the chat the bar was opened for: another chat in the same timeline has no bar, and the old one goes with its chat
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === chat;
  const isOpen = useRef(false);
  isOpen.current = open;
  const again = useRef<(() => void) | null>(null);
  const holdRef = useRef(hold);
  holdRef.current = hold;
  useEffect(() => {
    const root = () => scroller.current?.parentElement ?? null;
    const host: FindHost = {
      holds: (n) => !!n && !!root()?.contains(n),
      shown: () => (root()?.getClientRects().length ?? 0) > 0,
      open: () => {
        if (isOpen.current) return again.current?.();
        // the bar and the activity lines' hidden steps are drawn in one pass, so the bar finds them the moment it reads
        flushSync(() => {
          setFinding(chat, true);
          setOpenFor(chat);
        });
      },
      close: () => setOpenFor(null),
      isOpen: () => isOpen.current,
    };
    const off = registerFindHost(host);
    const el = root();
    const used = () => usedFindHost(host);
    el?.addEventListener("pointerdown", used, true);
    el?.addEventListener("focusin", used, true);
    return () => {
      off();
      el?.removeEventListener("pointerdown", used, true);
      el?.removeEventListener("focusin", used, true);
    };
  }, [chat, scroller]);
  if (!open) return null;
  return <FindBar key={chat} chat={chat} scroller={scroller} hold={holdRef} onClose={() => setOpenFor(null)} again={again} />;
}
