// Rewind to before a turn, on the line under a coding session's box (the design canvas's StatesCodeDev "Rewind",
// rewind.ts), beside the branch as the canvas's Code board puts "Revert this turn" beside it: pick a turn, read what
// goes back, and press Rewind once. The files and the chat go back together. A file changed by hand
// since that turn is listed and kept unless the person unticks it, and a turn that pushed or published says that
// rewinding does not take that back.
import { useEffect, useState, useSyncExternalStore } from "react";
import { t } from "../i18n";
import { Popover } from "../ui";
import { useStore } from "../state/store";
import { getSessions, useSessions } from "./sessions";
import type { SessionRec } from "./agents";
import type { TurnPreview } from "./turnFiles";
import { REWINDS, rewindable, RewindError, wentLive, whyNotText, whyText, type RewindTurn, type WhyNot } from "./rewind";
import "./rewind.css";
import { Icon } from "../ui/icons";

export interface RewindPanelProps {
  /** the turns that can be rewound, newest first */
  turns: RewindTurn[];
  picked: string | null;
  /** what rewinding to before the picked turn would do, once read */
  preview: TurnPreview | null;
  /** the preview is being read */
  loading: boolean;
  /** a step since the picked turn pushed or published */
  live: boolean;
  /** files changed by hand that stay as they are */
  keep: string[];
  /** the rewind is under way */
  busy: boolean;
  /** a turn is running: nothing rewinds until it ends */
  running: boolean;
  /** what went wrong, in words */
  error: string;
  /** why the newest turn could not be kept */
  whyNot?: WhyNot;
  onPick: (id: string) => void;
  onKeep: (path: string, keep: boolean) => void;
  onRewind: () => void;
}

/** What the picked turn's rewind would do: how many files go back, the files changed by hand (each kept unless
 *  unticked), and what does not go back. */
function Details(p: RewindPanelProps) {
  if (p.loading || !p.preview) return p.loading ? <p className="rw-mut">{t("rw.to.reading")}</p> : null;
  const v = p.preview;
  const n = v.back.length;
  return (
    <>
      <p className="rw-count" data-testid="rewind-count">
        {n === 0 ? t("rw.to.chatOnly") : n === 1 ? t("rw.to.files1") : t("rw.to.filesN", { n })}
      </p>
      {v.hand.length > 0 && (
        <div className="rw-hand" data-testid="rewind-hand">
          <p className="rw-mut">{t("rw.to.hand")}</p>
          {v.hand.map((path) => (
            <label key={path} className="rw-file">
              <input type="checkbox" checked={p.keep.includes(path)} onChange={(e) => p.onKeep(path, e.currentTarget.checked)} data-testid="rewind-keep" />
              <span className="rw-path">{path}</span>
            </label>
          ))}
        </div>
      )}
      {v.tooBig > 0 && <p className="rw-mut">{v.tooBig === 1 ? t("rw.to.tooBig1") : t("rw.to.tooBigN", { n: v.tooBig })}</p>}
      {v.headMoved && (
        <p className="rw-note" data-testid="rewind-branch">
          {t("rw.to.branch")}
        </p>
      )}
    </>
  );
}

/** The panel, drawn from its props (no hooks), as the canvas draws it. */
export function RewindPanelView(p: RewindPanelProps) {
  const has = p.turns.length > 0;
  return (
    <div className="rw-panel" data-testid="rewind-panel">
      <span className="rw-lab">{t("rw.to.title")}</span>
      {has && (
        <div role="radiogroup" aria-label={t("rw.to.title")} className="rw-turns">
          {p.turns.map((x) => (
            <button key={x.id} type="button" className="rw-turn" role="radio" aria-checked={x.id === p.picked} title={x.title} onClick={() => p.onPick(x.id)} data-testid="rewind-turn">
              <span>{x.title}</span>
            </button>
          ))}
        </div>
      )}
      {p.whyNot && (
        <p className="rw-note" data-testid="rewind-why">
          {whyNotText(p.whyNot)}
        </p>
      )}
      {has && <p className="rw-mut">{t("rw.to.together")}</p>}
      {has && <Details {...p} />}
      {has && p.live && (
        <p className="rw-note" data-testid="rewind-live">
          {t("rw.to.live")}
        </p>
      )}
      {has && p.running && <p className="rw-mut">{t("rw.to.wait")}</p>}
      {p.error && (
        <p className="rw-err" role="alert" data-testid="rewind-error">
          {p.error}
        </p>
      )}
      {has && (
        <div>
          <button type="button" className="rw-go" disabled={p.busy || p.loading || p.running || !p.picked || !p.preview} onClick={p.onRewind} data-testid="rewind-go">
            {p.busy ? t("rw.to.going") : t("rw.to.go")}
          </button>
        </div>
      )}
    </div>
  );
}

