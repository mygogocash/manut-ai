import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { App } from "../src/App";
import { matchRoute } from "../src/router";

describe("routing", () => {
  it("matches the three pages and nothing else", () => {
    expect(matchRoute("/approve/abc_DEF-123")).toEqual({ name: "approve", token: "abc_DEF-123" });
    expect(matchRoute("/approve/abc/")).toEqual({ name: "approve", token: "abc" });
    expect(matchRoute("/ops")).toEqual({ name: "ops" });
    expect(matchRoute("/")).toEqual({ name: "home" });
    expect(matchRoute("/approve/")).toEqual({ name: "notFound" });
    expect(matchRoute("/approve/a/b")).toEqual({ name: "notFound" });
    expect(matchRoute("/approve/%E0%A4%A")).toEqual({ name: "notFound" });
  });

  it("uses the fake when VITE_API_ORIGIN is absent or empty", () => {
    expect(createApi(undefined).mode).toBe("fake");
    expect(createApi("  ").mode).toBe("fake");
    expect(createApi("https://api.example.test").mode).toBe("live");
  });

  it("calls the API that served the page when VITE_API_ORIGIN is same-origin", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const setup = createApi(" same-origin ");
    expect(setup.mode).toBe("live");
    await setup.api.getApproval("tok");
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${window.location.origin}/v1/pilot/approvals/tok`);
  });

  it("opens the owner's page from its path, and moves between pages without a reload", async () => {
    window.history.replaceState(null, "", "/");
    render(<App setup={{ api: createFakeApi(), mode: "fake" }} />);
    expect(screen.getByRole("heading", { name: "Manut AI pilot" })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Waiting for you, with the one-time permission step" }));
    expect(window.location.pathname).toBe("/approve/demo");
    expect(await screen.findByText("Sends a reply to Khun Ploy on LINE. It can't be unsent.")).toBeTruthy();
    expect(screen.getByText("Practice mode. This page uses sample data and sends nothing.")).toBeTruthy();

    act(() => {
      window.history.pushState(null, "", "/ops");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByLabelText("Operator key")).toBeTruthy();
  });
});
