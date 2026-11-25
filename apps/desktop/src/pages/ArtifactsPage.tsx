// Artifacts (item 83): the shop's pages shared by a link anyone with it can open. "Share a file as a link" takes an HTML or Markdown
// file from this Mac; the person's links are listed newest first, each with Open, Copy link and Remove.
//
// A link is public, so every publish is asked first, and so is every removal, which cannot be undone (src/runtime/artifactAsks.ts):
// the ask shows exactly what will be published (the title, the kind, the size, and that anyone with the link can open it), is
// settled once through approval-core, and only a yes reaches the runtime, which then publishes that ask's own page and nothing else.
// While Settings › Artifacts is off, in Practice, with nobody signed in, or while the API says publishing is off, Share says why in
// plain words and nothing is sent. `ArtifactsView` draws a given state so a test can draw each one; `ArtifactsPage` reads and acts.
//
// Share skills as a link (item 84) publishes a bundle of the person's own skills. They pick one or several from the skills Settings ›
// MCP and Skills lists; the shell reads each folder (src-tauri/src/skill_links.rs); a file that is a link, binary, or holds a key
// stops the publish and is named (a key never shown). Otherwise the ask shows every file with its size and each script marked, and
// its Yes is held back until every file was opened or "I have looked at every file" is ticked (runtime/fileReview.ts). While Settings
// › Artifacts › Allow sharing skills by link is off, or the API does not publish skills, the picker says why and reads nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { artifactSettings, useArtifactSettings } from "../lib/artifactLinks";
import { openExternal } from "../lib/openExternal";
import { runtimeKind, startedRuntime } from "../runtime";
import { answerArtifactAsk, askToRemove, askToShare, withdrawArtifactAsk } from "../runtime/artifactAsks";
import type { ArtifactLink, RemovePlan, SharePlan } from "../runtime/artifacts";
import { useSignIn } from "../runtime/link";
import { askToShareSkills, reviewOf } from "../runtime/artifactAsks";
import type { FileReview } from "../runtime/fileReview";
import { bundleWords } from "../runtime/http/artifacts";
import type { ReadSkill, SkillsPlan } from "../runtime/skillBundle";
import { getHost } from "../sessions/host";
import { agentLabel } from "../sessions/agents";
import { SkillFiles } from "./SkillFiles";
import { getStore, useStore } from "../state/store";
import { MenuIcon } from "../sidebar/menuIcons";
import { blockedReason, kindText, madeText, ownSkillKey, ownSkills, planFromFile, planFromReads, sizeText, type ArtifactsState, type OwnSkill } from "./artifacts";
import { Empty, MenuPageFrame } from "./MenuPage";
import "./artifacts.css";

/** The ask on screen: to publish a page, or to remove a link. */
export type ArtifactAsk =
  | { kind: "share"; id: string; plan: SharePlan }
  | { kind: "remove"; id: string; plan: RemovePlan }
  | { kind: "skills"; id: string; plan: SkillsPlan };

/** Choosing skills to share: reading the list, why nothing can be chosen, the list with what is chosen, or why the chosen ones
 *  cannot be published, file by file. */
export type SkillPick =
  | { step: "reading" }
  | { step: "blocked"; why: string; settings: boolean }
  | { step: "choose"; skills: OwnSkill[]; chosen: string[] }
  | { step: "refused"; lines: string[]; leftOut: string[] };

/** What the bundle ask needs beside the ask: its record of files looked at, the file open, and the dot-files left out. */
export interface SkillsReview {
  review: Pick<FileReview, "opened" | "lookedAtAll" | "done"> | null;
  shown: string | null;
  leftOut: string[];
  onView: (key: string) => void;
  onTick: (on: boolean) => void;
}