const RewindIcon = () => <Icon name="rotate-ccw" />;

/** The Rewind chip and its panel, for a running coding session whose agent can take its chat back. Shows only once a
 *  turn can be rewound, or the folder's files could not be kept (the panel then says why). */
export function RewindButton({ rec }: { rec: SessionRec }) {
  const s = useStore();
  const ss = useSessions();
  const book = getSessions().turns;
  const bs = useSyncExternalStore(book.subscribe, book.getState, book.getState);
  const chatKey = getSessions().chatKey(rec.id);
  const chat = chatKey ? s.chats[chatKey] : undefined;
  const items = chat?.items ?? [];
  const turns = rewindable(items, bs.marks[rec.id] ?? []);
  const whyNot = bs.whyNot[rec.id];
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [preview, setPreview] = useState<TurnPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [keep, setKeep] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // the newest turn until the person picks one; a pick an earlier rewind took away falls back to it too
  const picked = chosen && turns.some((x) => x.id === chosen) ? chosen : (turns[0]?.id ?? null);
  const running = !!chat?.turn;
  const steps = items.length;
  useEffect(() => {
    if (!open || !picked) {
      setPreview(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError("");
    book.preview(rec.id, picked).then(
      (p) => {
        if (!current) return;
        setPreview(p);
        // a file changed by hand stays as it is unless the person unticks it
        setKeep(p.hand);
        setLoading(false);
      },
      (e) => {
        if (!current) return;
        setPreview(null);
        setError(whyText(e));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
    // a new turn or a rewind changes what goes back: read it again
  }, [open, picked, rec.id, steps, book]);
  // an agent that ended can take nothing back, and its next process starts with no turn kept
  if (!REWINDS.includes(rec.agent) || rec.status !== "running" || (!turns.length && !whyNot)) return null;
  // read only while the panel is open: this line draws again with every word of an answer
  const live = open && picked ? wentLive(items, picked, { cwd: rec.cwd, root: rec.cwd, home: ss.home ?? undefined, branch: ss.live[rec.id]?.branch || undefined }) : false;
  const rewind = async () => {
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      await getSessions().rewindTo(rec.id, picked, keep);
      setOpen(false);
      setChosen(null);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(e instanceof RewindError && !e.filesBack ? t("rw.to.stuck", { error: why }) : t("rw.to.failed", { error: why }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rw-wrap">
      <button type="button" className={`rw-open${open ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={open} title={t("rw.to.tip")} onClick={() => setOpen((v) => !v)} data-testid="rewind-open">
        <RewindIcon />
        <span>{t("rw.to.go")}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} side="top" align="left" width={320} label={t("rw.to.title")} className="rw-pop">
        <RewindPanelView
          turns={turns}
          picked={picked}
          preview={preview}
          loading={loading}
          live={live}
          keep={keep}
          busy={busy}
          running={running}
          error={error}
          whyNot={whyNot}
          onPick={(id) => setChosen(id)}
          onKeep={(path, on) => setKeep((k) => (on ? [...k.filter((x) => x !== path), path] : k.filter((x) => x !== path)))}
          onRewind={() => void rewind()}
        />
      </Popover>
    </div>
  );
}
