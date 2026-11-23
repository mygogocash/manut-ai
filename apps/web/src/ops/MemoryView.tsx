import { MAX_TEXT } from "@manut/shop-memory";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, useApi, type Fact, type Memory, type Shop } from "../api";
import { useLoad } from "./useLoad";
import { errorText, factSourceText, isAuthError, memoryErrorText, memoryWords as W } from "./words";

/// The Memory page: what Buddy's team knows about one shop, as the API keeps it (`GET /v1/admin/memory`), laid out as
/// the design canvas's "Customize: memory and routines" board. "What your team knows" lists each fact with where it came
/// from, and Correct and Forget on it; "Waiting for your OK: not used until you confirm" lists what a customer said,
/// with "It's true" and Forget; "Tell Buddy something to remember" is a box for the owner's own words.
///
/// The owner has no account in the pilot, so the operator relays the owner's word, and the page says so. Forget asks once
/// more in its row, because the words are gone for good once it is answered. One change runs at a time: every button
/// waits while one is on its way, so a double press sends one request, and a fact that is already gone answers
/// not_found and the list is read again. The shop is chosen on the page, starting from the one in the side menu, so the
/// page stays open while the operator looks through several shops.

const TELL = "tell";

type Notice = { place: "known" | "tell"; text: string };

/// Newest first, the order the console lists things in. Facts made at one moment keep the later id first.
function newestFirst(facts: Fact[]): Fact[] {
  return [...facts].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id, "en", { numeric: true }));
}

/// The API answers 503 `memory_unavailable` when the shop's memory cannot be read: never an empty memory instead.
function loadErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === "memory_unavailable") return W.unavailable;
  return errorText(error);
}

const listStyle = { listStyle: "none", margin: 0, padding: 0 } as const;
const sectionStyle = { display: "flex", flexDirection: "column", gap: 8 } as const;
const textareaStyle = { padding: "10px 12px", minHeight: 76, resize: "vertical", lineHeight: 1.5 } as const;

export function MemoryView({ shops, tenant: chosen, onForget }: {
  shops: Shop[] | null;
  tenant: string | null;
  onForget: () => void;
}) {
  const api = useApi();
  const [tenant, setTenant] = useState(() => chosen ?? shops?.[0]?.tenant ?? "");
  const shop = shops?.find((s) => s.tenant === tenant) ?? null;
  const memory = useLoad(shop ? () => api.getMemory(shop.tenant) : null, `memory:${shop?.tenant ?? ""}`);

  // Keeps the chosen shop while the list still has it; one deleted meanwhile gives way to the first.
  useEffect(() => {
    if (!shops) return;
    setTenant((current) => (shops.some((s) => s.tenant === current) ? current : (shops[0]?.tenant ?? "")));
  }, [shops]);

  return (
    <>
      <div className="top">
        <h1>{W.title}</h1>
        {shops && shops.length > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="memory-shop" className="mut" style={{ fontSize: 13 }}>
              {W.shopLabel}
            </label>
            <select id="memory-shop" className="input" value={tenant} onChange={(event) => setTenant(event.target.value)}>
              {shops.map((s) => (
                <option key={s.tenant} value={s.tenant}>
                  {s.name}
                </option>
              ))}
            </select>
          </span>
        )}
        <div className="acts">
          <button type="button" className="btn ghost" onClick={memory.reload}>
            {W.refresh}
          </button>
        </div>
      </div>
      {memory.error ? (
        <div style={{ padding: "16px 16px 0" }}>
          <div className="banner err" role="alert">
            <span className="grow">{loadErrorText(memory.error)}</span>
            {isAuthError(memory.error) ? (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
                {W.anotherKey}
              </button>
            ) : (
              <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={memory.reload}>
                {W.tryAgain}
              </button>
            )}
          </div>
        </div>
      ) : null}
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16, maxWidth: 880 }}>
        {shop && (
          <p className="hint" style={{ margin: 0 }}>
            {W.intro(shop.ownerName)}
          </p>
        )}
        {shops && shops.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            {W.noShops}
          </p>
        ) : !shop || (!memory.data && !memory.error) ? (
          <div className="skel" style={{ height: 120 }} aria-label={W.loading} />
        ) : memory.data ? (
          // Keyed by the shop, so what one shop's page was doing is never carried over to another's.
          <MemoryBoard key={shop.tenant} shop={shop} memory={memory.data} reload={memory.reload} />
        ) : null}
      </div>
    </>
  );
}

