import { parseMoney } from "@manut/format";
import { useState, type FormEvent } from "react";
import { MODEL_CAP_MAX_SATANG, useApi, type ModelUsage, type Shop } from "../api";
import { isAuthError, modelErrorText, modelSpendWords } from "./words";

/// The form that sets a shop's monthly cap or clears its override (`PUT /v1/admin/model/cap`). The cap is typed in baht
/// and read by `parseMoney` into whole satang, from the digits as text and never through a float. What it cannot read,
/// and what is over the API's limit, is refused here before anything is sent. What the form confirms is the cap the API
/// answered, which is what was written, not what was typed.

function readCap(text: string): { capSatang: number } | { problem: string } {
  const satang = parseMoney(text);
  if (satang === null) return { problem: modelSpendWords.badCap };
  if (satang > MODEL_CAP_MAX_SATANG) return { problem: modelSpendWords.tooBigCap };
  return { capSatang: satang };
}

export function ModelCapForm({ shop, usage, onChanged, onForget }: {
  shop: Shop;
  usage: ModelUsage;
  /// The cap changed, so the month's figures are read again.
  onChanged: () => void;
  onForget: () => void;
}) {
  const api = useApi();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"set" | "clear" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const hasOverride = usage.capSource === "override";

  async function change(capSatang: number | null) {
    setBusy(capSatang === null ? "clear" : "set");
    try {
      const answer = await api.setModelCap({ tenant: shop.tenant, capSatang });
      setDone(modelSpendWords.capAnswer(shop.name, answer));
      if (capSatang !== null) setText("");
      onChanged();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setDone(null);
    setError(null);
    const read = readCap(text);
    if ("problem" in read) {
      setProblem(read.problem);
      return;
    }
    setProblem(null);
    void change(read.capSatang);
  }

  function clear() {
    if (busy || !hasOverride) return;
    setProblem(null);
    setDone(null);
    setError(null);
    void change(null);
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-labelledby="model-cap-title"
      className="box"
      style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}
    >
      <h2 id="model-cap-title" className="h2">
        {modelSpendWords.formTitle}
      </h2>
      <div className="field">
        <label htmlFor="model-cap">{modelSpendWords.capInputLabel}</label>
        <input
          id="model-cap"
          className="input"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={text}
          aria-invalid={problem ? true : undefined}
          aria-describedby="model-cap-help"
          onChange={(event) => setText(event.target.value)}
        />
        <div id="model-cap-help" className={problem ? "help err" : "help"}>
          {problem ?? modelSpendWords.capInputHelp}
        </div>
      </div>
      {error ? (
        <div className="banner err" role="alert">
          <span className="grow">{modelErrorText(error, "write")}</span>
          {isAuthError(error) && (
            <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
              {modelSpendWords.anotherKey}
            </button>
          )}
        </div>
      ) : null}
      {done && (
        <div className="banner ok" role="status">
          <span className="grow">{done}</span>
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <button type="submit" className="btn dark" disabled={busy !== null} aria-busy={busy === "set" ? true : undefined}>
          {busy === "set" ? modelSpendWords.setting : modelSpendWords.setButton}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null || !hasOverride}
          aria-busy={busy === "clear" ? true : undefined}
          onClick={clear}
        >
          {busy === "clear" ? modelSpendWords.clearing : modelSpendWords.clearButton}
        </button>
      </div>
      <div className="help">{modelSpendWords.clearHelp(hasOverride)}</div>
    </form>
  );
}
