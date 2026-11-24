import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api";
import { createFakeApi, PRACTICE_OWNER_CODES } from "../src/api/fake";
import { App } from "../src/App";
import { matchRoute } from "../src/router";

describe("routing", () => {
  it("matches the four pages and nothing else", () => {
    expect(matchRoute("/approve/abc_DEF-123")).toEqual({ name: "approve", token: "abc_DEF-123" });
    expect(matchRoute("/approve/abc/")).toEqual({ name: "approve", token: "abc" });
    expect(matchRoute("/delete/abc_DEF-123.mac")).toEqual({ name: "delete", token: "abc_DEF-123.mac" });
    expect(matchRoute("/ops")).toEqual({ name: "ops" });
    expect(matchRoute("/")).toEqual({ name: "home" });
    expect(matchRoute("/approve/")).toEqual({ name: "notFound" });
    expect(matchRoute("/approve/a/b")).toEqual({ name: "notFound" });
    expect(matchRoute("/approve/%E0%A4%A")).toEqual({ name: "notFound" });
    expect(matchRoute("/delete/")).toEqual({ name: "notFound" });
    expect(matchRoute("/delete/a/b")).toEqual({ name: "notFound" });
  });

  it("opens the owner's deletion page from its path, with a practice link for each state", async () => {
    window.history.replaceState(null, "", "/");
    render(<App setup={{ api: createFakeApi(), mode: "fake" }} />);
    fireEvent.click(screen.getByRole("link", { name: "Delete a shop's data: waiting for you" }));
    expect(window.location.pathname).toBe("/delete/demo-delete");
    expect(await screen.findByRole("article", { name: "Delete everything Manut AI stores for Khao Soi Nimman?" }))
      .toBeTruthy();
    expect(screen.getByText("Practice mode. This page uses sample data and deletes nothing real.")).toBeTruthy();
  });

  it("has a practice link for long Thai words, for a long link, for a dead connection and for a long shop name", async () => {
    window.history.replaceState(null, "", "/");
    render(<App setup={{ api: createFakeApi(), mode: "fake" }} />);
    const home = () => act(() => {
      window.history.pushState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    fireEvent.click(screen.getByRole("link", { name: "A long Thai message and reply, in a shop with a long Thai name" }));
    expect(window.location.pathname).toBe("/approve/demo-long-thai");
    expect(await screen.findByText(/^Sends a reply to ศิริพรรณเจริญสุขสวัสดิ์ on LINE/)).toBeTruthy();

    home();
    fireEvent.click(screen.getByRole("link", { name: "A long order id and link, which cannot break across lines" }));
    expect(window.location.pathname).toBe("/approve/demo-long-link");
    expect(await screen.findByText(/^Sends a reply to Khun_Wichai_Chaiyaphum_01 on LINE/)).toBeTruthy();

    // A request that cannot be read says so, and offers the one thing to do.
    home();
    fireEvent.click(screen.getByRole("link", { name: "No connection: the request cannot be loaded" }));
    expect(window.location.pathname).toBe("/approve/demo-offline");
    expect(await screen.findByText("Could not load this request")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    home();
    fireEvent.click(screen.getByRole("link", { name: "Delete a shop's data: a long Thai shop name and counts in the millions" }));
    expect(window.location.pathname).toBe("/delete/demo-delete-long");
    expect(await screen.findByText("1,234,567 customer messages")).toBeTruthy();

    home();
    fireEvent.click(screen.getByRole("link", { name: "Delete a shop's data: no connection, the request cannot be loaded" }));
    expect(window.location.pathname).toBe("/delete/demo-delete-offline");
    expect(await screen.findByText("Could not load this request")).toBeTruthy();
  });

  it("lists the practice link codes for a shop's People page, each with what it does, in practice mode only", () => {
    window.history.replaceState(null, "", "/");
    const { unmount } = render(<App setup={{ api: createFakeApi(), mode: "fake" }} />);
    const list = screen.getByRole("list", { name: "Link codes for a shop's People page" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      `${PRACTICE_OWNER_CODES.dao}: Dao's account. It links Sabai Tea.`,
      `${PRACTICE_OWNER_CODES.fon}: Fon's account, which Baan Mali already has. Nothing changes.`,
      `${PRACTICE_OWNER_CODES.guest}: another account. It links a shop with no account, and is refused for one that has one.`,
      `${PRACTICE_OWNER_CODES.ranOut}: a code that has run out.`,
    ]);
    expect(screen.getByText(/type one of these to link an owner's account\. Each code works once, and is used up the first time it is tried\./))
      .toBeTruthy();
    unmount();
    render(<App setup={{ api: createFakeApi(), mode: "live" }} />);
    expect(screen.queryByRole("list", { name: "Link codes for a shop's People page" })).toBeNull();
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
