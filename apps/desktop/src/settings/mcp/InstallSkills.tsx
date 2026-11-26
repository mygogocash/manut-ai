// Settings › MCP and Skills › Install skills from a link (item 84). Someone shared skills with a link; this reads them, shows every
// file with its size, SKILL.md marked as the instructions the agent follows and each script marked, lets the person choose all or
// some skills and the coding agent to install them for, and asks before anything is written. The words of the ask say what a skill
// is, that nothing runs now, and that in a later chat the agent may follow it and ask to run its scripts, each step asking as usual.
// A skill with something an agent would act on by itself, without its prompt (skillBundle.ts `fileActsAlone`: `allowed-tools`,
// `hooks`, a command run as it loads, any setting not on the harmless list), is named with its file and setting and cannot be
// chosen; the shell refuses it again at the ask and before writing.
//
// Behind Settings › Artifacts › Allow sharing skills by link: while it is off nothing is read, fetched or written. The link must be
// on the artifact origin the API names (read with the shop's links, `artifacts.list`), checked here and again by the shell before
// anything is fetched. The shell keeps the bundle it fetched and writes only that, on a Yes settled through approval-core
// (runtime/skillInstallAsks.ts), never over a skill the agent has, with no executable bit, running nothing.
//
// `InstallSkillsView` draws a given state so a test can draw each one; `InstallSkills` reads and acts.
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { useArtifactSettings } from "../../lib/artifactLinks";
import { SkillFiles } from "../../pages/SkillFiles";
import type { FileReview } from "../../runtime/fileReview";
import { skillActsAlone, type InstallAsk, type LinkRead } from "../../runtime/skillBundle";
import { answerInstallAsk, installReview, openInstallAsk, withdrawInstallAsk } from "../../runtime/skillInstallAsks";
import { getHost } from "../../sessions/host";
import { agentLabel } from "../../sessions/agents";
import { getStore } from "../../state/store";
import { Row } from "../DevRow";
import { actsWords, installWords, linkOnOrigin } from "./installLink";

type Agent = "claude" | "codex";

/** The chosen skills of `bundle` that can be installed: never one an agent would act on by itself (the shell refuses it again). */
const installable = (bundle: LinkRead, chosen: readonly string[]) => bundle.skills.filter((k) => chosen.includes(k.name) && !skillActsAlone(k));

/** Where the section stands: off, waiting for a link, reading it, the bundle read (with what is chosen), or its ask. */
export type InstallState =
  | { step: "off" }
  | { step: "link" }
  | { step: "reading" }
  | { step: "read"; bundle: LinkRead; chosen: string[]; agent: Agent }
  | { step: "ask"; bundle: LinkRead; ask: InstallAsk };

export interface InstallSkillsViewProps {
  state: InstallState;
  link: string;
  busy: boolean;
  error: string | null;
  notice: string | null;
  review: Pick<FileReview, "opened" | "lookedAtAll" | "done"> | null;
  shown: string | null;
  onLink: (link: string) => void;
  onRead: () => void;
  onChoose: (name: string) => void;
  onAgent: (agent: Agent) => void;
  onInstall: () => void;
  onAnswer: (yes: boolean) => void;
  onCancel: () => void;
  onView: (key: string) => void;
  onTick: (on: boolean) => void;
  onSettings: () => void;
}