export interface ArtifactsViewProps {
  state: ArtifactsState;
  links: readonly ArtifactLink[];
  ask: ArtifactAsk | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  /** the id of the link whose Copy just worked */
  copied: string | null;
  nowMs: number;
  onShare: () => void;
  onAnswer: (yes: boolean) => void;
  onOpen: (link: ArtifactLink) => void;
  onCopy: (link: ArtifactLink) => void;
  onRemove: (link: ArtifactLink) => void;
  onSettings: () => void;
  onRetry: () => void;
  /** sharing skills (item 84); absent where a surface has none */
  picking?: SkillPick | null;
  skills?: SkillsReview;
  onShareSkills?: () => void;
  onPick?: (key: string) => void;
  onPickNext?: () => void;
  onPickCancel?: () => void;
}

function SkillsAskPanel({ ask, busy, onAnswer, r }: { ask: Extract<ArtifactAsk, { kind: "skills" }>; busy: boolean; onAnswer: (yes: boolean) => void; r: SkillsReview }) {
  const p = ask.plan;
  const files = p.skills.reduce((n, s) => n + s.files.length, 0);
  const shown = p.skills.map((s) => ({ name: s.name, files: s.files.map((f) => ({ ...f, exec: p.scripts.includes(`${s.name}/${f.path}`) })) }));
  return (
    <div className="art-ask" role="group" aria-label={t("skl.ask.share", { title: p.title })} data-testid="art-ask" data-kind="skills">
      <b>{t("skl.ask.share", { title: p.title })}</b>
      <dl>
        <dt>{t("skl.ask.skills")}</dt>
        <dd data-testid="art-ask-skills">{p.skills.length}</dd>
        <dt>{t("skl.ask.files")}</dt>
        <dd data-testid="art-ask-files">{files}</dd>
        <dt>{t("skl.ask.scripts")}</dt>
        <dd data-testid="art-ask-scripts">{p.scripts.length}</dd>
        <dt>{t("art.ask.size")}</dt>
        <dd data-testid="art-ask-size">{sizeText(p.bytes)}</dd>
      </dl>
      <p className="art-warn" data-testid="art-ask-public">
        {t("skl.ask.public")}
      </p>
      {r.leftOut.length > 0 && (
        <p className="art-warn" data-testid="skl-left-out">
          {t("skl.leftOut", { files: r.leftOut.join(", ") })}
        </p>
      )}
      <SkillFiles skills={shown} review={r.review} shown={r.shown} onView={r.onView} onTick={r.onTick} buttonClass="btn ghost" busy={busy} />
      <div className="art-btns">
        <button type="button" className="btn dark" disabled={busy || !r.review?.done} onClick={() => onAnswer(true)} data-testid="art-ask-yes">
          {t("art.ask.yes")}
        </button>
        <button type="button" className="btn" autoFocus disabled={busy} onClick={() => onAnswer(false)} data-testid="art-ask-no">
          {t("art.ask.no")}
        </button>
      </div>
    </div>
  );
}