function MemoryBoard({ shop, memory, reload }: { shop: Shop; memory: Memory; reload: () => void }) {
  const api = useApi();
  // The change on its way, by the fact it is for (or TELL for the box), and a guard that holds even between two presses
  // that arrive before the page has drawn the first one's answer.
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const confirmed = newestFirst(memory.facts.filter((fact) => fact.status === "confirmed"));
  const waiting = newestFirst(memory.facts.filter((fact) => fact.status === "waiting"));

  /// One change. On success the list is read again and `done` is said where the operator is looking; when it did not
  /// happen, why is said in the row it was for, and a fact that is already gone also reads the list again.
  async function change(key: string, work: () => Promise<unknown>, done: Notice): Promise<boolean> {
    if (running.current) return false;
    running.current = true;
    setBusy(key);
    setNotice(null);
    setErrors(({ [key]: _cleared, ...rest }) => rest);
    try {
      await work();
      setNotice(done);
      reload();
      return true;
    } catch (error) {
      setErrors((current) => ({ ...current, [key]: memoryErrorText(error) }));
      if (error instanceof ApiError && error.code === "not_found") reload();
      return false;
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  const known: Notice = { place: "known", text: "" };
  const confirm = (fact: Fact) =>
    change(fact.id, () => api.confirmFact({ tenant: shop.tenant, id: fact.id }), { ...known, text: W.confirmed });
  const correct = (fact: Fact, text: string) =>
    change(fact.id, () => api.correctFact({ tenant: shop.tenant, id: fact.id, text }), { ...known, text: W.correctedDone });
  const forget = (fact: Fact) =>
    change(fact.id, () => api.forgetFact({ tenant: shop.tenant, id: fact.id }), { ...known, text: W.forgotten });
  const remember = (text: string) =>
    change(TELL, () => api.rememberFact({ tenant: shop.tenant, text }), { place: "tell", text: W.remembered });

  const row = (fact: Fact, group: "known" | "waiting") => (
    <FactRow
      key={fact.id}
      fact={fact}
      group={group}
      ownerName={shop.ownerName}
      busy={busy}
      error={errors[fact.id]}
      onConfirm={() => confirm(fact)}
      onCorrect={(text) => correct(fact, text)}
      onForget={() => forget(fact)}
    />
  );

  return (
    <>
      <section aria-labelledby="memory-known" style={sectionStyle}>
        <div className="band">
          <h2 id="memory-known" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {W.knownTitle}
          </h2>
          <span>{W.knownCount(confirmed.length)}</span>
        </div>
        {notice?.place === "known" && <Said text={notice.text} />}
        {confirmed.length === 0 ? (
          <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
            {W.knownEmpty}
          </p>
        ) : (
          <ul aria-label={W.knownTitle} style={listStyle}>
            {confirmed.map((fact) => row(fact, "known"))}
          </ul>
        )}
        {memory.forgottenCount > 0 && (
          <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
            {W.forgottenNote(memory.forgottenCount)}
          </p>
        )}
      </section>

      {waiting.length > 0 && (
        <section aria-labelledby="memory-waiting" style={sectionStyle}>
          <div className="band">
            <h2 id="memory-waiting" className="h2" style={{ fontSize: 13, color: "inherit" }}>
              {W.waitingTitle}
            </h2>
            <span>{W.waitingCount(waiting.length)}</span>
          </div>
          <ul aria-label={W.waitingTitle} style={listStyle}>
            {waiting.map((fact) => row(fact, "waiting"))}
          </ul>
        </section>
      )}

      <section aria-labelledby="memory-tell" style={sectionStyle}>
        <div className="band">
          <h2 id="memory-tell" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {W.tellTitle}
          </h2>
        </div>
        <RememberForm
          busy={busy}
          error={errors[TELL]}
          notice={notice?.place === "tell" ? notice.text : null}
          onRemember={remember}
        />
      </section>
    </>
  );
}

function Said({ text }: { text: string }) {
  return (
    <div className="banner ok" role="status">
      <span className="grow">{text}</span>
    </div>
  );
}

/// One fact: its words, where it came from, and what the operator can do with it for the owner. A known fact can be
/// corrected in place or forgotten; a waiting one is confirmed ("It's true") or forgotten.
function FactRow({ fact, group, ownerName, busy, error, onConfirm, onCorrect, onForget }: {
  fact: Fact;
  group: "known" | "waiting";
  ownerName: string;
  busy: string | null;
  error: string | undefined;
  onConfirm: () => Promise<boolean>;
  onCorrect: (text: string) => Promise<boolean>;
  onForget: () => Promise<boolean>;
}) {
  const [mode, setMode] = useState<"view" | "correct" | "forget">("view");
  const [draft, setDraft] = useState(fact.text);
  // Once Forget is answered the row says so and shows nothing of the words, until the list is read again and drops it.
  const [gone, setGone] = useState(false);
  const textId = `fact-${fact.id}`;
  const working = busy === fact.id;
  const locked = busy !== null;
  const trimmed = draft.trim();
  const length = [...trimmed].length;
  const tooLong = length > MAX_TEXT;

  const frame = { flexWrap: "nowrap", alignItems: "flex-start", borderTop: "1px solid var(--line)" } as const;
  if (gone) {
    return (
      <li className="rowl" style={frame}>
        <span className="mut">{W.forgotten}</span>
      </li>
    );
  }

  async function save() {
    if (length < 1 || tooLong || locked) return;
    if (await onCorrect(trimmed)) setMode("view");
  }

  return (
    <li className="rowl" style={frame}>
      <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        {mode === "correct" ? (
          <>
            <textarea
              className="input"
              rows={3}
              aria-label={W.correctLabel}
              aria-describedby={`${textId}-help`}
              aria-invalid={tooLong ? true : undefined}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              style={textareaStyle}
            />
            <div id={`${textId}-help`} className={tooLong ? "help err" : "help"}>
              {W.tellHelp(length)}
            </div>
          </>
        ) : (
          <span id={textId} style={{ overflowWrap: "anywhere" }}>
            {fact.text}
            {fact.correctedAt !== undefined && (
              <>
                {" "}
                <span className="tag">{W.corrected}</span>
              </>
            )}
          </span>
        )}
        <span className="mut" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
          {W.sourceLabel} {factSourceText(fact.source, ownerName)}
        </span>
        {error && (
          <div className="banner err" role="alert">
            <span className="grow">{error}</span>
          </div>
        )}
        {mode === "forget" && (
          <div className="banner warn">
            <span className="grow">{W.forgetAsk(ownerName)}</span>
            <button
              type="button"
              className="btn danger"
              disabled={locked}
              aria-busy={working ? true : undefined}
              onClick={() => void onForget().then((done) => done && setGone(true))}
            >
              {W.forgetYes}
            </button>
            <button type="button" className="btn ghost" disabled={locked} onClick={() => setMode("view")}>
              {W.forgetNo}
            </button>
          </div>
        )}
        {mode === "correct" && (
          <div className="chips">
            <button
              type="button"
              className="btn dark"
              disabled={locked || length < 1 || tooLong}
              aria-busy={working ? true : undefined}
              onClick={() => void save()}
            >
              {working ? W.saving : W.saveCorrection}
            </button>
            <button type="button" className="btn ghost" disabled={locked} onClick={() => setMode("view")}>
              {W.cancel}
            </button>
          </div>
        )}
      </div>
      {mode === "view" && (
        <div className="chips" style={{ flex: "none" }}>
          {group === "waiting" ? (
            <button
              type="button"
              className="btn dark"
              disabled={locked}
              aria-busy={working ? true : undefined}
              aria-describedby={textId}
              onClick={() => void onConfirm()}
            >
              {W.confirm}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={locked}
              aria-describedby={textId}
              onClick={() => {
                setDraft(fact.text);
                setMode("correct");
              }}
            >
              {W.correct}
            </button>
          )}
          <button type="button" className="btn ghost" disabled={locked} aria-describedby={textId} onClick={() => setMode("forget")}>
            {W.forget}
          </button>
        </div>
      )}
    </li>
  );
}

/// "Tell Buddy something to remember": the owner's own fact, 1 to 280 characters, counted the way the API counts them.
/// What was typed stays in the box when the API refuses it, so it can be fixed rather than typed again.
function RememberForm({ busy, error, notice, onRemember }: {
  busy: string | null;
  error: string | undefined;
  notice: string | null;
  onRemember: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const length = [...trimmed].length;
  const tooLong = length > MAX_TEXT;
  const working = busy === TELL;
  const blocked = length < 1 || tooLong || busy !== null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    if (await onRemember(trimmed)) setText("");
  }

  return (
    <form aria-label={W.tellTitle} onSubmit={(event) => void submit(event)} style={{ ...sectionStyle, padding: "0 10px" }}>
      <div className="field">
        <label htmlFor="memory-new">{W.tellLabel}</label>
        <textarea
          id="memory-new"
          className="input"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-invalid={tooLong ? true : undefined}
          aria-describedby="memory-new-help"
          style={textareaStyle}
        />
        <div id="memory-new-help" className={tooLong ? "help err" : "help"}>
          {W.tellHelp(length)}
        </div>
      </div>
      {error && (
        <div className="banner err" role="alert">
          <span className="grow">{error}</span>
        </div>
      )}
      {notice && <Said text={notice} />}
      <div>
        <button type="submit" className="btn dark" disabled={blocked} aria-busy={working ? true : undefined}>
          {W.remember}
        </button>
      </div>
    </form>
  );
}
