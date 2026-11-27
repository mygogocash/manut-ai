// A part of the page whose drawing threw shows its fallback in place of the whole window going blank, keeps the error masked for
// Report a problem, and can be drawn again. React draws an error boundary only in a live page, so its two steps are called here
// as React calls them; the timeline's rows and the app's root are wrapped in it (Timeline.tsx, main.tsx).
import { describe, expect, it } from "vitest";
import { recentErrors } from "../report/errors";
import { ErrorBoundary } from "./ErrorBoundary";

describe("ErrorBoundary", () => {
  it("draws its part until it throws, then the fallback with the error, and the part again after Try again", () => {
    const b = new ErrorBoundary({ children: "the part", source: "chat", fallback: (e, retry) => ({ shown: `failed: ${e.message}`, retry }) as never });
    expect(b.render()).toBe("the part");
    b.state = ErrorBoundary.getDerivedStateFromError(new Error("boom"));
    const shown = b.render() as unknown as { shown: string; retry: () => void };
    expect(shown.shown).toBe("failed: boom");
    // Try again clears the error, so React draws the part once more
    let next: unknown = null;
    b.setState = ((s: unknown) => (next = s)) as never;
    shown.retry();
    expect(next).toEqual({ error: null });
    // something thrown that is not an Error still shows
    expect(ErrorBoundary.getDerivedStateFromError("plain").error?.message).toBe("plain");
  });

  it("keeps what threw for Report a problem, masked, under the part's source", () => {
    const b = new ErrorBoundary({ children: null, source: "chat", fallback: () => null });
    b.componentDidCatch(new Error("bad field near sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"), { componentStack: "" });
    const kept = recentErrors()[0];
    expect(kept.source).toBe("chat");
    expect(kept.text).toContain("bad field near");
    expect(kept.text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
