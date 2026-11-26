import { promptPayPayload } from "@manut/promptpay";
import { useEffect, useState, type FormEvent } from "react";
import { useApi, type NewPayment, type Payment, type Shop } from "../api";
import { formatBaht, formatStamp, parseBahtToSatang } from "../format";
import { QrIcon } from "../ui/marks";
import { QrCode } from "./QrCode";
import { useLoad } from "./useLoad";
import { errorText } from "./words";

type Qr =
  | { kind: "empty" }
  | { kind: "badId" }
  | { kind: "badAmount" }
  | { kind: "ready"; payload: string; amountSatang: number | undefined };

/// The QR a customer scans. No amount gives a code the customer types the amount into. The payload comes
/// from @manut/promptpay, which refuses an id it cannot place rather than guess at one.
function buildQr(id: string, amountText: string): Qr {
  const trimmedId = id.trim();
  if (!trimmedId) return { kind: "empty" };
  let amountSatang: number | undefined;
  if (amountText.trim()) {
    const parsed = parseBahtToSatang(amountText);
    if (parsed === null) return { kind: "badAmount" };
    amountSatang = parsed;
  }
  try {
    const payload = promptPayPayload(amountSatang === undefined ? { id: trimmedId } : { id: trimmedId, amountSatang });
    return { kind: "ready", payload, amountSatang };
  } catch {
    return { kind: "badId" };
  }
}

const BAD_ID = "This is not a PromptPay phone number, national id, tax id or e-wallet id.";
const BAD_AMOUNT = "Write the amount in baht, like 1,290 or 1,290.50.";

