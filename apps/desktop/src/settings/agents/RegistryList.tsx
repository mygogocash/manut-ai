// Settings › Providers › From the ACP registry (item 101c): the agents of the Agent Client Protocol's registry, from the
// pinned copy the shell compiles in (src-tauri/src/acp_registry.rs), with a search. Each row: the agent's mark (item 122's
// logo where one is published, else its monogram), its name and description as the registry writes them, and Add… where
// the shell offers it; every other row says why not (already in Providers, already the person's own, set aside by the
// registry, not for this computer, ...). The pinned release and its date are said once, at the foot. Add… only asks the
// parent for the confirm card; nothing is written from here.
import { AgentIcon } from "../../ui";
import { t, tx } from "../../i18n";
import { pinnedText, registryMark, registryRows, SEARCH_MAX, stateText, type RegistryList as List, type RegistryOffer } from "./acpRegistry";

export function RegistryList({
  list,
  query,
  onQuery,
  busy,
  onAdd,
}: {
  /** null while the shell reads it */
  list: List | null;
  query: string;
  onQuery: (q: string) => void;
  busy: boolean;
  onAdd: (o: RegistryOffer) => void;
}) {
  const rows = list ? registryRows(list.agents, query) : [];
  return (
    <div className="areg" data-testid="acpreg">
      <div className="st-gh">{t("acpreg.title")}</div>
      <p className="st-note">{t("acpreg.hint")}</p>
      <div className="st-grp">
        <div className="st-row areg-search">
          <input
            type="search"
            className="ag-in"
            value={query}
            maxLength={SEARCH_MAX}
            placeholder={t("acpreg.search")}
            aria-label={t("acpreg.search")}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            onChange={(e) => onQuery(e.target.value)}
            data-testid="acpreg-search"
          />
        </div>
        <div className="areg-list" role="list" data-testid="acpreg-list">
          {list === null && <div className="st-row ag-empty">{t("acpreg.loading")}</div>}
          {list && rows.length === 0 && (
            <div className="st-row ag-empty" data-testid="acpreg-none">
              {t("acpreg.none")}
            </div>
          )}
          {rows.map((o) => (
            <div key={o.id} role="listitem" className={`st-row areg-row${o.state === "offered" ? "" : " held"}`} data-testid={`acpreg-row-${o.id}`} data-state={o.state}>
              <AgentIcon id={registryMark(o.id)} title={o.name} size={16} className="ag-mark areg-mark" />
              <div className="st-k areg-k">
                {/* the registry's own words: a product's name, version and description are its maker's, never translated */}
                <b className="areg-data">
                  {o.name}
                  {o.version && <span className="areg-v">{o.version}</span>}
                </b>
                {o.description && <span className="areg-data areg-d">{o.description}</span>}
              </div>
              <div className="st-v">
                {o.state === "offered" ? (
                  <button type="button" className="st-btn" disabled={busy} onClick={() => onAdd(o)} aria-label={t("acpreg.addOf", { name: o.name })} data-testid={`acpreg-add-${o.id}`}>
                    {t("acpreg.add")}
                  </button>
                ) : (
                  <span className="ag-quiet areg-why" data-testid={`acpreg-why-${o.id}`}>
                    {/* the registry's own reason stays in its words, as the names and descriptions do */}
                    {o.state === "quarantine" ? tx("acpreg.quarantine", { why: <span className="areg-data">{o.note}</span> }) : stateText(o)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      {list && (
        <p className="areg-foot" data-testid="acpreg-pin">
          {pinnedText(list.pin)}
        </p>
      )}
    </div>
  );
}
