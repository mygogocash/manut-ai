// Artifacts (item 83): the shop's pages shared by a link anyone with it can open. "Share a file as a link" takes an HTML or Markdown
// file from this Mac; the person's links are listed newest first, each with Open, Copy link and Remove.
//
// A link is public, so every publish is asked first, and so is every removal, which cannot be undone (src/runtime/artifactAsks.ts):
// the ask shows exactly what will be published (the title, the kind, the size, and that anyone with the link can open it), is
// settled once through approval-core, and only a yes reaches the runtime, which then publishes that ask's own page and nothing else.
// While Settings › Artifacts is off, in Practice, with nobody signed in, or while the API says publishing is off, Share says why in
// plain words and nothing is sent. `ArtifactsView` draws a given state so a test can draw each one; `ArtifactsPage` reads and acts.
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { artifactSettings, useArtifactSettings } from "../lib/artifactLinks";
import { openExternal } from "../lib/openExternal";
import { runtimeKind, startedRuntime } from "../runtime";
import { answerArtifactAsk, askToRemove, askToShare, withdrawArtifactAsk } from "../runtime/artifactAsks";
import type { ArtifactLink, RemovePlan, SharePlan } from "../runtime/artifacts";
import { useSignIn } from "../runtime/link";
import { getStore } from "../state/store";
import { MenuIcon } from "../sidebar/menuIcons";
import { blockedReason, kindText, madeText, planFromFile, sizeText, type ArtifactsState } from "./artifacts";
import { Empty, MenuPageFrame } from "./MenuPage";
import "./artifacts.css";

/** The ask on screen: to publish a page, or to remove a link. */
export type ArtifactAsk = { kind: "share"; id: string; plan: SharePlan } | { kind: "remove"; id: string; plan: RemovePlan };

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
}

function AskPanel({ ask, busy, onAnswer }: { ask: ArtifactAsk; busy: boolean; onAnswer: (yes: boolean) => void }) {
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
  const canShare = why === null && !p.busy && p.ask === null;
  return (
    <MenuPageFrame
      page="artifacts"
      title={t("menu.artifacts")}
      acts={
        <button type="button" className="btn dark" disabled={!canShare} onClick={p.onShare} data-testid="art-share">
          {t("art.share")}
        </button>
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
        {p.ask && <AskPanel ask={p.ask} busy={p.busy} onAnswer={p.onAnswer} />}
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

/** Where the page stands before anything is sent: the Settings switch first, then the runtime, then the sign-in. */
function gate(publish: boolean, origin: string | null, signedIn: boolean, practice: boolean): ArtifactsState | null {
  if (!publish) return { kind: "switched_off" };
  if (practice) return { kind: "practice" };
  if (origin && !signedIn) return { kind: "signed_out" };
  return null;
}

export function ArtifactsPage() {
  const settings = useArtifactSettings();
  const setting = startedRuntime();
  const kind = runtimeKind(setting);
  const origin = kind === "http" && setting.mode === "connected" ? setting.origin : null;
  const signIn = useSignIn(origin);
  // Links are made only through the API: Practice, and the WebSocket bridge used in development, have none to make.
  const before = gate(settings.publish, origin, signIn?.kind === "signed_in", kind !== "http");
  const [state, setState] = useState<ArtifactsState>({ kind: "reading" });
  const [links, setLinks] = useState<ArtifactLink[]>([]);
  const [ask, setAsk] = useState<ArtifactAsk | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
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
      setState({ kind: "ready", shop: r.shop, publishing: r.publishing });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setLinks([]);
      setState({ kind: "failed", code: err.code ?? "unavailable", message: err.message || t("art.err.unavailable") });
    }
  }, []);

  const blocked = before?.kind ?? null;
  useEffect(() => {
    if (blocked !== null) {
      setLinks([]);
      return;
    }
    setState({ kind: "reading" });
    void load();
  }, [blocked, load]);

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

  const answer = async (yes: boolean) => {
    if (!ask || busy) return;
    setBusy(true);
    setError(null);
    const settled = await answerArtifactAsk(ask.id, yes);
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
        onRetry={() => {
          setState({ kind: "reading" });
          void load();
        }}
      />
    </>
  );
}
