// Settings › Providers › Your agents (Settings › Agents until item 74, whose list of the agents the app offers is now the
// Providers list above it): the person's own Agent Client Protocol agents, which they add and remove here. Nothing is
// saved from the form: Save opens a confirm card that shows the exact command manut will run (the shell resolves it
// now), Cancel first and Add second, and only Add asks the shell to write the entry (src-tauri/src/custom_agents.rs).
// Removing asks once, then each open session of that agent ends. "Ask the bot" only puts a request in the current bot's
// composer; the bot's reply can hold a draft whose chip opens this same card (AgentConfirmCard). Under them, the ACP
// registry's agents (item 101c, RegistryList): Add… asks the shell for this same card, pre-filled from the registry's
// pinned copy and drafted as a bot's draft is, with where the agent comes from and how the person installs it; Change…
// opens the form with the same values, and Add is the same one call that writes.
import { useEffect, useState } from "react";
import "./agents.css";
import { AgentMark } from "../../sessions/AgentMark";
import { getHost } from "../../sessions/host";
import { getSessions, useSessions } from "../../sessions/sessions";
import { agentsPageModel, cardCommand, EMPTY_FORM, whyText, type CustomForm, type CustomList, type CustomPreview } from "../../sessions/custom";
import { registryError, type RegistryList as Registry, type RegistryOffer, type RegistrySource } from "./acpRegistry";
import { RegistryList } from "./RegistryList";
import { t, tx, type Key } from "../../i18n";
import { holdImeEnter } from "../../lib/ime";
import { getStore } from "../../state/store";