export function InstallSkillsView(p: InstallSkillsViewProps) {
  const s = p.state;
  return (
    <section data-testid="skl-install" data-step={s.step} aria-labelledby="skl-install-h">
      <div className="st-gh" id="skl-install-h">
        {t("skl.in.title")}
      </div>
      <div className="st-note">{t("skl.in.intro")}</div>
      {s.step === "off" ? (
        <div className="st-note" data-testid="skl-install-off">
          <span>{t("skl.in.off")} </span>
          <button type="button" className="st-btn" onClick={p.onSettings} data-testid="skl-install-settings">
            {t("art.why.openSettings")}
          </button>
        </div>
      ) : (
        <div className="st-grp">
          <Row title={t("skl.in.link")} hint={t("skl.in.linkHint")}>
            <span className="st-pair">
              <input
                type="url"
                className="dev-in"
                value={p.link}
                disabled={p.busy || s.step === "ask"}
                aria-label={t("skl.in.link")}
                onChange={(e) => p.onLink(e.currentTarget.value)}
                data-testid="skl-install-link"
              />
              <button type="button" className="st-btn" disabled={p.busy || !p.link.trim() || s.step === "ask"} onClick={p.onRead} data-testid="skl-install-read">
                {t("skl.in.read")}
              </button>
            </span>
          </Row>
        </div>
      )}
      {s.step === "reading" && <div className="st-note">{t("skl.in.reading")}</div>}
      {p.error && (
        <div className="st-note skl-err" role="alert" data-testid="skl-install-error">
          {p.error}
        </div>
      )}
      {p.notice && (
        <div className="st-note" role="status" data-testid="skl-install-notice">
          {p.notice}
        </div>
      )}
      {s.step === "read" && (
        <div className="skl-install-body">
          <div className="st-note">
            <b>{s.bundle.title || t("skl.untitled")}</b> {t("skl.in.from")}
          </div>
          <div className="st-grp">
            {s.bundle.skills.map((k) => {
              // A skill an agent would act on by itself is named with its file and setting, and cannot be chosen.
              const acts = skillActsAlone(k);
              return (
                <Row key={k.name} title={k.name} hint={acts ? actsWords(acts.why, `${k.name}/${acts.path}`, acts.field) : t("skl.in.files", { n: k.files.length })}>
                  <input
                    type="checkbox"
                    checked={!acts && s.chosen.includes(k.name)}
                    disabled={p.busy || !!acts}
                    aria-label={k.name}
                    onChange={() => p.onChoose(k.name)}
                    data-testid="skl-install-skill"
                    data-name={k.name}
                    data-acts={acts ? acts.why : undefined}
                  />
                </Row>
              );
            })}
            <Row title={t("skl.in.agent")} hint={t("skl.in.agentHint")}>
              <span className="st-pair" role="radiogroup" aria-label={t("skl.in.agent")}>
                {(["claude", "codex"] as const).map((a) => (
                  <button key={a} type="button" role="radio" aria-checked={s.agent === a} className="st-btn" disabled={p.busy} onClick={() => p.onAgent(a)} data-testid={`skl-install-agent-${a}`}>
                    {agentLabel(a, null)}
                  </button>
                ))}
              </span>
            </Row>
          </div>
          <SkillFiles skills={installable(s.bundle, s.chosen)} review={null} shown={p.shown} onView={p.onView} onTick={p.onTick} buttonClass="st-btn" />
          <div className="st-note">
            <button type="button" className="st-btn" disabled={p.busy || installable(s.bundle, s.chosen).length === 0} onClick={p.onInstall} data-testid="skl-install-go">
              {t("skl.in.install")}
            </button>{" "}
            <button type="button" className="st-btn" disabled={p.busy} onClick={p.onCancel} data-testid="skl-install-cancel">
              {t("skl.pick.cancel")}
            </button>
          </div>
        </div>
      )}
      {s.step === "ask" && (
        <div className="skl-install-body" role="group" aria-label={t("skl.in.ask", { agent: agentLabel(s.ask.agent, null) })} data-testid="skl-install-ask">
          <div className="st-note">
            <b>{t("skl.in.ask", { agent: agentLabel(s.ask.agent, null) })}</b>
          </div>
          <div className="st-note" data-testid="skl-install-folder">
            {t("skl.in.where", { folder: s.ask.folder })}
          </div>
          <div className="st-note" data-testid="skl-install-stranger">
            {t("skl.in.stranger")}
          </div>
          <div className="st-note" data-testid="skl-install-nothingRuns">
            {t("skl.in.nothingRuns")}
          </div>
          <SkillFiles
            skills={s.bundle.skills.filter((k) => s.ask.skills.some((a) => a.name === k.name))}
            review={p.review}
            shown={p.shown}
            onView={p.onView}
            onTick={p.onTick}
            buttonClass="st-btn"
            busy={p.busy}
          />
          <div className="st-note">
            <button type="button" className="st-btn" disabled={p.busy || !p.review?.done} onClick={() => p.onAnswer(true)} data-testid="skl-install-yes">
              {t("skl.in.yes")}
            </button>{" "}
            <button type="button" className="st-btn" autoFocus disabled={p.busy} onClick={() => p.onAnswer(false)} data-testid="skl-install-no">
              {t("skl.in.no")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function InstallSkills() {
  const settings = useArtifactSettings();
  const [state, setState] = useState<InstallState>({ step: "link" });
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [, setReviewed] = useState(0);
  const askId = useRef<string | null>(null);
  askId.current = state.step === "ask" ? state.ask.id : null;

  const reset = () => {
    if (askId.current) void withdrawInstallAsk(getHost(), askId.current);
    setState({ step: "link" });
    setShown(null);
  };

  // The switch going off, or the page closing, takes back an ask that waits, so no later answer writes anything.
  useEffect(() => {
    if (!settings.skills) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.skills]);
  useEffect(() => () => {
    if (askId.current) void withdrawInstallAsk(getHost(), askId.current);
  }, []);

  const read = async () => {
    setError(null);
    setNotice(null);
    const host = getHost();
    if (!host.skillLinkRead) return setError(t("skl.why.noShell"));
    setBusy(true);
    setState({ step: "reading" });
    // The artifact origin, as the API names it with the shop's links. Without one, no link can be installed from.
    let origin: string | null = null;
    try {
      origin = (await getStore().actions.artifactsList()).origin;
    } catch {
      origin = null;
    }
    if (!origin) {
      setBusy(false);
      setState({ step: "link" });
      return setError(t("skl.in.noOrigin"));
    }
    // Refused here before the shell is asked: nothing is fetched for a link anywhere else.
    if (!linkOnOrigin(link, origin)) {
      setBusy(false);
      setState({ step: "link" });
      return setError(t("skl.in.otherHost"));
    }
    try {
      const bundle = await host.skillLinkRead(link.trim(), origin);
      setState({ step: "read", bundle, chosen: installable(bundle, bundle.skills.map((k) => k.name)).map((k) => k.name), agent: "claude" });
    } catch (e) {
      setState({ step: "link" });
      setError(installWords(e instanceof Error ? e.message : String(e)));
    }
    setBusy(false);
  };

  const install = async () => {
    const host = getHost();
    if (state.step !== "read" || !host.skillInstallAsk) return;
    setBusy(true);
    setError(null);
    try {
      const ask = await host.skillInstallAsk(state.bundle.read, installable(state.bundle, state.chosen).map((k) => k.name), state.agent);
      await openInstallAsk(ask);
      setShown(null);
      setState({ step: "ask", bundle: state.bundle, ask });
    } catch (e) {
      setError(installWords(e instanceof Error ? e.message : String(e), state.agent));
    }
    setBusy(false);
  };

  const answer = async (yes: boolean) => {
    if (state.step !== "ask" || busy) return;
    setBusy(true);
    setError(null);
    const settled = await answerInstallAsk(getHost(), state.ask.id, yes);
    setBusy(false);
    if (!settled.ok) {
      if (settled.refused === "not_reviewed") return setError(t("skl.err.notReviewed"));
      setState({ step: "link" });
      return setError(installWords(settled.refused, state.ask.agent));
    }
    const done = settled.done;
    const agent = agentLabel(state.ask.agent, null);
    setState({ step: "link" });
    setShown(null);
    if (done.outcome === "installed") {
      setLink("");
      setNotice(t("skl.in.done", { names: done.installed.join(", "), agent }));
    } else if (done.outcome === "failed") {
      setError(installWords(done.why === "exists" ? `exists:${done.failed ?? ""}` : "unwritable", state.ask.agent));
    }
  };

  const review = state.step === "ask" ? installReview(state.ask.id) : null;
  return (
    <InstallSkillsView
      state={settings.skills ? state : { step: "off" }}
      link={link}
      busy={busy}
      error={settings.skills ? error : null}
      notice={settings.skills ? notice : null}
      review={review}
      shown={shown}
      onLink={setLink}
      onRead={() => void read()}
      onChoose={(name) =>
        setState((s) => (s.step === "read" ? { ...s, chosen: s.chosen.includes(name) ? s.chosen.filter((n) => n !== name) : [...s.chosen, name] } : s))
      }
      onAgent={(agent) => setState((s) => (s.step === "read" ? { ...s, agent } : s))}
      onInstall={() => void install()}
      onAnswer={(yes) => void answer(yes)}
      onCancel={reset}
      onView={(key) => {
        review?.open(key);
        setReviewed((n) => n + 1);
        setShown((open) => (open === key ? null : key));
      }}
      onTick={(on) => {
        review?.tick(on);
        setReviewed((n) => n + 1);
      }}
      onSettings={() => getStore().actions.openSettings("artifacts")}
    />
  );
}
