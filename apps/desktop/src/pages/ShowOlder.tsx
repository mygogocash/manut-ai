// Show older, under a list of the shop's work: one quiet line that says there is older work than the list holds (or that the list is
// everything), and the button that reads it. The rules and words are older.ts's; the lists are History's and the activity log's.
import { olderWords, type OlderView } from "./older";

export function ShowOlder({ view }: { view: OlderView }) {
  const words = olderWords(view.state, view.ui);
  const reading = view.ui.step === "reading";
  return (
    <div className="older" data-testid="older" data-state={view.state === "end" ? "end" : view.ui.step}>
      <p role={words.alert ? "alert" : "status"} data-testid="older-line">
        {words.line}
      </p>
      {words.button && (
        // aria-disabled, not disabled, while the page is read, so the focus stays on the button the person pressed
        <button type="button" className="btn" aria-disabled={reading} aria-busy={reading || undefined} onClick={view.onShow} data-testid="older-show">
          {words.button}
        </button>
      )}
    </div>
  );
}