/** `onChanged`: an agent was added or removed (the Providers list reads its agents again). */
export function YourAgents({ onChanged }: { onChanged?: () => void }) {
  const ss = useSessions();
  const [custom, setCustom] = useState<CustomList | null>(null);
  const [form, setForm] = useState<CustomForm | null>(null);
  const [card, setCard] = useState<CustomPreview | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [query, setQuery] = useState("");

  const reload = async () => {
    try {
      setCustom(await getHost().customList());
    } catch (e) {
      setErr(whyText(e));
    }
    // the registry's rows say which agents are already the person's own, so they are read again with the file
    const host = getHost();
    if (host.acpRegistry) {
      try {
        setRegistry(await host.acpRegistry());
      } catch (e) {
        setErr(registryError(e));
      }
    }
  };
  useEffect(() => {
    if (ss.agents === null) void getSessions().loadAgents();
    void reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const m = agentsPageModel(ss.agents, custom);

  /** Save: the shell checks the fields and resolves the command; nothing is written. */
  const preview = async () => {
    if (!form) return;
    setBusy(true);
    setErr("");
    try {
      setCard(await getHost().customPreview(form.label, form.program, form.args, form.install));
    } catch (e) {
      setErr(whyText(e));
    } finally {
      setBusy(false);
    }
  };
  /** A registry entry's Add…: the shell drafts the same card from the pinned copy; nothing is written. */
  const fromRegistry = async (o: RegistryOffer) => {
    const host = getHost();
    if (!host.acpRegistryPreview) return;
    setBusy(true);
    setErr("");
    try {
      setCard(await host.acpRegistryPreview(o.id));
    } catch (e) {
      setErr(registryError(e));
    } finally {
      setBusy(false);
    }
  };
  /** The card's Change…: the Add agent form with the registry's values, for the person to change before Save. */
  const change = (c: CustomPreview) => {
    setForm({ label: c.entry.label, program: c.entry.program, args: c.entry.args.join(" "), install: c.entry.install });
    setCard(null);
    setErr("");
  };
  /** The card's Add: the one call that writes. */
  const add = async () => {
    if (!card) return;
    setBusy(true);
    try {
      await getHost().customConfirm(card.entry);
      setCard(null);
      setForm(null);
      setErr("");
      await reload();
      await getSessions().loadAgents();
      onChanged?.();
    } catch (e) {
      setCard(null);
      setErr(whyText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    try {
      await getHost().customRemove(id);
      setRemoving(null);
      await getSessions().endAgent(id);
      await reload();
      onChanged?.();
    } catch (e) {
      setErr(whyText(e));
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof CustomForm, label: Key, hint: Key, placeholder: string, mono = false) => (
    <div className="st-row">
      <label className="st-k" htmlFor={`ag-${k}`}>
        <b>{t(label)}</b>
        <span>{t(hint)}</span>
      </label>
      <div className="st-v">
        <input
          id={`ag-${k}`}
          className={`ag-in${mono ? " mono" : ""}`}
          value={form?.[k] ?? ""}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          onChange={(e) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f))}
          data-testid={`agent-form-${k}`}
        />
      </div>
    </div>
  );

  return (
    <div data-testid="agents-page">
      <div className="st-gh">{t("ag.yours")}</div>
      <p className="st-note">{t("ag.yoursHint")}</p>
      <div className="st-grp" data-testid="agents-mine">
        {m.mine.map((a) => (
          <div key={a.id} className="st-row ag-row" data-testid={`agents-mine-${a.id}`}>
            <div className="st-k">
              <b className="st-kt">
                <AgentMark agent={a.id} size={16} />
                {a.label}
              </b>
              <span className="ag-cmd" title={a.command}>
                {a.command}
              </span>
              {!a.found && <span className="ag-quiet">{t("ag.notFound", { program: a.program })}</span>}
            </div>
            <div className="st-v">
              <button type="button" className="st-btn" disabled={busy} onClick={() => setRemoving({ id: a.id, label: a.label })} data-testid={`agents-remove-${a.id}`}>
                {t("ag.remove")}
              </button>
            </div>
          </div>
        ))}
        {m.broken.map((b, i) => (
          <div key={`broken-${i}`} className="st-row ag-row" data-testid={`agents-broken-${b.id || i}`}>
            <div className="st-k">
              <b>{b.id ? t("ag.brokenNamed", { id: b.id }) : t("ag.broken")}</b>
              <span>{whyText(`why:${b.why}`)}</span>
            </div>
            {b.id && (
              <div className="st-v">
                <button type="button" className="st-btn" disabled={busy} onClick={() => setRemoving({ id: b.id, label: b.id })} data-testid={`agents-remove-${b.id}`}>
                  {t("ag.remove")}
                </button>
              </div>
            )}
          </div>
        ))}
        {custom && m.mine.length === 0 && m.broken.length === 0 && !form && <div className="st-row ag-empty">{t("ag.none")}</div>}
        {!form && (
          <div className="st-row ag-addrow">
            <button type="button" className="st-btn" onClick={() => (setForm({ ...EMPTY_FORM }), setErr(""))} data-testid="agents-add">
              {t("ag.add")}
            </button>
            {/* the bot drafts one: the request lands in the current bot's composer, nothing is sent */}
            <button type="button" className="st-btn" title={t("graph.prefill")} onClick={() => getStore().actions.prefill(t("ag.askText"))} data-testid="agents-ask-bot">
              {t("ag.ask")}
            </button>
          </div>
        )}
      </div>

      {removing && (
        <div className="ag-confirm" role="alertdialog" aria-label={t("ag.removeTitle")} data-testid="agents-remove-confirm">
          <span>{tx("ag.removeConfirm", { name: <b>{removing.label}</b> })}</span>
          <button type="button" className="st-btn" onClick={() => setRemoving(null)} data-testid="agents-remove-cancel">
            {t("ag.cancel")}
          </button>
          <button type="button" className="st-btn ag-danger" disabled={busy} onClick={() => void remove(removing.id)} data-testid="agents-remove-yes">
            {t("ag.remove")}
          </button>
        </div>
      )}

      {form && (
        <>
          <div className="st-gh">{t("ag.addTitle")}</div>
          <form
            className="st-grp"
            data-testid="agent-form"
            onKeyDown={holdImeEnter}
            onSubmit={(e) => {
              e.preventDefault();
              void preview();
            }}
          >
            {field("label", "ag.name", "ag.nameHint", "My Agent")}
            {field("program", "ag.program", "ag.programHint", "my-agent", true)}
            {field("args", "ag.args", "ag.argsHint", "acp", true)}
            {field("install", "ag.install", "ag.installHint", "npm install -g …", true)}
            <div className="st-row ag-formfoot">
              <span className="ag-quiet" data-testid="agent-form-nokeys">
                {t("ag.noKeys")}
              </span>
              <span className="ag-acts">
                <button type="button" className="st-btn" onClick={() => (setForm(null), setErr(""))} data-testid="agent-form-cancel">
                  {t("ag.cancel")}
                </button>
                <button type="submit" className="st-btn ag-primary" disabled={busy || !form.label.trim() || !form.program.trim()} data-testid="agent-form-save">
                  {t("ag.save")}
                </button>
              </span>
            </div>
          </form>
        </>
      )}
      {err && (
        <p className="ag-err" role="status" data-testid="agents-error">
          {err}
        </p>
      )}

      {getHost().acpRegistry && <RegistryList list={registry} query={query} onQuery={setQuery} busy={busy} onAdd={(o) => void fromRegistry(o)} />}

      {card && <AgentConfirmCard card={card} busy={busy} onCancel={() => setCard(null)} onAdd={() => void add()} onChange={card.registry ? () => change(card) : undefined} />}
    </div>
  );
}

/** The confirm card: the exact command manut will run, Cancel first and Add second. The same card opens from the Add
 *  agent form, from a bot's draft in the chat (chat/parts/AgentChip.tsx) and from the ACP registry; a draft's card names
 *  the bot that proposed it, a registry entry's says where it comes from and how the person installs it (Manut AI never
 *  runs or downloads it), with Change… to the form. The card writes nothing itself: its Add is the caller's one call to
 *  `customConfirm`. */
export function AgentConfirmCard({
  card,
  busy,
  onCancel,
  onAdd,
  onChange,
}: {
  card: CustomPreview;
  busy: boolean;
  onCancel: () => void;
  onAdd: () => void;
  /** a registry entry's card: open the form with its values */
  onChange?: () => void;
}) {
  return (
    <div className="ag-scrim" onClick={onCancel}>
      <div
        className="ag-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ag-card-t"
        data-testid="agent-confirm"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <b id="ag-card-t">{t("ag.cardTitle", { name: card.entry.label })}</b>
        {card.by && (
          <p className="ag-quiet" data-testid="agent-confirm-by">
            {t("ag.cardBy", { bot: card.by })}
          </p>
        )}
        <p>{t("ag.cardRuns")}</p>
        <code className={`ag-card-cmd${card.command ? "" : " missing"}`} data-testid="agent-confirm-command">
          {cardCommand(card)}
        </code>
        {!card.command && (
          <p className="ag-quiet" data-testid="agent-confirm-missing">
            {t("ag.notFound", { program: card.entry.program })}
          </p>
        )}
        {card.registry && <RegistryFrom src={card.registry} program={card.entry.program} />}
        <p className="ag-quiet">{t("ag.cardFolder")}</p>
        <p className="ag-quiet">{t("ag.cardApprovals")}</p>
        <div className="ag-acts">
          <button type="button" className="st-btn" autoFocus onClick={onCancel} data-testid="agent-confirm-cancel">
            {t("ag.cancel")}
          </button>
          {onChange && (
            <button type="button" className="st-btn" onClick={onChange} data-testid="agent-confirm-change">
              {t("acpreg.change")}
            </button>
          )}
          <button type="button" className="st-btn ag-primary" disabled={busy} onClick={onAdd} data-testid="agent-confirm-add">
            {t("ag.addBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Where a registry entry comes from and how the person installs it: an install line or an archive to download, each
 *  shown to copy and never run or fetched by the app, then its source and licence as the registry gives them. */
function RegistryFrom({ src, program }: { src: RegistrySource; program: string }) {
  return (
    <div className="ag-reg" data-testid="agent-confirm-registry">
      <p className="ag-quiet">{t("acpreg.cardFrom", { tag: src.tag, name: src.name, version: src.version })}</p>
      {src.install ? (
        <>
          <p>{t("acpreg.cardInstall")}</p>
          <code className="ag-card-cmd" data-testid="agent-confirm-install">
            {src.install}
          </code>
        </>
      ) : src.archive ? (
        <>
          <p>{t("acpreg.cardDownload", { program })}</p>
          <code className="ag-card-cmd" data-testid="agent-confirm-archive">
            {src.archive}
          </code>
          {src.sha256 && <code className="ag-card-cmd ag-reg-sum">{t("acpreg.cardSum", { sum: src.sha256 })}</code>}
        </>
      ) : null}
      {(src.repository || src.website) && <p className="ag-quiet">{t("acpreg.cardSource", { url: src.repository || src.website })}</p>}
      {src.license && <p className="ag-quiet">{t("acpreg.cardLicense", { license: src.license })}</p>}
    </div>
  );
}
