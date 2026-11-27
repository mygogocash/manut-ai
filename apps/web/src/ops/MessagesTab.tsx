import { useState, type FormEvent } from "react";
import {
  REPLY_MAX_LENGTH,
  useApi,
  type InboundMessage,
  type OwnerCard,
  type ProposedReply,
  type ReplyAction,
  type Shop,
} from "../api";
import { formatStamp, langOf } from "../format";
import { ChatIcon } from "../ui/marks";
import { CopyButton } from "./CopyButton";
import type { Loaded } from "./useLoad";
import { canRetryCard, cardRetryErrorText, cardText, errorText, ownerLineWords, stateAdvice, stateTag } from "./words";

/// The pilot's one team member. Operators write as Nam; the owner sees Nam's name on every request.
const PILOT_MEMBER = "Nam";

const CLAMP2 = {
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflowWrap: "anywhere",
} as const;

function customerName(message: InboundMessage | undefined): string {
  return message?.displayName ?? "A customer";
}

function initialOf(name: string): string {
  return name.replace(/^khun\s+/i, "").trim().charAt(0).toUpperCase() || "?";
}

export function MessagesTab({
  shop,
  messages,
  actions,
  onChanged,
}: {
  shop: Shop;
  messages: Loaded<InboundMessage[]>;
  actions: Loaded<ReplyAction[]>;
  onChanged: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const actionById = new Map((actions.data ?? []).map((a) => [a.actionId, a]));
  const messageById = new Map((messages.data ?? []).map((m) => [m.id, m]));
  const selected = selectedId ? messageById.get(selectedId) : undefined;

  return (
    <div className="split" role="tabpanel" id="panel-messages" aria-labelledby="tab-messages">
      <div className="pane" style={{ padding: 16, gap: 20 }}>
        <section aria-labelledby="messages-title" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="band">
            <h2 id="messages-title" className="h2" style={{ fontSize: 13, color: "inherit" }}>
              Customer messages
            </h2>
            <span>Newest first</span>
          </div>
          {messages.error ? (
            <div className="banner err" role="alert">
              <span className="grow">{errorText(messages.error)}</span>
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={messages.reload}>
                Try again
              </button>
            </div>
          ) : !messages.data ? (
            <div className="skel" style={{ height: 120 }} aria-label="Loading messages" />
          ) : messages.data.length === 0 ? (
            <div className="empty">
              <span className="ico">
                <ChatIcon />
              </span>
              <h3>No messages yet</h3>
              <p>
                {shop.lineConnectionId
                  ? "Messages customers send to the shop's LINE account show here."
                  : "This shop has no LINE account connected yet, so no messages can arrive."}
              </p>
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              {messages.data.map((message) => {
                const name = customerName(message);
                const action = message.replyActionId ? actionById.get(message.replyActionId) : undefined;
                const tag = action ? stateTag(action.state, shop.ownerName) : null;
                const isSelected = message.id === selectedId;
                return (
                  <li key={message.id}>
                    <button
                      type="button"
                      className="rowl"
                      aria-pressed={isSelected}
                      onClick={() => setSelectedId(message.id)}
                      style={{
                        width: "100%",
                        flexWrap: "nowrap",
                        alignItems: "flex-start",
                        background: isSelected ? "var(--hov)" : undefined,
                      }}
                    >
                      <span className="av" style={{ background: "#EDE1B6" }} aria-hidden="true">
                        {initialOf(name)}
                      </span>
                      <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                          <span style={{ fontWeight: 500 }}>{name}</span>
                          <span className="mut" style={{ fontSize: 12.5 }}>
                            {formatStamp(message.receivedAt)}
                          </span>
                        </span>
                        <span lang={langOf(message.text)} style={CLAMP2}>
                          {message.text}
                        </span>
                      </span>
                      <span className={tag ? tag.className : "tag"} style={{ flex: "none" }}>
                        {tag ? tag.label : "No reply yet"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="replies-title" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div className="band">
            <h2 id="replies-title" className="h2" style={{ fontSize: 13, color: "inherit" }}>
              Replies
            </h2>
            <span>Newest first</span>
          </div>
          {actions.error ? (
            <div className="banner err" role="alert">
              <span className="grow">{errorText(actions.error)}</span>
            </div>
          ) : !actions.data ? (
            <div className="skel" style={{ height: 80 }} aria-label="Loading replies" />
          ) : actions.data.length === 0 ? (
            <p className="hint" style={{ padding: "8px 10px", margin: 0 }}>
              No replies proposed yet.
            </p>
          ) : (
            <ul aria-label="Replies" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {actions.data.map((action) => (
                <ActionRow
                  key={action.actionId}
                  action={action}
                  shop={shop}
                  customer={customerName(messageById.get(action.messageId))}
                  onChanged={onChanged}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <aside className="side2" aria-label="Reply">
        {selected ? (
          <Composer
            key={selected.id}
            shop={shop}
            message={selected}
            previous={selected.replyActionId ? actionById.get(selected.replyActionId) : undefined}
            onProposed={onChanged}
          />
        ) : (
          <div className="empty">
            <span className="ico">
              <ChatIcon />
            </span>
            <h3>Pick a message</h3>
            <p>Choose a customer message on the left to write Nam's reply.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

function ActionRow({
  action,
  shop,
  customer,
  onChanged,
}: {
  action: ReplyAction;
  shop: Shop;
  customer: string;
  onChanged: () => void;
}) {
  const ownerName = shop.ownerName;
  const tag = stateTag(action.state, ownerName);
  const advice = stateAdvice(action.state, ownerName);
  const steps = [`Proposed ${formatStamp(action.proposedAt)}`];
  if (action.decidedAt) steps.push(`answered ${formatStamp(action.decidedAt)}`);
  if (action.dispatchedAt) steps.push(`sent ${formatStamp(action.dispatchedAt)}`);
  return (
    <li className="rowl" style={{ flexWrap: "nowrap", alignItems: "flex-start", borderTop: "1px solid var(--line)" }}>
      <span className={tag.className} style={{ flex: "none" }}>
        {tag.label}
      </span>
      <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span lang={langOf(action.replyText)} style={CLAMP2}>
          {action.replyText}
        </span>
        <span className="mut" style={{ fontSize: 12.5 }}>
          To {customer}. {steps.join(", ")}.
        </span>
        {advice && (
          <span className="mut" style={{ fontSize: 12.5 }}>
            {advice}
          </span>
        )}
        {action.ownerCard && <CardLine card={action.ownerCard} action={action} shop={shop} onChanged={onChanged} />}
      </div>
      {action.state === "proposed" && <CopyButton text={action.approvalUrl} label="Copy link" what="approval link" />}
    </li>
  );
}

/// Where the owner's card about this reply stands on LINE, and, while the reply still waits and the card may not have
/// arrived, a way to send it again. Every push carries the same retry key, so LINE never shows it twice.
function CardLine({
  card,
  action,
  shop,
  onChanged,
}: {
  card: OwnerCard;
  action: ReplyAction;
  shop: Shop;
  onChanged: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.retryOwnerCard(shop.tenant, action.actionId);
      onChanged();
    } catch (err) {
      setError(cardRetryErrorText(err, shop.ownerName));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="mut" style={{ fontSize: 12.5 }}>
        {cardText(card, shop.ownerName)}
      </span>
      {canRetryCard(card, action.state) && (
        <button
          type="button"
          className="lk"
          style={{ alignSelf: "flex-start", fontSize: 12.5 }}
          disabled={busy}
          aria-busy={busy ? true : undefined}
          onClick={() => void retry()}
        >
          {busy ? ownerLineWords.retrying : ownerLineWords.retry}
        </button>
      )}
      {error && (
        <span className="help err" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function Composer({
  shop,
  message,
  previous,
  onProposed,
}: {
  shop: Shop;
  message: InboundMessage;
  previous: ReplyAction | undefined;
  onProposed: () => void;
}) {
  const api = useApi();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProposedReply | null>(null);
  const trimmed = text.trim();
  const tooLong = trimmed.length > REPLY_MAX_LENGTH;
  const name = customerName(message);

  async function propose(event: FormEvent) {
    event.preventDefault();
    if (busy || !trimmed || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      const proposed = await api.proposeReply({ tenant: shop.tenant, messageId: message.id, text: trimmed });
      setResult(proposed);
      setText("");
      onProposed();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void propose(event)} aria-labelledby="composer-title" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 id="composer-title" className="h2">
        Reply to {name}
      </h2>
      <figure style={{ margin: 0, padding: "10px 12px", borderRadius: "var(--rad)", background: "var(--soft)" }}>
        <figcaption className="mut" style={{ fontSize: 12.5, fontWeight: 500 }}>
          {name} wrote at {formatStamp(message.receivedAt)}
        </figcaption>
        <blockquote lang={langOf(message.text)} style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {message.text}
        </blockquote>
      </figure>
      {previous && (
        <p className="hint" style={{ margin: 0 }}>
          A reply was already proposed for this message ({stateTag(previous.state, shop.ownerName).label.toLowerCase()}).
          Proposing again makes a new request with a new link.
        </p>
      )}
      <div className="field">
        <label htmlFor="reply-text">Reply as {PILOT_MEMBER}</label>
        <textarea
          id="reply-text"
          className="input"
          rows={6}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-invalid={tooLong ? true : undefined}
          aria-describedby="reply-help"
          style={{ padding: "10px 12px", minHeight: 140, resize: "vertical", lineHeight: 1.5 }}
        />
        <div id="reply-help" className={tooLong ? "help err" : "help"}>
          {shop.ownerName} sees exactly this text and approves it before anything is sent.{" "}
          {trimmed.length.toLocaleString("en-US")} of {REPLY_MAX_LENGTH.toLocaleString("en-US")} characters.
        </div>
      </div>
      {error && (
        <div className="banner err" role="alert">
          <span className="grow">{error}</span>
        </div>
      )}
      <div>
        <button
          type="submit"
          className="btn dark"
          disabled={busy || !trimmed || tooLong}
          aria-busy={busy ? true : undefined}
        >
          {busy ? "Proposing" : "Propose reply"}
        </button>
      </div>
      {result && (
        <div className="box rise" role="status" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontWeight: 500 }}>Approval link for {shop.ownerName}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="input mono"
              readOnly
              value={result.approvalUrl}
              aria-label="Approval link"
              onFocus={(event) => event.currentTarget.select()}
              style={{ flex: "1 1 220px", fontSize: 12.5 }}
            />
            <CopyButton text={result.approvalUrl} what="approval link" />
          </div>
          <p className="help" style={{ margin: 0 }}>
            Send it to {shop.ownerName} on LINE. It answers this one reply only and works until{" "}
            {formatStamp(result.expiresAt)}.
          </p>
        </div>
      )}
    </form>
  );
}
