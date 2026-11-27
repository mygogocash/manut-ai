// What the phone shows when drawing a page threw, in place of a blank screen: React leaves the page empty when a render throws
// and nothing catches it, and on a phone there is no window to close and open again. It says nothing was changed (no request is
// ever answered by drawing) and offers Reload. The error itself is not shown: it may quote what the page was drawing.
import { Component, type ReactNode } from "react";

/** Its words, English as every table of the web app is for now (src/app/strings.ts). */
export const FAILED_WORDS = {
  title: "This page could not be shown",
  body: "Nothing was changed. Reload to try again.",
  reload: "Reload",
} as const;

interface Props {
  readonly children: ReactNode;
  /** What Reload does; the page's own reload unless a test gives another. */
  readonly reload?: () => void;
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const reload = this.props.reload ?? (() => window.location.reload());
    return (
      <main className="page" role="alert" data-testid="page-failed" style={{ padding: 16 }}>
        <h1>{FAILED_WORDS.title}</h1>
        <p>{FAILED_WORDS.body}</p>
        <button type="button" className="btn" style={{ minHeight: 44 }} onClick={reload}>
          {FAILED_WORDS.reload}
        </button>
      </main>
    );
  }
}
