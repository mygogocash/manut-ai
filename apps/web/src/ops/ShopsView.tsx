import type { CSSProperties } from "react";
import { useApi, type AuditPage, type GateShop, type ModelUsage, type PilotApi, type PilotGate, type Shop } from "../api";
import { formatDate, formatStamp } from "../format";
import { useLoad } from "./useLoad";
import { errorText, gateWords, isAuthError, modelSpendWords, shopsWords, spendLevel } from "./words";

/// The Shops overview: every pilot shop on one page, from routes the console already reads and nothing new. The shop list
/// (read by the console's side menu and passed in) gives the rows; the pilot gate gives each shop's trial day, whether it has
/// paid and whether it is active; the model meter gives this month's spend against the shop's cap; and the newest entry of
/// its audit log says when the log last changed. All of it is read at once, one request each, so a slow shop never holds
/// up another. A part that could not be read says so in its own cell and is named, with its shop, in a banner above the
/// table, and is never left out in silence. Each row links to the shop's other pages: the page opens on that shop.

/// The pages a shop's row opens, as the console names them. `shop` is the shop's own messages page.
export type ShopPage = "shop" | "drafts" | "audit" | "memory" | "people" | "model" | "connections" | "routines";

const OPEN_ORDER: readonly ShopPage[] = ["shop", "drafts", "audit", "memory", "people", "model", "connections", "routines"];

/// What reading one thing came to: its answer, or why there is none.
type Reading<T> = { ok: true; value: T } | { ok: false; error: unknown };
type ShopReading = { tenant: string; usage: Reading<ModelUsage>; audit: Reading<AuditPage> };
type Overview = { gate: Reading<PilotGate>; shops: ShopReading[] };

function settle<T>(promise: Promise<T>): Promise<Reading<T>> {
  return promise.then((value): Reading<T> => ({ ok: true, value }), (error: unknown): Reading<T> => ({ ok: false, error }));
}

/// Starts every read before waiting for any, then collects them: one failure never stops another.
async function readOverview(api: PilotApi, shops: readonly Shop[]): Promise<Overview> {
  const gate = settle(api.getGate());
  const each = shops.map((shop) => ({
    tenant: shop.tenant,
    usage: settle(api.getModelUsage(shop.tenant)),
    audit: settle(api.listAudit(shop.tenant, { limit: 1 })),
  }));
  return {
    gate: await gate,
    shops: await Promise.all(each.map(async (read) => ({ tenant: read.tenant, usage: await read.usage, audit: await read.audit }))),
  };
}

