import { useEffect, useState, type CSSProperties } from "react";
import { useApi, type ModelAlerts, type ModelCall, type ModelUsage, type Shop } from "../api";
import { formatStamp } from "../format";
import { ModelCapForm } from "./ModelCapForm";
import { useLoad, type Loaded } from "./useLoad";
import {
  alertsErrorText,
  callOutcomeTag,
  isAuthError,
  modelErrorText,
  modelSpendWords,
  moneyText,
  monthName,
  monthsBack,
  percentUsed,
  spendLevel,
} from "./words";

/// The Model spend page: first the shops near or at their caps this month, across all shops
/// (`GET /v1/admin/model/alerts`), then one shop's model spend for one Bangkok month against its monthly cap
/// (`GET /v1/admin/model/usage`, docs/model-gateway.md), and the form that sets or clears the cap. The shop is chosen on
/// the page, starting from the one chosen in the side menu or from the list's Show, and so is the month, which is the
/// current one until another is picked. Every figure is what the API answered: spend rounded up and what is left rounded
/// down, so the page never shows a shop more room than it has. Nothing here computes money; the only sum is the share of
/// the cap used, which is integer arithmetic for the bar.

/// The months the picker offers before this one.
const EARLIER_MONTHS = 11;

export function ModelSpendView({ shops, tenant: chosen, onForget }: {
  shops: Shop[] | null;
  tenant: string | null;
  onForget: () => void;
}) {
  const api = useApi();
  const [tenant, setTenant] = useState(() => chosen ?? shops?.[0]?.tenant ?? "");
  // `null` is this month. The API decides which month that is, so the page never asks for the current one by name.
  const [month, setMonth] = useState<string | null>(null);
  // The month the API said was current, from an answer to a request that named none: what the picker counts back from.
  const [currentMonth, setCurrentMonth] = useState<string | null>(null);
  const shop = shops?.find((s) => s.tenant === tenant) ?? null;
  const usage = useLoad(shop ? () => api.getModelUsage(shop.tenant, month ?? undefined) : null,
    `model:${shop?.tenant ?? ""}:${month ?? "now"}`);
  // One read across all shops, whatever shop or month the page shows: the API keeps the list in one record.
  const alerts = useLoad(() => api.getModelAlerts(), "model-alerts");
  const data = usage.data;
  // Remembered while rendering rather than in an effect, so the picker lists the earlier months with the first answer.
  if (month === null && data && data.month !== currentMonth) setCurrentMonth(data.month);

  // Keeps the chosen shop while the list still has it; one deleted meanwhile gives way to the first.
  useEffect(() => {
    if (!shops) return;
    setTenant((current) => (shops.some((s) => s.tenant === current) ? current : (shops[0]?.tenant ?? "")));
  }, [shops]);

  return (
    <>
      <div className="top">
        <h1>{modelSpendWords.title}</h1>
        {shops && shops.length > 0 && (
          <>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label htmlFor="model-shop" className="mut" style={{ fontSize: 13 }}>
                {modelSpendWords.shopLabel}
              </label>
              <select id="model-shop" className="input" value={tenant} onChange={(event) => setTenant(event.target.value)}>
                {shops.map((s) => (
                  <option key={s.tenant} value={s.tenant}>
                    {s.name}
                  </option>
                ))}
              </select>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label htmlFor="model-month" className="mut" style={{ fontSize: 13 }}>
                {modelSpendWords.monthLabel}
              </label>
              <select
                id="model-month"
                className="input"
                value={month ?? ""}
                onChange={(event) => setMonth(event.target.value || null)}
              >
                <option value="">{modelSpendWords.thisMonth}</option>
                {monthsBack(currentMonth ?? "", EARLIER_MONTHS).map((earlier) => (
                  <option key={earlier} value={earlier}>
                    {monthName(earlier)}
                  </option>
                ))}
              </select>
            </span>
          </>
        )}
        <div className="acts">
          <button type="button" className="btn ghost" onClick={() => {
            usage.reload();
            alerts.reload();
          }}>
            {modelSpendWords.refresh}
          </button>
        </div>
      </div>
      {usage.error ? (
        <div style={{ padding: "16px 16px 0" }}>
          <div className="banner err" role="alert">
            <span className="grow">{modelErrorText(usage.error, "read")}</span>
            {isAuthError(usage.error) ? (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
                {modelSpendWords.anotherKey}
              </button>
            ) : (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={usage.reload}>
                {modelSpendWords.tryAgain}
              </button>
            )}
          </div>
        </div>
      ) : null}
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16, maxWidth: 880 }}>
        <p className="hint" style={{ margin: 0 }}>
          {modelSpendWords.intro}
        </p>
        <NearCapList alerts={alerts} shops={shops} onShow={(chosenTenant) => {
          setTenant(chosenTenant);
          setMonth(null);
        }} />
        {shops && shops.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            {modelSpendWords.noShops}
          </p>
        ) : !shop || (!data && !usage.error) ? (
          <div className="skel" style={{ height: 160 }} aria-label={modelSpendWords.loading} />
        ) : data ? (
          <>
            <MonthPanel usage={data} current={month === null} />
            {/* A new cap can put a shop on the list above or take it off, so both are read again. */}
            <ModelCapForm key={shop.tenant} shop={shop} usage={data} onChanged={() => {
              usage.reload();
              alerts.reload();
            }} onForget={onForget} />
            <CallsTable shop={shop} usage={data} />
          </>
        ) : null}
      </div>
    </>
  );
}