function PickPanel({ pick, onPick, onNext, onCancel, onSettings }: { pick: SkillPick; onPick: (key: string) => void; onNext: () => void; onCancel: () => void; onSettings: () => void }) {
  const agents = pick.step === "choose" ? [...new Set(pick.skills.map((s) => s.agent))] : [];
  return (
    <div className="art-ask" role="group" aria-label={t("skl.pick.title")} data-testid="skl-pick" data-step={pick.step}>
      <b>{t("skl.pick.title")}</b>
      {pick.step === "reading" && <p className="art-warn">{t("skl.pick.reading")}</p>}
      {pick.step === "blocked" && (
        <p className="art-warn" data-testid="skl-pick-why">
          {pick.why}
        </p>
      )}
      {pick.step === "choose" && pick.skills.length === 0 && <p className="art-warn">{t("skl.pick.none")}</p>}
      {pick.step === "choose" &&
        agents.map((agent) => (
          <section key={agent} aria-label={agentLabel(agent, null)}>
            <div className="skl-skill">{agentLabel(agent, null)}</div>
            {pick.skills
              .filter((s) => s.agent === agent)
              .map((s) => (
                <label key={ownSkillKey(s)} className="skl-tick skl-pick-row">
                  <input type="checkbox" checked={pick.chosen.includes(ownSkillKey(s))} onChange={() => onPick(ownSkillKey(s))} data-testid="skl-pick-skill" data-key={ownSkillKey(s)} />
                  <span>{s.name}</span>
                </label>
              ))}
          </section>
        ))}
      {pick.step === "refused" && (
        <div role="alert" data-testid="skl-pick-refused">
          <p className="art-msg err">{t("skl.pick.refused")}</p>
          <ul className="skl-lines">
            {pick.lines.map((line) => (
              <li key={line} className="art-msg err">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="art-btns">
        {pick.step === "choose" && (
          <button type="button" className="btn dark" disabled={pick.chosen.length === 0} onClick={onNext} data-testid="skl-pick-next">
            {t("skl.pick.next")}
          </button>
        )}
        {pick.step === "blocked" && pick.settings && (
          <button type="button" className="btn dark" onClick={onSettings} data-testid="skl-pick-settings">
            {t("art.why.openSettings")}
          </button>
        )}
        <button type="button" className="btn" onClick={onCancel} data-testid="skl-pick-cancel">
          {t("skl.pick.cancel")}
        </button>
      </div>
    </div>
  );
}

function AskPanel({ ask, busy, onAnswer, skills }: { ask: ArtifactAsk; busy: boolean; onAnswer: (yes: boolean) => void; skills?: SkillsReview }) {
  if (ask.kind === "skills") {
    return skills ? <SkillsAskPanel ask={ask} busy={busy} onAnswer={onAnswer} r={skills} /> : null;
  }
  if (ask.kind === "share") {
    const p = ask.plan;
    return (
      <div className="art-ask" role="group" aria-label={t("art.ask.share", { title: p.title })} data-testid="art-ask" data-kind="share">
        <b>{t("art.ask.share", { title: p.title })}</b>
        <dl>
          <dt>{t("art.ask.kind")}</dt>
          <dd data-testid="art-ask-kind">{kindText(p.kind)}</dd>
          <dt>{t("art.ask.size")}</dt>
          <dd data-testid="art-ask-size">{sizeText(p.bytes)}</dd>
        </dl>
        <p className="art-warn" data-testid="art-ask-public">
          {t("art.ask.public")}
        </p>
        <div className="art-btns">
          <button type="button" className="btn dark" disabled={busy} onClick={() => onAnswer(true)} data-testid="art-ask-yes">
            {t("art.ask.yes")}
          </button>
          <button type="button" className="btn" autoFocus disabled={busy} onClick={() => onAnswer(false)} data-testid="art-ask-no">
            {t("art.ask.no")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="art-ask" role="group" aria-label={t("art.ask.remove", { title: ask.plan.title })} data-testid="art-ask" data-kind="remove">
      <b>{t("art.ask.remove", { title: ask.plan.title })}</b>
      <p className="art-warn">{t("art.ask.removeKept")}</p>
      <div className="art-btns">
        <button type="button" className="btn dark" disabled={busy} onClick={() => onAnswer(true)} data-testid="art-ask-yes">
          {t("art.ask.removeYes")}
        </button>
        <button type="button" className="btn" autoFocus disabled={busy} onClick={() => onAnswer(false)} data-testid="art-ask-no">
          {t("art.ask.removeNo")}
        </button>
      </div>
    </div>
  );
}

export function ArtifactsView(p: ArtifactsViewProps) {
  const why = blockedReason(p.state);
  const ready = p.state.kind === "ready";
  const canShare = why === null && !p.busy && p.ask === null && !p.picking;
  return (
    <MenuPageFrame
      page="artifacts"
      title={t("menu.artifacts")}
      acts={
        <>
          {p.onShareSkills && (
            <button type="button" className="btn" disabled={!canShare} onClick={p.onShareSkills} data-testid="art-share-skills">
              {t("skl.share")}
            </button>
          )}
          <button type="button" className="btn dark" disabled={!canShare} onClick={p.onShare} data-testid="art-share">
            {t("art.share")}
          </button>
        </>
      }
    >
      <div className="col art">
        {why !== null && (
          <div className="art-why" role="note" data-testid="art-why" data-state={p.state.kind}>
            <span>{why}</span>
            {p.state.kind === "switched_off" && (
              <button type="button" className="btn ghost" onClick={p.onSettings} data-testid="art-open-settings">
                {t("art.why.openSettings")}
              </button>
            )}
            {p.state.kind === "failed" && (
              <button type="button" className="btn ghost" onClick={p.onRetry} data-testid="art-retry">
                {t("art.retry")}
              </button>
            )}
          </div>
        )}
        {p.picking && (
          <PickPanel pick={p.picking} onPick={p.onPick ?? (() => {})} onNext={p.onPickNext ?? (() => {})} onCancel={p.onPickCancel ?? (() => {})} onSettings={p.onSettings} />
        )}
        {p.ask && <AskPanel ask={p.ask} busy={p.busy} onAnswer={p.onAnswer} skills={p.skills} />}
        {p.error && (
          <p className="art-msg err" role="alert" data-testid="art-error">
            {p.error}
          </p>
        )}
        {p.notice && (
          <p className="art-msg ok" role="status" data-testid="art-notice">
            {p.notice}
          </p>
        )}
        {ready && p.links.length === 0 && (
          <Empty icon={<MenuIcon row="artifacts" />} title={t("art.none")} text={t("art.noneText")} testId="artifacts-empty" />
        )}
        {ready && p.links.length > 0 && (
          <section aria-labelledby="art-links-h">
            <div className="band" id="art-links-h">
              {t("art.links")}
            </div>
            <ul className="rows" data-testid="art-links">
              {p.links.map((link) => (
                <li key={link.id} className="rowl" data-testid="art-link" data-id={link.id}>
                  <span className="grow">
                    <span className="l1">{link.title}</span>
                    <span className="l2">
                      {[kindText(link.kind), sizeText(link.bytes), madeText(link.createdAt, p.nowMs)].join(" · ")}
                    </span>
                    <span className="l2 art-url" data-testid="art-link-url">
                      {link.url ?? t("art.noUrl")}
                    </span>
                  </span>
                  {link.url && (
                    <>
                      <button type="button" className="btn ghost" disabled={p.busy} onClick={() => p.onOpen(link)} aria-label={`${t("art.open")}: ${link.title}`} data-testid="art-open">
                        {t("art.open")}
                      </button>
                      <button type="button" className="btn ghost" disabled={p.busy} onClick={() => p.onCopy(link)} aria-label={`${t("art.copy")}: ${link.title}`} data-testid="art-copy">
                        {p.copied === link.id ? t("art.copied") : t("art.copy")}
                      </button>
                    </>
                  )}
                  <button type="button" className="btn ghost" disabled={p.busy || p.ask !== null} onClick={() => p.onRemove(link)} aria-label={`${t("art.remove")}: ${link.title}`} data-testid="art-remove">
                    {t("art.remove")}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </MenuPageFrame>
  );
}

/** How long "Copied" shows on a row. */
const COPIED_MS = 2000;

/** Where the page stands before anything is sent: the Settings switch first, then the runtime, then the sign-in, which is
 *  `reading` while the keychain has not said yet, so nobody is told to sign in who is signed in. */
export function gate(publish: boolean, practice: boolean, signIn: { kind: string } | null): ArtifactsState | null {
  if (!publish) return { kind: "switched_off" };
  if (practice) return { kind: "practice" };
  if (signIn === null || signIn.kind === "loading" || signIn.kind === "signing_in") return { kind: "reading" };
  if (signIn.kind !== "signed_in") return { kind: "signed_out" };
  return null;
}

export function ArtifactsPage() {
  const settings = useArtifactSettings();
  // The shop the switcher shows: its links are the ones listed, read again when it changes.
  const viewing = useStore().shops.current;
  const setting = startedRuntime();
  const kind = runtimeKind(setting);
  const origin = kind === "http" && setting.mode === "connected" ? setting.origin : null;
  const signIn = useSignIn(origin);
  // Links are made only through the API: Practice, and the WebSocket bridge used in development, have none to make.
  const before = gate(settings.publish, kind !== "http" || origin === null, signIn);
  const [state, setState] = useState<ArtifactsState>({ kind: "reading" });
  const [links, setLinks] = useState<ArtifactLink[]>([]);
  const [ask, setAsk] = useState<ArtifactAsk | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [picking, setPicking] = useState<SkillPick | null>(null);
  const [shownFile, setShownFile] = useState<string | null>(null);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  // The review record is outside React; this counts its changes so the page draws them.
  const [, setReviewed] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askRef = useRef<ArtifactAsk | null>(null);
  askRef.current = ask;

  const load = useCallback(async () => {
    // Read again at the moment of sending: the switch may have gone off since the page drew.
    if (!artifactSettings().publish) return;
    try {
      const r = await getStore().actions.artifactsList();
      setLinks(r.links);
      setState({ kind: "ready", shop: r.shop, publishing: r.publishing, skillPublishing: r.skillPublishing });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setLinks([]);
      setState({ kind: "failed", code: err.code ?? "unavailable", message: err.message || t("art.err.unavailable") });
    }
  }, []);

  const blocked = before?.kind ?? null;
  useEffect(() => {
    // Another shop, or the switch or sign-in gone: an ask about what was shown before is taken back, so it can settle nothing.
    const open = askRef.current;
    if (open) {
      void withdrawArtifactAsk(open.id);
      setAsk(null);
      setBusy(false);
    }
    setPicking(null);
    setError(null);
    setNotice(null);
    if (blocked !== null) {
      setLinks([]);
      return;
    }
    setState({ kind: "reading" });
    void load();
  }, [blocked, viewing, load]);

  // An ask left open when the page goes away is taken back, so no later answer settles it.
  useEffect(() => () => {
    if (askRef.current) void withdrawArtifactAsk(askRef.current.id);
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const shown: ArtifactsState = before ?? state;
  const shop = shown.kind === "ready" ? shown.shop : null;

  const picked = async (chosen: File | undefined) => {
    if (!chosen || shop === null || blockedReason(shown) !== null || ask) return;
    setError(null);
    setNotice(null);
    const made = await planFromFile(chosen, shop);
    if (!made.ok) {
      setError(made.message);
      return;
    }
    setAsk({ kind: "share", id: await askToShare(made.plan), plan: made.plan });
  };

  /** Share skills as a link: why nothing can be chosen yet, or the person's own skills to choose from. Reads only this Mac. */
  const shareSkills = async () => {
    if (shop === null || ask || busy || picking) return;
    setError(null);
    setNotice(null);
    const host = getHost();
    const skillPublishing = shown.kind === "ready" ? (shown.skillPublishing ?? "feature_disabled") : "feature_disabled";
    if (!artifactSettings().skills) return setPicking({ step: "blocked", why: t("skl.why.switchedOff"), settings: true });
    if (skillPublishing !== "on") {
      return setPicking({ step: "blocked", why: skillPublishing === "artifact_origin_not_configured" ? t("art.why.noOrigin") : t("skl.why.featureOff"), settings: false });
    }
    if (!host.agentConfig || !host.skillBundleRead) return setPicking({ step: "blocked", why: t("skl.why.noShell"), settings: false });
    setPicking({ step: "reading" });
    const configs = await host.agentConfig().catch(() => null);
    setPicking({ step: "choose", skills: ownSkills(configs ?? []), chosen: [] });
  };

  /** The chosen skills read by the shell, then the ask, or every reason they cannot be published. */
  const pickNext = async () => {
    const host = getHost();
    if (picking?.step !== "choose" || shop === null || !host.skillBundleRead) return;
    const chosen = picking.skills.filter((s) => picking.chosen.includes(ownSkillKey(s)));
    setPicking({ step: "reading" });
    const reads: ReadSkill[] = [];
    const lines: string[] = [];
    for (const agent of ["claude", "codex"] as const) {
      const folders = chosen.filter((s) => s.agent === agent).map((s) => s.folder);
      if (!folders.length) continue;
      try {
        reads.push(...(await host.skillBundleRead(agent, folders)));
      } catch (e) {
        const [why, folder] = String(e instanceof Error ? e.message : e).split(":");
        lines.push(bundleWords({ reason: why ?? "", skill: folder }));
      }
    }
    if (artifactSettings().skills === false) return setPicking(null);
    const made = lines.length ? { ok: false as const, lines, leftOut: [] } : planFromReads(reads, shop);
    if (!made.ok) return setPicking({ step: "refused", lines: made.lines, leftOut: made.leftOut });
    const id = await askToShareSkills(made.plan);
    setPicking(null);
    setShownFile(null);
    setLeftOut(made.leftOut);
    setAsk({ kind: "skills", id, plan: made.plan });
  };

  const review = ask?.kind === "skills" ? reviewOf(ask.id) : null;

  const answer = async (yes: boolean) => {
    if (!ask || busy) return;
    setBusy(true);
    setError(null);
    const settled = await answerArtifactAsk(ask.id, yes);
    if (!settled.ok && settled.refused === "not_reviewed") {
      // The ask stays open: every file still has to be looked at first.
      setBusy(false);
      setError(t("skl.err.notReviewed"));
      return;
    }
    if (!settled.ok) {
      setAsk(null);
      setBusy(false);
      setError(t("art.err.askRefused"));
      return;
    }
    if (!yes) {
      setAsk(null);
      setBusy(false);
      return;
    }
    try {
      if (ask.kind === "share") {
        await getStore().actions.artifactsPublish(ask.id);
        setNotice(t("art.published"));
      } else if (ask.kind === "skills") {
        await getStore().actions.artifactsPublishSkills(ask.id);
        setNotice(t("skl.published"));
      } else {
        await getStore().actions.artifactsRemove(ask.id);
        setNotice(t("art.removed"));
      }
    } catch (e) {
      setError((e as Error).message || t("rt.change.refused"));
    }
    setAsk(null);
    setBusy(false);
    await load();
  };

  return (
    <>
      <input
        ref={file}
        type="file"
        accept=".html,.htm,.md,.markdown,text/html,text/markdown"
        hidden
        onChange={(e) => {
          const chosen = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          void picked(chosen);
        }}
        data-testid="art-file"
      />
      <ArtifactsView
        state={shown}
        links={before ? [] : links}
        ask={ask}
        busy={busy}
        error={error}
        notice={notice}
        copied={copied}
        nowMs={Date.now()}
        onShare={() => file.current?.click()}
        onAnswer={(yes) => void answer(yes)}
        onOpen={(link) => {
          if (link.url) void openExternal(link.url);
        }}
        onCopy={(link) => {
          if (!link.url) return;
          void navigator.clipboard?.writeText(link.url).then(
            () => {
              setCopied(link.id);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(null), COPIED_MS);
            },
            () => undefined,
          );
        }}
        onRemove={(link) => {
          if (shop === null || ask || busy) return;
          setError(null);
          setNotice(null);
          const plan: RemovePlan = { shop, id: link.id, title: link.title, url: link.url };
          void askToRemove(plan).then((id) => setAsk({ kind: "remove", id, plan }));
        }}
        onSettings={() => getStore().actions.openSettings("artifacts")}
        picking={picking}
        onShareSkills={() => void shareSkills()}
        onPick={(key) =>
          setPicking((p) => (p?.step === "choose" ? { ...p, chosen: p.chosen.includes(key) ? p.chosen.filter((k) => k !== key) : [...p.chosen, key] } : p))
        }
        onPickNext={() => void pickNext()}
        onPickCancel={() => setPicking(null)}
        skills={{
          review,
          shown: shownFile,
          leftOut,
          onView: (key) => {
            review?.open(key);
            setReviewed((n) => n + 1);
            setShownFile((open) => (open === key ? null : key));
          },
          onTick: (on) => {
            review?.tick(on);
            setReviewed((n) => n + 1);
          },
        }}
        onRetry={() => {
          setState({ kind: "reading" });
          void load();
        }}
      />
    </>
  );
}
