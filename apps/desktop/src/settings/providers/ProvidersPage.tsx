// Settings › Providers (item 74): one page for the coding agents, after T3 Code's Providers page (MIT; its layout and
// field names, none of its code). A list of every agent the app knows, each with its version, whether it is installed
// and signed in (where the app can tell), and a switch; under it the chosen agent's settings: a display name, the
// program's path, its home folder, extra arguments and environment variables. Then the person's own ACP agents
// (YourAgents, as Settings › Agents had them) and the accounts (AccountsPage, which Practice and Connected now show:
// the shell keeps the list). Every value is checked by the shell before it is saved and again when a session starts
// (src-tauri/src/providers.rs); the page's own check (model.ts) only says it sooner. A variable's value is typed once
// and never shown again: the shell sends names only.
import { Fragment, useEffect, useRef, useState } from "react";
import "./providers.css";
import "../accounts/accounts.css";
import { AgentMark } from "../../sessions/AgentMark";
import { getHost } from "../../sessions/host";
import { getSessions } from "../../sessions/sessions";
import { installLine } from "../../sessions/agents";
import { isAppStore } from "../../appStore";
import { Toggle } from "../../pages/kit";
import { t } from "../../i18n";
import { holdImeEnter } from "../../lib/ime";
import { planName } from "../accounts/rules";
import { reloadAccounts, useAccounts } from "../accounts/useAccounts";
import { AccountsPage } from "../accounts/AccountsPage";
import { YourAgents } from "../agents/AgentsPage";
import {
  checkForm,
  errorText,
  formOf,
  isEmptyPatch,
  patchOf,
  refusalText,
  shownName,
  statusLine,
  type ProviderForm,
  type ProviderView,
  type SignIn,
} from "./model";

/** The arguments field's example: an option, not words to translate. */
const ARGS_EXAMPLE = "--model=opus";

