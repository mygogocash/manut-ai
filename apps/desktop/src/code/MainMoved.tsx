// "main changed while Kit worked. 1 file needs both changes." with the files, Let Kit merge and Show me both (the canvas's
// StatesCodeDev board, "The main branch moved"): the Code page's note for a project whose lane started from a branch that
// has since changed the files the lane changed. `MainMovedView` takes everything it shows as props and uses no hooks, so a
// test can draw it; `MainMoved` reads the project's git and sends the ask.
import "./kit.css";
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { DiffView } from "../chat/activity/Work";
import { getHost } from "../sessions/host";
import { getSessions } from "../sessions/sessions";
import { getStore } from "../state/store";
import { askKit } from "./askKit";
import { mergeAsk, readSides, type Moved, type Side, type SideFile } from "./moved";
import { useMoved } from "./useMoved";

/** The files named under the line; past this many the rest are counted. */
export const LISTED = 20;

/** Where Show me both is: closed, being read, read, or not readable now. */
export type Both = { state: "closed" } | { state: "loading" } | { state: "failed" } | { state: "open"; sides: Side[] };

export interface MainMovedProps {
  moved: Moved;
  both: Both;
  onMerge: () => void;
  onShow: () => void;
}

const sideView = (f: SideFile) => (f.binary ? <p className="mut">{t("kit.moved.binary")}</p> : f.lines.length ? <DiffView files={[f]} /> : <p className="mut">—</p>);

export function MainMovedView({ moved, both, onMerge, onShow }: MainMovedProps) {
  const shown = moved.files.slice(0, LISTED);
  const rest = moved.files.length - shown.length;
  const open = both.state !== "closed";
  return (
    <div className="banner kitm" data-testid="kit-moved">
      <p className="kitm-line" data-testid="kit-moved-line">
        {moved.files.length === 1 ? t("kit.moved.one", { base: moved.base }) : t("kit.moved.many", { base: moved.base, n: moved.files.length })}
      </p>
      <ul className="kitm-files mono" data-testid="kit-moved-files">
        {shown.map((f) => (
          <li key={f} title={f}>
            {f}
          </li>
        ))}
        {rest > 0 && <li className="mut">{t("kit.moved.moreFiles", { n: rest })}</li>}
      </ul>
      <div className="chips">
        <button type="button" className="btn dark" onClick={onMerge} data-testid="kit-moved-merge">
          {t("kit.moved.merge")}
        </button>
        <button type="button" className="btn" aria-expanded={open} onClick={onShow} data-testid="kit-moved-show">
          {open ? t("kit.moved.hide") : t("kit.moved.show")}
        </button>
      </div>
      <p className="mut">{t("kit.moved.note")}</p>
      {both.state === "loading" && (
        <p className="mut" role="status" data-testid="kit-moved-loading">
          {t("kit.moved.loading")}
        </p>
      )}
      {both.state === "failed" && (
        <p className="mut" role="alert" data-testid="kit-moved-failed">
          {t("kit.moved.failed")}
        </p>
      )}
      {both.state === "open" && (
        <div className="kitm-both" data-testid="kit-moved-both">
          {both.sides.map((s) => (
            <section key={s.path} className="kitm-pair" data-testid="kit-moved-pair">
              <h4 className="mono">{s.path}</h4>
              <div className="kitm-cols">
                <div data-testid="kit-moved-theirs">
                  <h5>{t("kit.moved.theirs", { base: moved.base })}</h5>
                  {sideView(s.theirs)}
                </div>
                <div data-testid="kit-moved-ours">
                  <h5>{t("kit.moved.ours")}</h5>
                  {sideView(s.ours)}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function MainMoved({ root }: { root: string }) {
  const moved = useMoved(root);
  const [open, setOpen] = useState(false);
  const [both, setBoth] = useState<Both>({ state: "closed" });
  const key = moved ? `${moved.branch}\n${moved.base}\n${moved.files.join("\n")}` : "";

  // Another project, or the state is gone: the two sides close. While they are open they are read again when the files change.
  useEffect(() => setOpen(false), [root, moved === null]);
  useEffect(() => {
    if (!open || !moved) {
      setBoth({ state: "closed" });
      return;
    }
    let live = true;
    setBoth((was) => (was.state === "open" ? was : { state: "loading" }));
    readSides(getHost(), root, moved.files).then(
      (sides) => {
        if (live) setBoth(sides ? { state: "open", sides } : { state: "failed" });
      },
      () => {
        if (live) setBoth({ state: "failed" });
      },
    );
    return () => {
      live = false;
    };
    // `key` stands for `moved`: the files, not the object a new read makes
  }, [open, root, key]);

  if (!moved) return null;
  return (
    <MainMovedView
      moved={moved}
      both={both}
      onShow={() => setOpen((o) => !o)}
      onMerge={() => {
        // to Kit as a message: each step Kit takes then asks through its own card
        void askKit(getSessions(), root, mergeAsk(moved)).then((a) => getStore().actions.openSession(a.session));
      }}
    />
  );
}