export function ShopsView({ shops, listError, onRetry, onOpen, onForget }: {
  shops: Shop[] | null;
  /// Why the shop list itself could not be read, which the console's side menu reads, when it could not.
  listError?: unknown;
  onRetry?: () => void;
  onOpen: (tenant: string, page: ShopPage) => void;
  onForget: () => void;
}) {
  const api = useApi();
  const overview = useLoad(shops && shops.length > 0 ? () => readOverview(api, shops) : null,
    `overview:${shops?.map((shop) => shop.tenant).join(",") ?? ""}`);
  const data = overview.data;

  // What could not be read: the gate as a whole, and each shop's parts, so the banner can name them.
  const failures = data
    ? (shops ?? []).flatMap((shop) => {
      const read = data.shops.find((entry) => entry.tenant === shop.tenant);
      const parts = [
        ...(read && !read.usage.ok ? [shopsWords.parts.usage] : []),
        ...(read && !read.audit.ok ? [shopsWords.parts.audit] : []),
      ];
      return parts.length > 0 ? [{ name: shop.name, parts }] : [];
    })
    : [];
  const refused = data ? [
    ...(data.gate.ok ? [] : [data.gate.error]),
    ...data.shops.flatMap((read) => [...(read.usage.ok ? [] : [read.usage.error]), ...(read.audit.ok ? [] : [read.audit.error])]),
  ].find(isAuthError) : undefined;
  const now = Date.now();
  // Without a shop list there are no rows to read, and the page says why rather than wait for ever.
  const listFailed = !shops && Boolean(listError);

  return (
    <>
      <div className="top">
        <h1>{shopsWords.title}</h1>
        <div className="acts">
          <button type="button" className="btn ghost" onClick={overview.reload}>
            {shopsWords.refresh}
          </button>
        </div>
      </div>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="hint" style={{ margin: 0, maxWidth: 880 }}>
          {shopsWords.intro}
        </p>
        {listFailed ? (
          <div className="banner err" role="alert">
            <span className="grow">{errorText(listError)}</span>
            {isAuthError(listError) ? (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
                {shopsWords.anotherKey}
              </button>
            ) : onRetry ? (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onRetry}>
                {shopsWords.tryAgain}
              </button>
            ) : null}
          </div>
        ) : refused ? (
          <div className="banner err" role="alert">
            <span className="grow">{errorText(refused)}</span>
            <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
              {shopsWords.anotherKey}
            </button>
          </div>
        ) : data ? (
          <>
            {!data.gate.ok ? (
              <div className="banner warn" role="alert">
                <span className="grow">{shopsWords.gateFailed}</span>
                <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={overview.reload}>
                  {shopsWords.tryAgain}
                </button>
              </div>
            ) : null}
            {failures.length > 0 ? (
              <div className="banner warn" role="alert">
                <span className="grow">{shopsWords.shopsFailed(failures)}</span>
                <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={overview.reload}>
                  {shopsWords.tryAgain}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
        {shops && shops.length === 0 ? (
          <div className="empty">
            <h3>{shopsWords.noShops}</h3>
            <p>{shopsWords.noShopsHint}</p>
          </div>
        ) : listFailed ? null : !data ? (
          <div className="skel" style={{ height: 160 }} aria-label={shopsWords.loading} />
        ) : (
          <div className="tblw">
            <table aria-label={shopsWords.tableLabel} style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th scope="col" style={HEAD}>{shopsWords.columns.shop}</th>
                  <th scope="col" style={HEAD}>{shopsWords.columns.trial}</th>
                  <th scope="col" style={HEAD}>{shopsWords.columns.paid}</th>
                  <th scope="col" style={HEAD}>
                    {data.gate.ok ? shopsWords.columns.active(data.gate.value.rules.trialDays) : shopsWords.columns.activeUnknown}
                  </th>
                  <th scope="col" style={HEAD}>{shopsWords.columns.spend}</th>
                  <th scope="col" style={HEAD}>{shopsWords.columns.audit}</th>
                  <th scope="col" style={HEAD}>{shopsWords.columns.open}</th>
                </tr>
              </thead>
              <tbody>
                {(shops ?? []).map((shop) => (
                  <ShopRow
                    key={shop.tenant}
                    shop={shop}
                    gate={data.gate}
                    read={data.shops.find((entry) => entry.tenant === shop.tenant)}
                    now={now}
                    onOpen={onOpen}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/// The canvas's data table look, as the Pilot gate's table has it, kept a real table so a screen reader announces each
/// shop's row and column.
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

const ACTIVE_TAG: Record<GateShop["activeOnDay14"], string> = { yes: "tag ok", no: "tag warn", not_yet: "tag" };

function ShopRow({ shop, gate, read, now, onOpen }: {
  shop: Shop;
  gate: Reading<PilotGate>;
  read: ShopReading | undefined;
  now: number;
  onOpen: (tenant: string, page: ShopPage) => void;
}) {
  const measured = gate.ok ? gate.value.shops.find((entry) => entry.tenant === shop.tenant) : undefined;
  const rules = gate.ok ? gate.value.rules : undefined;
  const unreadable = <span className="mut">{shopsWords.unreadable}</span>;
  return (
    <tr>
      <th scope="row" style={{ ...CELL, fontWeight: 500, whiteSpace: "nowrap" }}>
        {shop.name}
        <div className="mut" style={{ fontSize: 12, fontWeight: 400 }}>
          {shop.ownerName}
        </div>
        {/* Where the shop came from: its owner made it in the app, so no operator spoke with them first. */}
        {shop.selfServe ? (
          <div style={{ fontWeight: 400, marginTop: 4 }}>
            <span className="tag" title={shopsWords.selfServeHelp}>
              {shopsWords.selfServe}
            </span>
          </div>
        ) : null}
      </th>
      <td style={CELL}>{measured && rules ? <Trial shop={measured} trialDays={rules.trialDays} /> : unreadable}</td>
      <td style={{ ...CELL, whiteSpace: "nowrap" }}>
        {measured && rules ? <Paid shop={measured} priceSatang={rules.priceSatang} /> : unreadable}
      </td>
      <td style={CELL}>
        {measured ? <span className={ACTIVE_TAG[measured.activeOnDay14]}>{gateWords.active[measured.activeOnDay14]}</span> : unreadable}
      </td>
      <td style={CELL}>
        {read?.usage.ok ? (
          <>
            <div>{shopsWords.spendOf(read.usage.value.spentSatang, read.usage.value.capSatang)}</div>
            <span className={modelSpendWords.level[spendLevel(read.usage.value)].className}>
              {modelSpendWords.level[spendLevel(read.usage.value)].label}
            </span>
          </>
        ) : unreadable}
      </td>
      <td style={CELL}>
        {read?.audit.ok ? (
          read.audit.value.entries[0] ? formatStamp(read.audit.value.entries[0].at, now) : <span className="mut">{shopsWords.nothingRecorded}</span>
        ) : unreadable}
      </td>
      <td style={CELL}>
        <span style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
          {OPEN_ORDER.map((page) => (
            <button
              key={page}
              type="button"
              className="lk"
              aria-label={shopsWords.openLabel(shopsWords.open[page], shop.name)}
              onClick={() => onOpen(shop.tenant, page)}
            >
              {shopsWords.open[page]}
            </button>
          ))}
        </span>
      </td>
    </tr>
  );
}

/// The shop's trial as the Pilot gate says it.
function Trial({ shop, trialDays }: { shop: GateShop; trialDays: number }) {
  if (shop.day === null) return <span className="mut">{gateWords.startsWhen}</span>;
  if (shop.trialEnded) {
    return (
      <>
        {gateWords.dayAfter(shop.day)} <span className="tag">{gateWords.trialEnded}</span>
      </>
    );
  }
  return <>{gateWords.dayOf(shop.day, trialDays)}</>;
}

function Paid({ shop, priceSatang }: { shop: GateShop; priceSatang: number }) {
  if (shop.paid && shop.paidAt) {
    return (
      <>
        <span className="tag ok">{gateWords.paidTag}</span> {formatDate(shop.paidAt)}
      </>
    );
  }
  if (shop.paidSatang > 0) return <>{gateWords.partly(shop.paidSatang, priceSatang)}</>;
  return <span className="mut">{gateWords.notYet}</span>;
}