/** `focus`: the part to scroll to when the page opens (Settings › Accounts and Tasks' Connect open the accounts). */
export function ProvidersPage({ focus }: { focus?: "accounts" }) {
  const host = getHost();
  const [views, setViews] = useState<ProviderView[] | null>(null);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const acc = useAccounts();
  const accounts = useRef<HTMLDivElement>(null);

  const load = async () => {
    if (!host.providers) {
      setViews([]);
      return;
    }
    try {
      const list = await host.providers();
      setViews(list);
      setErr("");
      // one version at a time: each is a program started and waited for, and the Mac may have 8 GB
      for (const v of list) {
        if (!v.version || !v.found || !host.providerVersion) continue;
        const ver = await host.providerVersion(v.id).catch(() => null);
        if (ver) setVersions((cur) => ({ ...cur, [v.id]: ver }));
      }
    } catch (e) {
      setErr(errorText(e, ""));
    }
  };
  useEffect(() => {
    void load();
    void reloadAccounts();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (focus === "accounts") accounts.current?.scrollIntoView({ block: "start" });
  }, [focus, views === null]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The sign-in the Accounts copy read for the account new sessions of `id` use (Claude Code and Codex only). */
  const signinOf = (id: string): SignIn | null => {
    const g = acc.groups?.find((x) => x.cli === id);
    const st = acc.status[`${id}:${g?.active ?? "default"}`];
    return st ?? null;
  };

  const put = (v: ProviderView) => setViews((cur) => (cur ? cur.map((x) => (x.id === v.id ? v : x)) : cur));
  const toggle = async (v: ProviderView, on: boolean) => {
    if (!host.providerSave) return;
    try {
      put(await host.providerSave(v.id, { off: !on }));
      setErr("");
      // the + menu, Buddy and the drafts read the look-up again, so an agent turned off leaves them at once
      await getSessions().loadAgents();
    } catch (e) {
      setErr(errorText(e, shownName(v)));
    }
  };

  const view = views?.find((v) => v.id === chosen) ?? null;
  return (
    <div className="st-page prov" data-testid="providers-page">
      <div className="st-gh st-gh0">{t("set.providers")}</div>
      <p className="prov-lead">{t("prov.lead")}</p>
      {err && (
        <p className="ag-err" role="status" data-testid="providers-error">
          {err}
        </p>
      )}
      <div className="st-grp prov-list" data-testid="providers-list">
        {views === null && <div className="st-row ag-empty">{t("ss.lookingAgents")}</div>}
        {views?.length === 0 && <div className="st-row ag-empty">{t("prov.needsApp")}</div>}
        {views?.map((v) => {
          const s = statusLine(v, signinOf(v.id), planName);
          const open = chosen === v.id;
          return (
            <Fragment key={v.id}>
              <div className={`prov-row${open ? " open" : ""}${v.off ? " off" : ""}`} data-testid={`provider-row-${v.id}`} data-off={v.off}>
                <button
                  type="button"
                  className="prov-pick"
                  aria-expanded={open}
                  onClick={() => setChosen(open ? null : v.id)}
                  data-testid={`provider-open-${v.id}`}
                >
                  <AgentMark agent={v.id} size={16} />
                  <span className="prov-who">
                    <span className="prov-n">
                      <b>{shownName(v)}</b>
                      {v.name && <span className="prov-own">{v.label}</span>}
                      {versions[v.id] && (
                        <span className="prov-ver" data-testid={`provider-version-${v.id}`}>
                          {versions[v.id]}
                        </span>
                      )}
                    </span>
                    <span className={`prov-s ${s.tone}`} data-testid={`provider-status-${v.id}`}>
                      {s.text}
                    </span>
                  </span>
                </button>
                <Toggle on={!v.off} label={t("prov.switchOf", { agent: shownName(v) })} onChange={(on) => void toggle(v, on)} testId={`provider-switch-${v.id}`} />
              </div>
              {/* the chosen agent's settings open under its own row, where the person pressed */}
              {open && view && (
                <ProviderDetail
                  key={view.id}
                  v={view}
                  version={versions[view.id]}
                  signin={signinOf(view.id)}
                  onSaved={(next) => {
                    put(next);
                    void getSessions().loadAgents();
                  }}
                />
              )}
            </Fragment>
          );
        })}
      </div>

      <YourAgents
        onChanged={() => {
          void load();
        }}
      />

      <div ref={accounts} className="prov-acc">
        <AccountsPage embedded />
      </div>
    </div>
  );
}

/** The chosen agent's settings. Save sends what changed; the shell checks it and answers with the new view. */
export function ProviderDetail({ v, version, signin, onSaved }: { v: ProviderView; version?: string; signin: SignIn | null; onSaved: (v: ProviderView) => void }) {
  const host = getHost();
  const [f, setF] = useState<ProviderForm>(() => formOf(v));
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = shownName(v);
  const patch = patchOf(v, f);
  const set = (k: keyof ProviderForm, val: ProviderForm[typeof k]) => {
    setF((cur) => ({ ...cur, [k]: val }));
    setSaved(false);
  };

  const save = async () => {
    const local = checkForm(v, f);
    if (local) {
      setErr(refusalText(local, name));
      return;
    }
    if (isEmptyPatch(patch) || !host.providerSave) return;
    setBusy(true);
    try {
      const next = await host.providerSave(v.id, patch);
      onSaved(next);
      // the values just typed are not kept on the page: the rows go back to names
      setF(formOf(next));
      setErr("");
      setSaved(true);
    } catch (e) {
      setErr(errorText(e, name));
    } finally {
      setBusy(false);
    }
  };

  if (v.kind === "custom") {
    return (
      <div className="prov-detail" data-testid="provider-detail">
        <div className="st-row">
          <span className="st-k">
            <span>{t("prov.custom")}</span>
          </span>
        </div>
      </div>
    );
  }

  const status = statusLine(v, signin, planName);
  return (
    <form
      className="prov-detail"
      data-testid="provider-detail"
      onKeyDown={holdImeEnter}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="st-row prov-status">
        <div className="st-k">
          <b>{t("prov.status")}</b>
          <span data-testid="provider-detail-status">{status.text}</span>
          {version && <span>{t("prov.version", { v: version })}</span>}
          {v.found ? (
            <span className="prov-mono">{t("prov.foundAt", { path: v.found })}</span>
          ) : installLine(v.id) ? (
            <span className="prov-mono">{t("prov.install", { cmd: installLine(v.id) })}</span>
          ) : (
            // the App Store edition offers no install line (Guideline 2.4.5), and says why
            isAppStore() && <span data-testid="provider-install-store">{t("prov.installStore")}</span>
          )}
          {v.signin ? null : v.found && <span className="prov-quiet">{t("prov.cannotTell")}</span>}
        </div>
      </div>
      <Field id="name" label={t("prov.name")} hint={t("prov.nameHint", { agent: v.label })}>
        <input id="prov-name" className="ag-in" value={f.name} placeholder={v.label} maxLength={40} onChange={(e) => set("name", e.target.value)} data-testid="provider-name" />
      </Field>
      {v.takes_path && (
        <Field id="path" label={t("prov.path")} hint={t("prov.pathHint")}>
          <input
            id="prov-path"
            className="ag-in mono"
            value={f.path}
            placeholder={(!v.path && v.found) || t("prov.pathAuto")}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set("path", e.target.value)}
            data-testid="provider-path"
          />
        </Field>
      )}
      {v.home_var ? (
        <Field id="home" label={t("prov.home", { var: v.home_var })} hint={t("prov.homeHint")}>
          <input
            id="prov-home"
            className="ag-in mono"
            value={f.home}
            placeholder={t("prov.homeAuto")}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set("home", e.target.value)}
            data-testid="provider-home"
          />
        </Field>
      ) : null}
      <Field id="args" label={t("prov.args")} hint={v.takes_args ? t("prov.argsHint") : t("prov.argsNone", { agent: name })}>
        {v.takes_args && (
          <textarea
            id="prov-args"
            className="ag-in mono prov-args"
            value={f.args}
            rows={Math.min(6, Math.max(2, f.args.split("\n").length + 1))}
            placeholder={ARGS_EXAMPLE}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set("args", e.target.value)}
            data-testid="provider-args"
          />
        )}
      </Field>
      <Field id="vars" label={t("prov.vars")} hint={v.takes_vars ? t("prov.varsHint") : t("prov.varsNone", { agent: name })}>
        {v.takes_vars && (
          <div className="prov-vars" data-testid="provider-vars">
            {f.env.map((r, i) => (
              <div className="prov-var" key={i} data-testid="provider-var">
                <input
                  className="ag-in mono prov-var-n"
                  value={r.name}
                  placeholder={t("prov.varName")}
                  aria-label={t("prov.varName")}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => set("env", f.env.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  data-testid="provider-var-name"
                />
                <input
                  className="ag-in mono prov-var-v"
                  type="password"
                  value={r.value ?? ""}
                  placeholder={r.saved ? t("prov.varSaved") : t("prov.varValue")}
                  aria-label={t("prov.varValue")}
                  autoComplete="off"
                  onChange={(e) => set("env", f.env.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  data-testid="provider-var-value"
                />
                <button type="button" className="st-btn" onClick={() => set("env", f.env.filter((_, j) => j !== i))} aria-label={t("prov.varRemove", { name: r.name || String(i + 1) })} data-testid="provider-var-remove">
                  {t("ag.remove")}
                </button>
              </div>
            ))}
            <button type="button" className="st-btn prov-var-add" onClick={() => set("env", [...f.env, { name: "", value: "", saved: false }])} data-testid="provider-var-add">
              {t("prov.varAdd")}
            </button>
          </div>
        )}
      </Field>
      {/* the checks above are about a mistake or a pasted line in the person's own tool, and say so once */}
      {(v.takes_args || v.takes_vars) && (
        <p className="st-note prov-guard" data-testid="provider-guard">
          {t("prov.guard", { agent: name })}
        </p>
      )}
      {(v.chat || v.terminal) && (
        <div className="st-row prov-runs">
          <div className="st-k">
            {v.chat && (
              <span>
                {t("prov.runsChat")} <code data-testid="provider-runs-chat">{v.chat}</code>
              </span>
            )}
            {v.terminal && (
              <span>
                {t("prov.runsTerminal")} <code data-testid="provider-runs-terminal">{v.terminal}</code>
              </span>
            )}
          </div>
        </div>
      )}
      <div className="st-row ag-formfoot">
        <span className="ag-quiet" role="status" data-testid="provider-note">
          {err ? <span className="ag-err" data-testid="provider-error">{err}</span> : saved ? t("prov.saved") : ""}
        </span>
        <span className="ag-acts">
          <button type="button" className="st-btn" disabled={busy || isEmptyPatch(patch)} onClick={() => (setF(formOf(v)), setErr(""))} data-testid="provider-cancel">
            {t("prov.cancel")}
          </button>
          <button type="submit" className="st-btn ag-primary" disabled={busy || isEmptyPatch(patch)} data-testid="provider-save">
            {t("prov.save")}
          </button>
        </span>
      </div>
    </form>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint: string; children?: React.ReactNode }) {
  return (
    <div className="st-row prov-field">
      <label className="st-k" htmlFor={`prov-${id}`}>
        <b>{label}</b>
        <span>{hint}</span>
      </label>
      {children && <div className="st-v">{children}</div>}
    </div>
  );
}
