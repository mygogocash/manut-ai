// New project on the Code page (item 100b, part 2). The person names or picks a folder; the shell makes it in their home folder
// (refusing one that is there with anything in it, and anything outside home), starts git in it with the app's own git (no hook, no
// template; src-tauri/src/new_project.rs), and the page lists it as a project at once. That writes only on this computer.
//
// Make it on GitHub too is offered beside the result, and it is a write: it goes through the one ask (review.rs `ask_repo`, settled
// once through approval-core by code/reviewAsk.ts and then by the shell). The shell writes the plan down first and the ask shows it
// whole, `gh repo create <name> --private --source <folder> --remote origin`, private unless the person chose public, which is said
// in plain words. A Yes runs that line once. Nothing is pushed: no step here pushes, and a push is its own ask elsewhere.
//
// `NewProjectView` draws a given step so a test can draw each one; `NewProject` keeps the step and talks to the host it is given.
import { useCallback, useEffect, useRef, useState } from "react";
import { t, type Key } from "../i18n";
import type { SessionHost } from "../sessions/host";
import { maskSecrets } from "../lib/secrets";
import { openExternal } from "../lib/openExternal";
import { whyWords } from "./Review";
import { answerReviewAsk, openReviewAsk, withdrawReviewAsk } from "./reviewAsk";
import type { NewProjectMade, RepoAsk, ReviewDone } from "./source";
import "./review.css";

export type NewProjectHost = Pick<SessionHost, "projectNew" | "repoAsk" | "reviewSettle" | "reviewWithdraw" | "pickFolder" | "home">;

export type NewStep =
  | { at: "closed" }
  | { at: "form"; path: string; busy: boolean; why: string | null }
  | { at: "made"; made: NewProjectMade }
  | { at: "repo"; made: NewProjectMade; name: string; isPublic: boolean; busy: boolean; why: string | null }
  | { at: "ask"; made: NewProjectMade; ask: RepoAsk; busy: boolean; why: string | null }
  | { at: "done"; made: NewProjectMade; done: ReviewDone };

/** The codes New project has words of its own for; the rest are the asks' (Review.tsx `whyWords`), or the line itself, masked. */
const OWN = ["bad_path", "outside_home", "not_empty", "not_a_folder", "link", "no_home", "unreadable", "bad_repo_name", "has_origin", "not_a_repository"] as const;

export function projectWhy(code: string): string {
  const [head, ...rest] = code.split(":");
  const line = maskSecrets(rest.join(":"));
  if (head === "init_failed") return t("proj.why.init_failed", { error: line });
  if (head === "make_failed") return t("proj.why.make_failed", { error: line });
  return (OWN as readonly string[]).includes(code) ? t(`proj.why.${code}` as Key) : whyWords(code);
}

/** `path` with a leading `~` read as the home folder. */
export function expandHome(path: string, home: string | null): string {
  const p = path.trim();
  if (!home) return p;
  if (p === "~") return home;
  return p.startsWith("~/") ? `${home.replace(/\/+$/, "")}${p.slice(1)}` : p;
}

