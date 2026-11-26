import { useState, type FormEvent } from "react";
import { useApi, type CreatedShop, type ShopTemplate } from "../api";
import { useLoad } from "./useLoad";
import { isAuthError, newShopErrorText, newShopWords as W } from "./words";

/// The console's new-shop form (`POST /v1/admin/pilot/shops`): the shop's name, its owner's name, and the shop template
/// it starts from, if any. The templates are the API's own (`GET /v1/admin/templates`), in their own words; choosing one
/// says what it sets up: the members it turns on, its routines, each paused until the owner turns it on, and how many
/// questions Buddy asks the owner in the first week. The API refuses a template it does not know and then makes no shop,
/// so the form says so and keeps what was typed. One request at a time: a double press sends one.

export function NewShopForm({ onCreated, onCancel, onForget }: {
  onCreated: (created: CreatedShop) => void;
  /// Null while there is no shop to go back to.
  onCancel: (() => void) | null;
  onForget: () => void;
}) {
  const api = useApi();
  const templates = useLoad(() => api.listTemplates(), "templates");
  const [name, setName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const chosen = templates.data?.find((t) => t.id === template) ?? null;
  const ready = name.trim() !== "" && ownerName.trim() !== "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createShop({ name: name.trim(), ownerName: ownerName.trim(),
        ...(chosen ? { template: chosen.id } : {}) });
      onCreated(created);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "16px 16px 0", maxWidth: 640 }}>
      <form
        noValidate
        onSubmit={submit}
        aria-labelledby="new-shop-title"
        className="box"
        style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}
      >
        <h2 id="new-shop-title" className="h2">
          {W.title}
        </h2>
        <div className="field">
          <label htmlFor="new-shop-name">{W.nameLabel}</label>
          <input id="new-shop-name" className="input" autoComplete="off" value={name}
            onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="new-shop-owner">{W.ownerLabel}</label>
          <input id="new-shop-owner" className="input" autoComplete="off" value={ownerName}
            onChange={(event) => setOwnerName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="new-shop-template">{W.templateLabel}</label>
          <select id="new-shop-template" className="input" value={template} aria-describedby="new-shop-template-help"
            onChange={(event) => setTemplate(event.target.value)}>
            <option value="">{W.noTemplate}</option>
            {templates.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <div id="new-shop-template-help" className="help">
            {chosen ? null : W.noTemplateHelp}
          </div>
        </div>
        {templates.error ? (
          <div className="banner warn" role="status">
            <span className="grow">{W.templatesUnavailable}</span>
          </div>
        ) : null}
        {chosen && <TemplateSummary template={chosen} owner={ownerName.trim()} />}
        {error ? (
          <div className="banner err" role="alert">
            <span className="grow">{newShopErrorText(error)}</span>
            {isAuthError(error) && (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
                {W.anotherKey}
              </button>
            )}
          </div>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="submit" className="btn dark" disabled={!ready || busy} aria-busy={busy ? true : undefined}>
            {busy ? W.creating : W.create}
          </button>
          {onCancel && (
            <button type="button" className="btn" disabled={busy} onClick={onCancel}>
              {W.cancel}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/// What a template sets up, in its own words: which shops it fits, the members it turns on, its routines, and its
/// first-week questions, counted.
function TemplateSummary({ template, owner }: { template: ShopTemplate; owner: string }) {
  return (
    <section aria-label={W.summaryLabel(template.name)} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <p className="hint" style={{ margin: 0 }}>
        {template.fits}
      </p>
      <p style={{ margin: 0 }}>{W.teamLine(template.team)}</p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {template.routines.map((routine) => (
          <li key={`${routine.when} ${routine.does}`}>{W.routineLine(routine)}</li>
        ))}
      </ul>
      <p className="hint" style={{ margin: 0 }}>
        {W.routinesNote}
      </p>
      <p style={{ margin: 0 }}>{W.questionsLine(template.questions.length, owner)}</p>
    </section>
  );
}
