// What a part of the page shows when drawing it threw, in place of the whole window going blank. React leaves the page empty
// when a render throws and nothing catches it; one bad event field (an agent's, a phone's, a runtime's) could otherwise take
// Needs you and every chat with it. The error is kept, masked, for Settings › Report a problem (src/report/errors.ts), and the
// part can be drawn again once whatever it read has changed.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { recordError, type KeptError } from "../report/errors";

interface Props {
  readonly children: ReactNode;
  /** What stands in for the part: the error, and a way to draw the part again. */
  readonly fallback: (error: Error, retry: () => void) => ReactNode;
  readonly source?: KeptError["source"];
}

interface State {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    recordError(this.props.source ?? "page", error instanceof Error ? error.message || error.name : String(error));
  }

  override render(): ReactNode {
    const { error } = this.state;
    return error ? this.props.fallback(error, () => this.setState({ error: null })) : this.props.children;
  }
}
