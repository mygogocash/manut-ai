import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { ApiError, useApi, type GateMeasure, type GateShop, type NewSubscriptionPayment, type PilotGate,
  type SubscriptionPayment } from "../api";
import { formatBaht, formatDate, formatStamp, parseBahtToSatang } from "../format";
import { useLoad } from "./useLoad";
import { errorText, gateWords, isAuthError, subscriptionErrorText } from "./words";

/// The Pilot gate: the roadmap's Phase 1 gate as the API measures it (`GET /v1/admin/pilot/gate`), for every shop at
/// once rather than the one chosen in the side menu. The main column says where the pilot stands: the status, the
/// two shares against their lines, and each shop's trial, payment and activity. The side column records a shop's
/// own payment to Manut AI, which is what the paid share counts; customers' order payments stay in each shop's
/// PromptPay tab.

export function GateView({ onForget }: { onForget: () => void }) {
  const api = useApi();
  const gate = useLoad(() => api.getGate(), "gate");
  const data = gate.data;

  return (
    <>
      <div className="top">
        <h1>{gateWords.title}</h1>
        {data && (
          <span className="mut" style={{ fontSize: 13 }}>
            {gateWords.measured(data.asOf)}
          </span>
        )}
        <div className="acts">
          <button type="button" className="btn ghost" onClick={gate.reload}>
            {gateWords.refresh}
          </button>
        </div>
      </div>
      {gate.error ? (
        <div style={{ padding: "16px 16px 0" }}>
          <div className="banner err" role="alert">
            <span className="grow">{gateErrorText(gate.error)}</span>
            {isAuthError(gate.error) ? (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
                {gateWords.anotherKey}
              </button>
            ) : (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={gate.reload}>
                {gateWords.tryAgain}
              </button>
            )}
          </div>
        </div>
      ) : null}
      {data ? (
        <div className="split">
          <div className="pane" style={{ padding: 16, gap: 16 }}>
            <p className="hint" style={{ margin: 0 }}>
              {gateWords.intro(data)}
            </p>
            <StatusBanner gate={data} />
            <div className="grid">
              <MeasureTile
                id="gate-paid-title"
                title={gateWords.paidTitle(data.rules.priceSatang)}
                help={gateWords.paidHelp(data.rules.priceSatang)}
                measure={data.cohort.paid}
                counted={data.cohort.counted}
              />
              <MeasureTile
                id="gate-active-title"
                title={gateWords.activeTitle(data.rules.trialDays)}
                help={gateWords.activeHelp(data.rules.activeWindowDays, data.rules.trialDays)}
                measure={data.cohort.active}
                counted={data.cohort.counted}
              />
            </div>
            <CohortTable gate={data} />
          </div>
          <aside className="side2" aria-label={gateWords.sideLabel}>
            {data.shops.length > 0 ? (
              <RecordSubscription gate={data} onRecorded={gate.reload} />
            ) : (
              <p className="hint" style={{ margin: 0 }}>
                {gateWords.noShops}
              </p>
            )}
          </aside>
        </div>
      ) : !gate.error ? (
        <div style={{ padding: 16 }}>
          <div className="skel" style={{ height: 160 }} aria-label={gateWords.loading} />
        </div>
      ) : null}
    </>
  );
}

/// The API answers 503 `gate_unavailable` when it could not read every shop: it measures all of them or none, so a
/// shop is never quietly left out of the shares.
function gateErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === "gate_unavailable") return gateWords.unavailable;
  return errorText(error);
}

function StatusBanner({ gate }: { gate: PilotGate }) {
  const { status } = gate.cohort;
  const tone = status === "on_track" ? "banner ok" : status === "below_line" ? "banner warn" : "banner";
  return (
    <div className={tone}>
      <strong>{gateWords.status[status]}</strong>
      <span className="grow">{gateWords.statusText(gate)}</span>
    </div>
  );
}

function MeasureTile({
  id,
  title,
  help,
  measure,
  counted,
}: {
  id: string;
  title: string;
  help: string;
  measure: GateMeasure;
  counted: number;
}) {
  return (
    <section className="box" aria-labelledby={id} style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 id={id} className="h2">
        {title}
      </h2>
      {measure.percent === null ? (
        <div className="big">{gateWords.noShare}</div>
      ) : (
        <div className="num">{measure.percent}%</div>
      )}
      <div className="bar" aria-hidden="true">
        <span style={{ width: `${measure.percent ?? 0}%` }} />
      </div>
      <span className="mut" style={{ fontSize: 13 }}>
        {gateWords.shareOf(measure.count, counted)}
      </span>
      {measure.percent !== null && (
        <span className={measure.met ? "tag ok" : "tag warn"}>
          {measure.met ? gateWords.meets(measure.thresholdPercent) : gateWords.under(measure.thresholdPercent)}
        </span>
      )}
      <span className="hint" style={{ margin: 0 }}>
        {help}
      </span>
    </section>
  );
}

