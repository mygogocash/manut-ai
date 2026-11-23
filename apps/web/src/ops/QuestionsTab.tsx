import { MAX_TEXT } from "@manut/shop-memory";
import { useState, type FormEvent } from "react";
import { useApi, type Shop, type ShopQuestion } from "../api";
import { useLoad } from "./useLoad";
import { errorText, questionErrorText, questionsWords as W } from "./words";

/// A shop's first week, for a shop made from a template (`GET /v1/admin/questions`): what Buddy asks its owner, and each
/// answer as the team now knows it. The owner has no account in the pilot, so the operator relays each answer, written as
/// a sentence that stands on its own; it becomes a fact the owner said (`POST /v1/admin/questions/answer`), which the
/// Memory page lists, and where it is corrected or forgotten. An answer is given once here. Its words are read back from
/// what the team knows, so an answer the owner had the team forget shows none.

export function QuestionsTab({ shop }: { shop: Shop }) {
  const api = useApi();
  const questions = useLoad(() => api.getQuestions(shop.tenant), `questions:${shop.tenant}`);
  const templates = useLoad(() => api.listTemplates(), "templates");
  const template = questions.data?.template ?? null;
  const templateName = templates.data?.find((t) => t.id === template)?.name ?? null;

  return (
    <section role="tabpanel" id="panel-questions" aria-labelledby="tab-questions"
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, maxWidth: 880 }}>
      <p className="hint" style={{ margin: 0 }}>
        {W.intro(shop.ownerName, templateName)}
      </p>
      {questions.error ? (
        <div className="banner err" role="alert">
          <span className="grow">{errorText(questions.error)}</span>
          <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={questions.reload}>
            {W.tryAgain}
          </button>
        </div>
      ) : !questions.data ? (
        <div className="skel" style={{ height: 120 }} aria-label={W.loading} />
      ) : questions.data.questions.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          {W.none}
        </p>
      ) : (
        <ol aria-label={W.listLabel} style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {questions.data.questions.map((question) => (
            <QuestionRow key={question.id} shop={shop} question={question} onAnswered={questions.reload} />
          ))}
        </ol>
      )}
    </section>
  );
}

function QuestionRow({ shop, question, onAnswered }: { shop: Shop; question: ShopQuestion; onAnswered: () => void }) {
  const api = useApi();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const trimmed = text.trim();
  const length = [...trimmed].length;
  const tooLong = length > MAX_TEXT;
  const boxId = `answer-${question.id}`;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || length < 1 || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      await api.answerQuestion({ tenant: shop.tenant, questionId: question.id, text: trimmed });
      onAnswered();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rowl" style={{ borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column",
      alignItems: "stretch", gap: 6 }}>
      <div style={{ fontWeight: 500 }}>{question.text}</div>
      {question.answer ? (
        question.answer.text !== null ? (
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span className="tag ok">{W.answered}</span>
            <span style={{ overflowWrap: "anywhere" }}>{question.answer.text}</span>
          </div>
        ) : (
          <div className="mut">{W.forgotten(shop.ownerName)}</div>
        )
      ) : (
        <form noValidate onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor={boxId} className="mut" style={{ fontSize: 13 }}>
            {W.answerLabel(shop.ownerName)}
          </label>
          <textarea id={boxId} className="input" rows={2} value={text} aria-describedby={`${boxId}-help`}
            aria-invalid={tooLong ? true : undefined} onChange={(event) => setText(event.target.value)}
            style={{ padding: "8px 10px", resize: "vertical", lineHeight: 1.5 }} />
          <div id={`${boxId}-help`} className={tooLong ? "help err" : "help"}>
            {W.answerHelp(length)}
          </div>
          {error ? (
            <div className="banner err" role="alert">
              <span className="grow">{questionErrorText(error)}</span>
            </div>
          ) : null}
          <div>
            <button type="submit" className="btn dark" disabled={busy || length < 1 || tooLong}
              aria-busy={busy ? true : undefined}>
              {busy ? W.saving : W.save}
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