/// The shops whose model spend has reached 80% of their cap this month, or all of it, from the API's one list: each with
/// its tag, the crossing it reached last, and a button that shows it below. A shop the console's own list does not have
/// (deleted since it loaded) is named by its tenant id. Its failure says so here and leaves the rest of the page.
function NearCapList({ alerts, shops, onShow }: {
  alerts: Loaded<ModelAlerts>;
  shops: Shop[] | null;
  onShow: (tenant: string) => void;
}) {
  const now = Date.now();
  const listed = alerts.data;
  return (
    <section aria-labelledby="model-alerts-title" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 id="model-alerts-title" className="h2">
        {modelSpendWords.alertsTitle}
      </h2>
      <p className="mut" style={{ margin: 0, fontSize: 13 }}>
        {modelSpendWords.alertsHelp}
      </p>
      {alerts.error ? (
        <div className="banner err" role="alert">
          <span className="grow">{alertsErrorText(alerts.error)}</span>
          <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={alerts.reload}>
            {modelSpendWords.tryAgain}
          </button>
        </div>
      ) : !listed ? (
        <div className="skel" style={{ height: 48 }} aria-label={modelSpendWords.alertsLoading} />
      ) : listed.shops.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          {modelSpendWords.alertsEmpty}
        </p>
      ) : (
        <ul aria-label={modelSpendWords.alertsTitle} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex",
          flexDirection: "column", gap: 8 }}>
          {listed.shops.map((alert) => {
            const name = shops?.find((s) => s.tenant === alert.tenant)?.name ?? alert.tenant;
            const tag = modelSpendWords.alertTag(alert.percent);
            const last = alert.crossings[alert.crossings.length - 1];
            return (
              <li key={alert.tenant} className="box" style={{ padding: "10px 14px", display: "flex", flexWrap: "wrap",
                alignItems: "center", gap: 10 }}>
                <strong>{name}</strong>
                <span className={tag.className}>{tag.label}</span>
                {last && (
                  <span className="mut grow" style={{ fontSize: 13 }}>
                    {modelSpendWords.crossingText(last, now)}
                  </span>
                )}
                <button type="button" className="btn ghost" aria-label={modelSpendWords.showLabel(name)}
                  onClick={() => onShow(alert.tenant)}>
                  {modelSpendWords.showButton}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {listed?.truncated && (
        <p className="mut" style={{ margin: 0, fontSize: 13 }}>
          {modelSpendWords.alertsTruncated(listed.shops.length)}
        </p>
      )}
    </section>
  );
}

/// The month's four figures and where they stand against the cap: a level tag, a bar of the share used, the thresholds
/// its charged spend has reached, and the counts of calls made and refused.
function MonthPanel({ usage, current }: { usage: ModelUsage; current: boolean }) {
  const level = spendLevel(usage);
  const tag = modelSpendWords.level[level];
  const percent = percentUsed(usage);
  const used = modelSpendWords.usedText(percent);
  // The holds say how many calls are in progress. An answer that leaves them out, or that holds money with none listed,
  // is not guessed at.
  const inProgress = usage.heldSatang === 0 ? 0 : usage.holds?.length || null;
  const outcomes = modelSpendWords.outcomesText(usage.counts);
  const status = level === "empty"
    ? modelSpendWords.emptyText(usage.month, current)
    : level === "cap"
      ? modelSpendWords.atCapText(current, usage.capSatang)
      : used;
  return (
    <section aria-labelledby="model-month-title" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <h2 id="model-month-title" className="h2">
          {monthName(usage.month)}
        </h2>
        <span className={tag.className}>{tag.label}</span>
      </div>
      {/* The bar's own `flex: 1` would let a column shrink it to nothing, so its eight pixels are pinned. */}
      <div className="bar" role="progressbar" aria-label={used} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        style={{ flex: "none" }}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {status}
      </p>
      {(usage.crossings ?? []).map((crossing) => (
        <p key={crossing.percent} className="mut" style={{ margin: 0, fontSize: 13 }}>
          {modelSpendWords.crossingText(crossing)}
        </p>
      ))}
      {!current && (
        <p className="mut" style={{ margin: 0, fontSize: 13 }}>
          {modelSpendWords.pastNote}
        </p>
      )}
      <div className="grid">
        <Tile id="model-tile-spent" label={modelSpendWords.spentLabel} value={moneyText(usage.spentSatang)}
          help={modelSpendWords.spentHelp(usage.tokens)} />
        <Tile id="model-tile-held" label={modelSpendWords.heldLabel} value={moneyText(usage.heldSatang)}
          help={modelSpendWords.heldHelp(inProgress)} />
        <Tile id="model-tile-left" label={modelSpendWords.leftLabel} value={moneyText(usage.remainingSatang)}
          help={modelSpendWords.leftHelp} />
        <Tile id="model-tile-cap" label={modelSpendWords.capLabel} value={moneyText(usage.capSatang)}
          help={modelSpendWords.capSource(usage)} />
      </div>
      <p style={{ margin: 0 }}>{modelSpendWords.callsText(usage.counts)}</p>
      {outcomes && (
        <p className="mut" style={{ margin: 0, fontSize: 13 }}>
          {outcomes}
        </p>
      )}
    </section>
  );
}

function Tile({ id, label, value, help }: { id: string; label: string; value: string; help: string }) {
  return (
    <section className="box" aria-labelledby={id} style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
      <h2 id={id} className="h2">
        {label}
      </h2>
      <div className="num">{value}</div>
      <span className="hint" style={{ margin: 0 }}>
        {help}
      </span>
    </section>
  );
}

/// The Pilot gate's data table look, kept a real table so a screen reader announces each call's row and column.
const HEAD: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  padding: "10px",
  textAlign: "left",
  background: "var(--bg)",
  boxShadow: "0 1px 0 var(--line)",
  color: "var(--mut)",
  fontSize: 12.5,
  fontWeight: 500,
  whiteSpace: "nowrap",
};
const CELL: CSSProperties = {
  padding: "10px",
  textAlign: "left",
  verticalAlign: "top",
  borderTop: "1px solid var(--line)",
  fontSize: 13,
  fontVariantNumeric: "tabular-nums",
};

/// The month's call records as the API listed them, newest first. Nothing is shown for a month without any, or for an
/// answer that leaves them out.
function CallsTable({ shop, usage }: { shop: Shop; usage: ModelUsage }) {
  const calls = usage.calls ?? [];
  if (calls.length === 0) return null;
  const now = Date.now();
  const note = modelSpendWords.newestNote(calls.length, usage.counts);
  const columns = modelSpendWords.columns;
  return (
    <section aria-labelledby="model-calls-title" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="band">
        <h2 id="model-calls-title" className="h2" style={{ fontSize: 13, color: "inherit" }}>
          {modelSpendWords.callsTitle}
        </h2>
        {note && <span>{note}</span>}
      </div>
      <div className="tblw">
        <table aria-label={modelSpendWords.callsLabel(shop.name, usage.month)} style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th scope="col" style={HEAD}>{columns.when}</th>
              <th scope="col" style={HEAD}>{columns.model}</th>
              <th scope="col" style={HEAD}>{columns.tokens}</th>
              <th scope="col" style={{ ...HEAD, textAlign: "right" }}>{columns.cost}</th>
              <th scope="col" style={HEAD}>{columns.outcome}</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <CallRow key={call.id} call={call} now={now} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ padding: "8px 10px", margin: 0 }}>
        {modelSpendWords.roundingNote}
      </p>
    </section>
  );
}

function CallRow({ call, now }: { call: ModelCall; now: number }) {
  const tag = callOutcomeTag(call.outcome);
  return (
    <tr>
      {/* A time that is not one is shown as it came, so one odd record never stops the page. */}
      <td style={CELL}>{Number.isNaN(Date.parse(call.at)) ? call.at : formatStamp(call.at, now)}</td>
      <td style={CELL}>{call.model}</td>
      <td style={CELL}>{modelSpendWords.tokensText(call.inputTokens, call.outputTokens)}</td>
      <td style={{ ...CELL, textAlign: "right" }}>{moneyText(call.satang)}</td>
      <td style={CELL}>
        <span className={tag.className}>{tag.label}</span>
      </td>
    </tr>
  );
}