/** `path` as the field shows it: the home folder as `~`. */
export function tildeOf(path: string, home: string | null): string {
  if (!home) return path;
  const h = home.replace(/\/+$/, "");
  return path === h ? "~" : path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

/** The name the GitHub step starts with: the folder's name, when it is one GitHub takes, else nothing. */
export const nameFor = (made: NewProjectMade): string => (/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(made.name) ? made.name : "");

/** The ask to make `made`'s repository on GitHub: the shell's (it writes the plan down and makes no repository), opened at once as
 *  an approval-core request, so the Yes that follows is settled once there and then by the shell. */
export async function askRepo(host: Pick<NewProjectHost, "repoAsk">, folder: string, name: string, isPublic: boolean): Promise<RepoAsk> {
  if (!host.repoAsk) throw new Error("no_shell");
  const got = await host.repoAsk(folder, name.trim(), isPublic);
  await openReviewAsk(got);
  return got;
}

export interface NewProjectViewProps {
  step: NewStep;
  home: string | null;
  onPath: (path: string) => void;
  onChoose: () => void;
  onMake: () => void;
  onGithub: () => void;
  onName: (name: string) => void;
  onPublic: (isPublic: boolean) => void;
  onAsk: () => void;
  onYes: () => void;
  onNo: () => void;
  onChange: () => void;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
}

function Why({ why }: { why: string | null }) {
  return why ? (
    <p className="rv-why" role="alert" data-testid="np-why">
      {projectWhy(why)}
    </p>
  ) : null;
}

/** What was made, and Make it on GitHub too beside it. */
function MadeLine({ made }: { made: NewProjectMade }) {
  return (
    <p data-testid="np-made">
      {t(made.existed ? "proj.madeExisted" : "proj.made", { name: made.name })}
    </p>
  );
}

function doneLine(d: ReviewDone): string {
  if (d.outcome === "created") return t("proj.created", { repo: d.url.replace(/^https:\/\/github\.com\//, "") });
  if (d.step === "settle") return d.error;
  if (d.step === "check") return t("proj.check");
  return t("proj.failed", { error: maskSecrets(d.error) });
}

export function NewProjectView(p: NewProjectViewProps) {
  const s = p.step;
  if (s.at === "closed") return null;
  if (s.at === "form") {
    return (
      <div className="review np" data-testid="np-panel">
        <div className="rv-panel" role="group" aria-label={t("proj.new")} data-testid="np-form">
          <label>
            <span>{t("proj.folder")}</span>
            <span className="np-pick">
              <input type="text" value={s.path} onChange={(e) => p.onPath(e.currentTarget.value)} spellCheck={false} autoComplete="off" data-testid="np-path" />
              <button type="button" className="btn" disabled={s.busy} onClick={p.onChoose} data-testid="np-choose">
                {t("proj.choose")}
              </button>
            </span>
          </label>
          <p className="mut">{t("proj.folderHint")}</p>
          <Why why={s.why} />
          <div className="rv-actions">
            <button type="button" className="btn dark" disabled={s.busy || expandHome(s.path, p.home).replace(/\/+$/, "") === (p.home ?? "").replace(/\/+$/, "")} aria-busy={s.busy} onClick={p.onMake} data-testid="np-make">
              {t("proj.make")}
            </button>
            <button type="button" className="btn" onClick={p.onClose} data-testid="np-cancel">
              {t("review.cancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (s.at === "made") {
    return (
      <div className="review np" data-testid="np-panel">
        <MadeLine made={s.made} />
        <div className="rv-actions">
          <button type="button" className="btn" onClick={p.onGithub} title={t("proj.githubTip")} data-testid="np-github">
            {t("proj.github")}
          </button>
          <button type="button" className="lk" onClick={p.onClose} data-testid="np-done">
            {t("proj.done")}
          </button>
        </div>
      </div>
    );
  }
  if (s.at === "repo") {
    return (
      <div className="review np" data-testid="np-panel">
        <MadeLine made={s.made} />
        <div className="rv-panel" role="group" aria-label={t("proj.github")} data-testid="np-repo">
          <label>
            <span>{t("proj.name")}</span>
            <input type="text" value={s.name} onChange={(e) => p.onName(e.currentTarget.value)} maxLength={201} spellCheck={false} autoComplete="off" data-testid="np-name" />
          </label>
          <fieldset className="np-who">
            <legend>{t("proj.who")}</legend>
            <label className="np-opt">
              <input type="radio" name="np-who" checked={!s.isPublic} onChange={() => p.onPublic(false)} data-testid="np-private" />
              <span>{t("proj.private")}</span>
            </label>
            <label className="np-opt">
              <input type="radio" name="np-who" checked={s.isPublic} onChange={() => p.onPublic(true)} data-testid="np-public" />
              <span>{t("proj.public")}</span>
            </label>
          </fieldset>
          <Why why={s.why} />
          <div className="rv-actions">
            <button type="button" className="btn dark" disabled={s.busy || s.name.trim() === ""} aria-busy={s.busy} onClick={p.onAsk} data-testid="np-ask-button">
              {t("review.ask")}
            </button>
            <button type="button" className="btn" onClick={p.onClose} data-testid="np-cancel">
              {t("review.cancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (s.at === "ask") {
    const a = s.ask;
    return (
      <div className="review np" data-testid="np-panel">
        <div className="rv-panel warn" role="group" aria-label={t("proj.ask.h", { name: a.repo })} data-testid="np-ask" data-visibility={a.visibility}>
          <p className="rv-h">{t("proj.ask.h", { name: a.repo })}</p>
          <dl>
            <dt>{t("proj.ask.folder")}</dt>
            <dd className="mono" data-testid="np-ask-folder">
              {tildeOf(a.folder, p.home)}
            </dd>
            <dt>{t("proj.who")}</dt>
            <dd data-testid="np-ask-who">{t(a.visibility === "public" ? "proj.public" : "proj.private")}</dd>
            <dt>{t("proj.ask.remote")}</dt>
            <dd className="mono">{a.remote}</dd>
          </dl>
          <p>{t("proj.ask.runs")}</p>
          <pre className="rv-text" data-testid="np-plan">
            {a.plan}
          </pre>
          <p className="mut">{t("proj.ask.never")}</p>
          <Why why={s.why} />
          <div className="rv-actions">
            <button type="button" className="btn dark" disabled={s.busy} aria-busy={s.busy} onClick={p.onYes} data-testid="np-yes">
              {t("proj.ask.yes")}
            </button>
            <button type="button" className="btn" disabled={s.busy} onClick={p.onNo} data-testid="np-no">
              {t("review.ask.no")}
            </button>
            <button type="button" className="lk" disabled={s.busy} onClick={p.onChange} data-testid="np-change">
              {t("review.change")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  const d = s.done;
  return (
    <div className="review np" data-testid="np-panel">
      <MadeLine made={s.made} />
      <p className={d.outcome === "failed" ? "rv-why" : "mut"} role="status" data-testid="np-result" data-outcome={d.outcome}>
        {doneLine(d)}
        {d.outcome === "created" && d.url && (
          <>
            {" "}
            <button type="button" className="lk" onClick={() => p.onOpenUrl(d.url)} data-testid="np-open">
              {t("review.done.openLink")}
            </button>
          </>
        )}
      </p>
      <div className="rv-actions">
        {d.outcome === "failed" && (
          <button type="button" className="btn" onClick={p.onGithub} data-testid="np-github">
            {t("proj.github")}
          </button>
        )}
        <button type="button" className="lk" onClick={p.onClose} data-testid="np-done">
          {t("proj.done")}
        </button>
      </div>
    </div>
  );
}

export interface NewProjectProps {
  host: NewProjectHost;
  home: string | null;
  open: boolean;
  onClose: () => void;
  /** The shell made the project: the page lists it (the Code page passes SessionsSection's `listFolder`). */
  onMade: (folder: string) => void;
}

/** New project's panel: closed until `open`, then the folder, what was made, and Make it on GitHub too through its ask. */
export function NewProject({ host, home: given, open, onClose, onMade }: NewProjectProps) {
  const [step, setStep] = useState<NewStep>({ at: "closed" });
  const asked = useRef<string | null>(null);
  // the home folder, as the sessions know it, else asked of the host once (the sessions read it only once an agent list is read)
  const [homeRead, setHomeRead] = useState<string | null>(null);
  const home = given ?? homeRead;
  useEffect(() => {
    if (given || !open) return;
    let live = true;
    void host
      .home()
      .then((h) => live && setHomeRead(h || null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [given, open, host]);

  // an ask left waiting when the panel closes or goes is taken back
  const drop = useCallback(() => {
    const id = asked.current;
    asked.current = null;
    if (id) void withdrawReviewAsk(host, id);
  }, [host]);
  useEffect(() => drop, [drop]);
  useEffect(() => {
    // the field starts at the home folder (`~/`), and does so once the home folder is known if it was not yet
    if (open) setStep((s) => (s.at === "closed" ? { at: "form", path: home ? "~/" : "", busy: false, why: null } : s.at === "form" && s.path === "" && home ? { ...s, path: "~/" } : s));
    else {
      drop();
      setStep({ at: "closed" });
    }
  }, [open, home, drop]);

  if (!host.projectNew) return null;

  const close = () => {
    drop();
    setStep({ at: "closed" });
    onClose();
  };
  const choose = async () => {
    if (step.at !== "form") return;
    const picked = await host.pickFolder(expandHome(step.path, home) || home || "/").catch(() => null);
    if (picked) setStep((s) => (s.at === "form" ? { ...s, path: tildeOf(picked, home), why: null } : s));
  };
  const make = async () => {
    if (step.at !== "form" || step.busy || !host.projectNew) return;
    const path = expandHome(step.path, home).replace(/\/+$/, "");
    setStep({ ...step, busy: true, why: null });
    try {
      const made = await host.projectNew(path);
      onMade(made.folder);
      setStep({ at: "made", made });
    } catch (e) {
      setStep({ ...step, busy: false, why: e instanceof Error ? e.message : String(e) });
    }
  };
  const github = () => {
    if (step.at !== "made" && step.at !== "done") return;
    setStep({ at: "repo", made: step.made, name: nameFor(step.made), isPublic: false, busy: false, why: null });
  };
  const ask = async () => {
    if (step.at !== "repo" || step.busy) return;
    setStep({ ...step, busy: true, why: null });
    try {
      const got = await askRepo(host, step.made.folder, step.name, step.isPublic);
      asked.current = got.id;
      setStep({ at: "ask", made: step.made, ask: got, busy: false, why: null });
    } catch (e) {
      setStep({ ...step, busy: false, why: e instanceof Error ? e.message : String(e) });
    }
  };
  const answer = async (yes: boolean) => {
    if (step.at !== "ask" || step.busy) return;
    const { made, ask: a } = step;
    setStep({ ...step, busy: true, why: null });
    const got = await answerReviewAsk(host, a.id, yes);
    asked.current = null;
    if (!got.ok) {
      setStep({ at: "done", made, done: { outcome: "failed", pushed: false, url: "", number: 0, step: "settle", error: projectWhy(got.refused) } });
      return;
    }
    // a No makes nothing and goes back to what was made, with Make it on GitHub too still beside it
    setStep(got.done.outcome === "declined" ? { at: "made", made } : { at: "done", made, done: got.done });
  };
  const change = () => {
    if (step.at !== "ask") return;
    drop();
    setStep({ at: "repo", made: step.made, name: step.ask.repo, isPublic: step.ask.visibility === "public", busy: false, why: null });
  };
  return (
    <NewProjectView
      step={step}
      home={home}
      onPath={(path) => setStep((s) => (s.at === "form" ? { ...s, path, why: null } : s))}
      onChoose={() => void choose()}
      onMake={() => void make()}
      onGithub={github}
      onName={(name) => setStep((s) => (s.at === "repo" ? { ...s, name, why: null } : s))}
      onPublic={(isPublic) => setStep((s) => (s.at === "repo" ? { ...s, isPublic, why: null } : s))}
      onAsk={() => void ask()}
      onYes={() => void answer(true)}
      onNo={() => void answer(false)}
      onChange={change}
      onClose={close}
      onOpenUrl={(url) => void openExternal(url).catch(() => undefined)}
    />
  );
}