/// The canvas's data table look (`tblw`, and `tbh` and `tbr` drawn on real table cells), kept a real table so a
/// screen reader announces each shop's row and column.
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

function CohortTable({ gate }: { gate: PilotGate }) {
  const { rules, shops, cohort } = gate;
  // "Today" is the day the gate was measured, so every stamp in the table reads from the same moment.
  const measuredAt = Date.parse(gate.asOf);
  return (
    <section aria-labelledby="gate-shops-title" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="band">
        <h2 id="gate-shops-title" className="h2" style={{ fontSize: 13, color: "inherit" }}>
          {gateWords.shopsTitle}
        </h2>
        <span>{gateWords.shopsNote(cohort.counted, shops.length)}</span>
      </div>
      {shops.length === 0 ? (
        <p className="hint" style={{ padding: "8px 10px", margin: 0 }}>
          {gateWords.noShops}
        </p>
      ) : (
        <div className="tblw">
          <table aria-labelledby="gate-shops-title" style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th scope="col" style={HEAD}>{gateWords.columns.shop}</th>
                <th scope="col" style={HEAD}>{gateWords.columns.started}</th>
                <th scope="col" style={HEAD}>{gateWords.columns.today}</th>
                <th scope="col" style={HEAD}>{gateWords.columns.paid}</th>
                <th scope="col" style={HEAD}>{gateWords.columns.active(rules.trialDays)}</th>
                <th scope="col" style={HEAD}>{gateWords.columns.lastDecision}</th>
              </tr>
            </thead>
            <tbody>
              {shops.map((shop) => (
                <ShopRow key={shop.tenant} shop={shop} rules={rules} measuredAt={measuredAt} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const ACTIVE_TAG: Record<GateShop["activeOnDay14"], string> = { yes: "tag ok", no: "tag warn", not_yet: "tag" };

function ShopRow({ shop, rules, measuredAt }: { shop: GateShop; rules: PilotGate["rules"]; measuredAt: number }) {
  return (
    <tr>
      <th scope="row" style={{ ...CELL, fontWeight: 500 }}>
        {shop.name}
        {/* A shop its owner made in the app is listed with the others and counted only once an operator adds it. */}
        {shop.selfServe ? (
          <div style={{ fontWeight: 400, marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
            <span>
              <span className="tag">{gateWords.selfServe}</span>
            </span>
            <span className="mut" style={{ fontSize: 12 }}>
              {shop.inCohort === false ? gateWords.leftOut : gateWords.addedIn}
            </span>
          </div>
        ) : null}
      </th>
      <td style={CELL}>{shop.trialStartedAt ? formatDate(shop.trialStartedAt) : gateWords.notStarted}</td>
      <td style={CELL}>
        {shop.day === null ? (
          <span className="mut">{gateWords.startsWhen}</span>
        ) : shop.trialEnded ? (
          <>
            {gateWords.dayAfter(shop.day)} <span className="tag">{gateWords.trialEnded}</span>
          </>
        ) : (
          gateWords.dayOf(shop.day, rules.trialDays)
        )}
      </td>
      <td style={CELL}>
        {shop.paid && shop.paidAt ? (
          <>
            <span className="tag ok">{gateWords.paidTag}</span> {formatDate(shop.paidAt)}
          </>
        ) : shop.paidSatang > 0 ? (
          gateWords.partly(shop.paidSatang, rules.priceSatang)
        ) : (
          <span className="mut">{gateWords.notYet}</span>
        )}
      </td>
      <td style={CELL}>
        <span className={ACTIVE_TAG[shop.activeOnDay14]}>{gateWords.active[shop.activeOnDay14]}</span>
      </td>
      <td style={CELL}>{shop.lastDecisionAt ? formatStamp(shop.lastDecisionAt, measuredAt) : gateWords.noDecision}</td>
    </tr>
  );
}

/// The form for a shop's payment to Manut AI, and the payments already recorded for the chosen shop, so the
/// operator sees a slip is there before recording it again (the API refuses it anyway).
function RecordSubscription({ gate, onRecorded }: { gate: PilotGate; onRecorded: () => void }) {
  const api = useApi();
  const shops = gate.shops;
  // The price as an operator types it (499), since that is almost always what a shop pays.
  const price = formatBaht(gate.rules.priceSatang).slice(1);
  const [tenant, setTenant] = useState(() => shops[0]?.tenant ?? "");
  const [amount, setAmount] = useState(price);
  const [slipRef, setSlipRef] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<{ amount?: string; slip?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  const payments = useLoad(tenant ? () => api.listSubscriptionPayments(tenant) : null, `subscriptions:${tenant}`);
  const shopName = shops.find((shop) => shop.tenant === tenant)?.name ?? "";

  // Keeps the chosen shop while the gate still lists it; one deleted meanwhile gives way to the first.
  useEffect(() => {
    setTenant((current) => (shops.some((shop) => shop.tenant === current) ? current : (shops[0]?.tenant ?? "")));
  }, [shops]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !tenant) return;
    const amountSatang = parseBahtToSatang(amount);
    const ref = slipRef.trim();
    const found: { amount?: string; slip?: string } = {};
    if (amountSatang === null) found.amount = gateWords.badAmount;
    if (!ref) found.slip = gateWords.noSlip;
    setProblems(found);
    setRecorded(null);
    setError(null);
    if (amountSatang === null || !ref) return;

    const input: NewSubscriptionPayment = { tenant, amountSatang, slipRef: ref };
    if (note.trim()) input.slipNote = note.trim();
    setBusy(true);
    try {
      const payment = await api.recordSubscriptionPayment(input);
      setRecorded(gateWords.recorded(payment.amountSatang, shopName, payment.slipRef));
      setAmount(price);
      setSlipRef("");
      setNote("");
      payments.reload();
      onRecorded();
    } catch (err) {
      setError(subscriptionErrorText(err, shopName));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form
        noValidate
        onSubmit={(event) => void submit(event)}
        aria-labelledby="sub-title"
        style={{ display: "flex", flexDirection: "column", gap: 12 }}
      >
        <h2 id="sub-title" className="h2">
          {gateWords.formTitle}
        </h2>
        <p className="hint" style={{ margin: 0 }}>
          {gateWords.formHint}
        </p>
        <div className="field">
          <label htmlFor="sub-shop">{gateWords.shopLabel}</label>
          <select
            id="sub-shop"
            className="input"
            value={tenant}
            onChange={(event) => {
              setTenant(event.target.value);
              setRecorded(null);
              setError(null);
            }}
          >
            {shops.map((shop) => (
              <option key={shop.tenant} value={shop.tenant}>
                {shop.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sub-amount">{gateWords.amountLabel}</label>
          <input
            id="sub-amount"
            className="input"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            aria-invalid={problems.amount ? true : undefined}
            onChange={(event) => setAmount(event.target.value)}
          />
          {problems.amount && <div className="help err">{problems.amount}</div>}
        </div>
        <div className="field">
          <label htmlFor="sub-slip">{gateWords.slipLabel}</label>
          <input
            id="sub-slip"
            className="input"
            autoComplete="off"
            spellCheck={false}
            maxLength={128}
            value={slipRef}
            aria-invalid={problems.slip ? true : undefined}
            aria-describedby="sub-slip-help"
            onChange={(event) => setSlipRef(event.target.value)}
          />
          <div id="sub-slip-help" className={problems.slip ? "help err" : "help"}>
            {problems.slip ?? gateWords.slipHelp}
          </div>
        </div>
        <div className="field">
          <label htmlFor="sub-note">{gateWords.noteLabel}</label>
          <input
            id="sub-note"
            className="input"
            autoComplete="off"
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {error && (
          <div className="banner err" role="alert">
            <span className="grow">{error}</span>
          </div>
        )}
        {recorded && (
          <div className="banner ok" role="status">
            <span className="grow">{recorded}</span>
          </div>
        )}
        <div>
          <button type="submit" className="btn dark" disabled={busy || !tenant} aria-busy={busy ? true : undefined}>
            {busy ? gateWords.submitting : gateWords.submit}
          </button>
        </div>
      </form>
      <section aria-labelledby="sub-list-title" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div className="band">
          <h2 id="sub-list-title" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {gateWords.listTitle(shopName)}
          </h2>
          <span>{gateWords.newestFirst}</span>
        </div>
        <SubscriptionList
          payments={payments.data}
          error={payments.error}
          onRetry={payments.reload}
          measuredAt={Date.parse(gate.asOf)}
        />
      </section>
    </>
  );
}

function SubscriptionList({
  payments,
  error,
  onRetry,
  measuredAt,
}: {
  payments: SubscriptionPayment[] | null;
  error: unknown;
  onRetry: () => void;
  measuredAt: number;
}) {
  if (error) {
    return (
      <div className="banner err" role="alert">
        <span className="grow">{errorText(error)}</span>
        <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onRetry}>
          {gateWords.tryAgain}
        </button>
      </div>
    );
  }
  if (!payments) return <div className="skel" style={{ height: 60 }} aria-label={gateWords.listLoading} />;
  if (payments.length === 0) {
    return (
      <p className="hint" style={{ padding: "8px 10px", margin: 0 }}>
        {gateWords.listEmpty}
      </p>
    );
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {payments.map((payment) => (
        <li
          key={payment.id}
          className="rowl"
          style={{ flexWrap: "nowrap", alignItems: "flex-start", borderTop: "1px solid var(--line)" }}
        >
          <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span>{gateWords.listItem(payment.amountSatang, payment.slipRef)}</span>
            <span className="mut" style={{ fontSize: 12.5 }}>
              {gateWords.listWhen(payment.confirmedAt, measuredAt)}
            </span>
            {payment.slipNote && (
              <span className="mut" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
                {payment.slipNote}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