export function PaymentsTab({ shop }: { shop: Shop }) {
  const api = useApi();
  const payments = useLoad(() => api.listPayments(shop.tenant), `payments:${shop.tenant}`);
  const [promptPayId, setPromptPayId] = useState("");
  const [qrAmount, setQrAmount] = useState("");
  const [idTouched, setIdTouched] = useState(false);

  // Start from the id the shop was last paid to, so the operator rarely types it.
  useEffect(() => {
    const last = payments.data?.[0]?.promptPayId;
    if (last && !idTouched) setPromptPayId((current) => current || last);
  }, [payments.data, idTouched]);

  const qr = buildQr(promptPayId, qrAmount);

  return (
    <div className="split" role="tabpanel" id="panel-payments" aria-labelledby="tab-payments">
      <section className="pane" aria-labelledby="qr-title" style={{ padding: 16, gap: 14 }}>
        <h2 id="qr-title" className="h2">
          PromptPay QR
        </h2>
        <p className="hint" style={{ margin: 0 }}>
          Make a code for a customer to scan in any Thai bank app. It pays straight to {shop.name}'s PromptPay.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <div className="field" style={{ flex: "1 1 220px" }}>
            <label htmlFor="pp-id">Shop's PromptPay id</label>
            <input
              id="pp-id"
              className="input"
              inputMode="numeric"
              autoComplete="off"
              value={promptPayId}
              aria-invalid={qr.kind === "badId" ? true : undefined}
              aria-describedby="pp-id-help"
              onChange={(event) => {
                setIdTouched(true);
                setPromptPayId(event.target.value);
              }}
            />
            <div id="pp-id-help" className={qr.kind === "badId" ? "help err" : "help"}>
              {qr.kind === "badId" ? BAD_ID : "Phone number, national id, tax id or e-wallet id."}
            </div>
          </div>
          <div className="field" style={{ flex: "1 1 160px" }}>
            <label htmlFor="pp-amount">Amount in baht</label>
            <input
              id="pp-amount"
              className="input"
              inputMode="decimal"
              autoComplete="off"
              placeholder="1,290"
              value={qrAmount}
              aria-invalid={qr.kind === "badAmount" ? true : undefined}
              aria-describedby="pp-amount-help"
              onChange={(event) => setQrAmount(event.target.value)}
            />
            <div id="pp-amount-help" className={qr.kind === "badAmount" ? "help err" : "help"}>
              {qr.kind === "badAmount" ? BAD_AMOUNT : "Leave it empty and the customer types the amount."}
            </div>
          </div>
        </div>
        {qr.kind === "ready" ? (
          <figure className="box pop" style={{ margin: 0, padding: 16, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <QrCode
              text={qr.payload}
              label={`PromptPay QR code, ${qr.amountSatang === undefined ? "any amount" : formatBaht(qr.amountSatang)} to ${promptPayId.trim()}`}
            />
            <figcaption style={{ textAlign: "center" }}>
              <div className="big">{qr.amountSatang === undefined ? "Any amount" : formatBaht(qr.amountSatang)}</div>
              <div className="mut" style={{ fontSize: 13 }}>
                To PromptPay {promptPayId.trim()}
              </div>
            </figcaption>
          </figure>
        ) : (
          <div className="empty box">
            <span className="ico">
              <QrIcon />
            </span>
            <h3>No code yet</h3>
            <p>Enter the shop's PromptPay id to make a code.</p>
          </div>
        )}
      </section>

      <aside className="side2" aria-label="Payments">
        <RecordPayment shop={shop} promptPayId={promptPayId} onRecorded={payments.reload} />
        <section aria-labelledby="payments-title" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="band">
            <h2 id="payments-title" className="h2" style={{ fontSize: 13, color: "inherit" }}>
              Recorded payments
            </h2>
            <span>Newest first</span>
          </div>
          <PaymentList payments={payments.data} error={payments.error} onRetry={payments.reload} />
        </section>
      </aside>
    </div>
  );
}

function RecordPayment({
  shop,
  promptPayId,
  onRecorded,
}: {
  shop: Shop;
  promptPayId: string;
  onRecorded: () => void;
}) {
  const api = useApi();
  const [orderRef, setOrderRef] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<{ order?: string; amount?: string; id?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<Payment | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const amountSatang = parseBahtToSatang(amount);
    const id = promptPayId.trim();
    const found: { order?: string; amount?: string; id?: string } = {};
    if (!orderRef.trim()) found.order = "Write the order number, like SP-2301.";
    if (amountSatang === null) found.amount = BAD_AMOUNT;
    if (!id || buildQr(id, "").kind !== "ready") found.id = "Enter the shop's PromptPay id in the QR section first.";
    setProblems(found);
    setRecorded(null);
    setError(null);
    if (found.order || found.amount || found.id || amountSatang === null) return;

    const input: NewPayment = { tenant: shop.tenant, orderRef: orderRef.trim(), amountSatang, promptPayId: id };
    if (note.trim()) input.slipNote = note.trim();
    setBusy(true);
    try {
      const payment = await api.recordPayment(input);
      setRecorded(payment);
      setOrderRef("");
      setAmount("");
      setNote("");
      onRecorded();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-labelledby="slip-title"
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <h2 id="slip-title" className="h2">
        Slip checked in the bank app
      </h2>
      <p className="hint" style={{ margin: 0 }}>
        Record a payment only after you see the money arrive in {shop.ownerName}'s bank app. A slip photo alone is
        not proof.
      </p>
      <div className="field">
        <label htmlFor="pay-order">Order</label>
        <input
          id="pay-order"
          className="input"
          autoComplete="off"
          placeholder="SP-2301"
          value={orderRef}
          aria-invalid={problems.order ? true : undefined}
          onChange={(event) => setOrderRef(event.target.value)}
        />
        {problems.order && <div className="help err">{problems.order}</div>}
      </div>
      <div className="field">
        <label htmlFor="pay-amount">Amount in baht</label>
        <input
          id="pay-amount"
          className="input"
          inputMode="decimal"
          autoComplete="off"
          placeholder="1,290"
          value={amount}
          aria-invalid={problems.amount ? true : undefined}
          onChange={(event) => setAmount(event.target.value)}
        />
        {problems.amount && <div className="help err">{problems.amount}</div>}
      </div>
      <div className="field">
        <label htmlFor="pay-note">Note (optional)</label>
        <input
          id="pay-note"
          className="input"
          autoComplete="off"
          placeholder="Slip time 14:02"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      <p className={problems.id ? "help err" : "help"} style={{ margin: 0 }}>
        {problems.id ?? (promptPayId.trim() ? `Paid to PromptPay ${promptPayId.trim()}.` : "No PromptPay id yet.")}
      </p>
      {error && (
        <div className="banner err" role="alert">
          <span className="grow">{error}</span>
        </div>
      )}
      {recorded && (
        <div className="banner ok" role="status">
          <span className="grow">
            Recorded. Order {recorded.orderRef}, {formatBaht(recorded.amountSatang)}.
          </span>
        </div>
      )}
      <div>
        <button type="submit" className="btn dark" disabled={busy} aria-busy={busy ? true : undefined}>
          {busy ? "Recording" : "Record payment"}
        </button>
      </div>
    </form>
  );
}

function PaymentList({
  payments,
  error,
  onRetry,
}: {
  payments: Payment[] | null;
  error: unknown;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <div className="banner err" role="alert">
        <span className="grow">{errorText(error)}</span>
        <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (!payments) return <div className="skel" style={{ height: 80 }} aria-label="Loading payments" />;
  if (payments.length === 0) {
    return (
      <p className="hint" style={{ padding: "8px 10px", margin: 0 }}>
        No payments recorded yet.
      </p>
    );
  }
  return (
    <ul aria-label="Recorded payments" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {payments.map((payment) => (
        <li
          key={payment.id}
          className="rowl"
          style={{ flexWrap: "nowrap", alignItems: "flex-start", borderTop: "1px solid var(--line)" }}
        >
          <span className="tag ok" style={{ flex: "none" }}>
            Paid
          </span>
          <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span>
              Order {payment.orderRef}, {formatBaht(payment.amountSatang)}
            </span>
            <span className="mut" style={{ fontSize: 12.5 }}>
              Confirmed {formatStamp(payment.confirmedAt)}. PromptPay {payment.promptPayId}.
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
