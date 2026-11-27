// A page whose drawing throws shows that it could not be shown, that nothing was changed, and Reload, in place of a blank phone
// screen; a page that draws is left alone.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, FAILED_WORDS } from "../src/ErrorBoundary";

function Throws(): never {
  throw new Error("a field the page did not expect");
}

describe("the page's error boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("draws the page while it draws", () => {
    render(<ErrorBoundary><p>The page</p></ErrorBoundary>);
    expect(screen.getByText("The page")).toBeTruthy();
    expect(screen.queryByTestId("page-failed")).toBeNull();
  });

  it("says the page could not be shown and nothing was changed, without the error's words, and Reload reloads", () => {
    // React reports the caught error to the console; that is expected here
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(<ErrorBoundary reload={reload}><Throws /></ErrorBoundary>);
    expect(screen.getByRole("alert").textContent).toContain(FAILED_WORDS.title);
    expect(screen.getByText(FAILED_WORDS.body)).toBeTruthy();
    expect(screen.queryByText(/did not expect/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: FAILED_WORDS.reload }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
