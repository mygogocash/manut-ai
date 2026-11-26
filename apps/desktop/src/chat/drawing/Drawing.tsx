// A drawing in the chat: Show drawing under an html or svg code block of a finished answer, the card it opens, and Open
// larger's sheet. The safety model heads drawingDoc.ts (and docs/security/chat-drawings.md); this file keeps the parts
// of it that are the card's: the frame is always inside a card the app draws, and only a finished answer in a chat's
// timeline offers one, since only Timeline.tsx passes `drawingsBy` to Bubble.tsx and only Bubble.tsx passes it on to
// Markdown.tsx (point 7); nothing is drawn until the person presses Show (the default); at most a few frames are live and
// one far out of view goes (point 8); and the app listens to nothing from a frame and gives it nothing but its own
// document (point 6: no `message` listener here).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";
import { Icon } from "../../ui/icons";
import { BOX_DEFAULT, DRAWING_SANDBOX, FAR_AWAY_PX, boxHeight, innerDoc, outerDoc, tooBig } from "./drawingDoc";
import { prepareDrawing } from "./sanitize";
import { claimLive, releaseLive, useLive } from "./live";
import "./drawing.css";
import { prefersReducedMotion } from "../../lib/reducedMotion";


/** The nearest box that scrolls the card: the chat's timeline. "Far out of view" is measured against it. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return null;
}

/** A code block that may be a drawing: the block as it was, then Show drawing (or why not), then the card once pressed. */
export function DrawableCode({ code, by, children }: { code: string; by: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  const big = tooBig(code);
  return (
    <div className="dw-code" data-testid="drawing-code">
      {children}
      <div className="dw-row">
        {big ? (
          <span className="dw-why" data-testid="drawing-too-big">
            {t("dw.tooBig")}
          </span>
        ) : (
          <button type="button" className="dw-btn" aria-expanded={shown} onClick={() => setShown((s) => !s)} data-testid="drawing-show">
            <Icon name={shown ? "eye-off" : "eye"} />
            {shown ? t("dw.hide") : t("dw.show")}
          </button>
        )}
      </div>
      {shown && !big && <DrawingCard code={code} by={by} />}
    </div>
  );
}

/** The closed box itself: a white page in a lined box, its height the drawing's own shape at the box's width, or the
 *  default with scrolling inside; in the sheet it fills what the sheet gives it. */
function Frame({ doc, title, ratio, fill }: { doc: string; title: string; ratio: number | null; fill?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(BOX_DEFAULT);
  useLayoutEffect(() => {
    const el = box.current;
    if (fill || ratio === null || !el) return;
    const fit = () => setHeight(boxHeight(ratio, el.clientWidth));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio, fill]);
  return (
    <div ref={box} className={`dw-box${fill ? " fill" : ""}`}>
      <iframe
        className="dw-frame"
        sandbox={DRAWING_SANDBOX}
        srcDoc={doc}
        title={title}
        referrerPolicy="no-referrer"
        style={fill ? undefined : { height }}
        data-testid="drawing-frame"
      />
    </div>
  );
}

/** The card: the app's own band ("Drawn by <name>", Open larger), the line that says what the box is, and the box, or a
 *  still card with Show when it is not live, or why it cannot be shown. */
export function DrawingCard({ code, by }: { code: string; by: string }) {
  const id = useId();
  const title = t("dw.title", { name: by });
  const prepared = useMemo(() => prepareDrawing(code, { reduceMotion: prefersReducedMotion() }), [code]);
  const doc = useMemo(() => (prepared.ok ? outerDoc(innerDoc(prepared.parts), title) : null), [prepared, title]);
  const live = useLive(id);
  const [larger, setLarger] = useState(false);
  const closeLarger = useCallback(() => setLarger(false), []);
  const ref = useRef<HTMLElement>(null);
  const largerButton = useRef<HTMLButtonElement>(null);

  // pressed Show: live at once; the card going (Hide, the answer leaving, the chat closing) gives its place back
  useEffect(() => {
    if (doc) claimLive(id);
    return () => releaseLive(id);
  }, [id, doc]);

  // far out of the chat's view: the frame goes and the card stands still until Show is pressed again
  useEffect(() => {
    const el = ref.current;
    if (!el || !live || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((seen) => seen.some((e) => !e.isIntersecting) && releaseLive(id), {
      root: scrollParent(el),
      rootMargin: `${FAR_AWAY_PX}px 0px`,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [id, live]);

  return (
    <section ref={ref} className="dw-card" aria-label={title} data-testid="drawing-card" data-live={live || undefined}>
      <div className="dw-band">
        <span className="dw-by">{t("dw.by", { name: by })}</span>
        {doc && (
          <button ref={largerButton} type="button" className="dw-lk" onClick={() => setLarger(true)} data-testid="drawing-larger">
            {t("dw.larger")}
          </button>
        )}
      </div>
      <div className="dw-note" data-testid="drawing-note">
        <Icon name="lock" />
        {t("dw.closed")}
      </div>
      {!prepared.ok ? (
        <div className="dw-still" data-testid="drawing-refused" data-why={prepared.why}>
          {prepared.why === "empty" ? t("dw.empty") : prepared.why === "too_many" ? t("dw.tooMany") : t("dw.unsafe")}
        </div>
      ) : live && doc ? (
        <Frame doc={doc} title={title} ratio={prepared.parts.ratio} />
      ) : (
        <div className="dw-still" data-testid="drawing-still">
          <span>{t("dw.still")}</span>
          <button type="button" className="dw-btn" onClick={() => claimLive(id)} data-testid="drawing-again">
            <Icon name="eye" />
            {t("dw.again")}
          </button>
        </div>
      )}
      {prepared.ok && prepared.parts.hadScripts && (
        <div className="dw-note" data-testid="drawing-no-scripts">
          {t("dw.noScripts")}
        </div>
      )}
      {larger && doc && <DrawingSheet doc={doc} by={by} onClose={closeLarger} back={largerButton} />}
    </section>
  );
}

/** Open larger: the same closed box in a sheet of the app's own over the window, with the same band and line. Escape,
 *  Close or a press outside closes it, and the focus goes back to Open larger (WebKit does not focus a button a mouse
 *  pressed, so the element focused before the sheet is not always it). */
function DrawingSheet({ doc, by, onClose, back: opener }: { doc: string; by: string; onClose: () => void; back: { current: HTMLElement | null } }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = opener.current ?? (document.activeElement as HTMLElement | null);
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (back && document.contains(back)) back.focus();
    };
  }, [onClose, opener]);
  const title = t("dw.title", { name: by });
  // on <body>: the thread scrolls and is masked, which would clip a fixed overlay inside it
  return createPortal(
    <div className="dw-back" data-testid="drawing-sheet-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dw-sheet" role="dialog" aria-modal="true" aria-label={title} data-testid="drawing-sheet">
        <div className="dw-band">
          <span className="dw-by">{t("dw.by", { name: by })}</span>
          <button ref={close} type="button" className="dw-x" aria-label={t("dw.close")} title={t("dw.close")} onClick={onClose} data-testid="drawing-sheet-close">
            <Icon name="x" />
          </button>
        </div>
        <div className="dw-note">
          <Icon name="lock" />
          {t("dw.closed")}
        </div>
        <Frame doc={doc} title={title} ratio={null} fill />
      </div>
    </div>,
    document.body,
  );
}
