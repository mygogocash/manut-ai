import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { ApprovePage } from "../src/approve/ApprovePage";
import { DeletePage } from "../src/delete/DeletePage";
import { renderWithApi, sampleDeletionView, sampleView, stubApi } from "./helpers";

/// Every button an owner can press on a phone is at least 44px tall. The Playwright specs in apps/web/e2e measure that
/// in a browser for every state they open; this reads the markup of each state that offers a button, so a new button
/// without the size fails here at once, whether or not a browser spec opens its state. (The first one it caught: the
/// "Try again" of a request that cannot be loaded, 34px tall on both pages.)
const pressed = () =>
  screen.getAllByRole("button").map((button) => [button.textContent, (button as HTMLElement).style.minHeight]);

describe("the buttons on the owner's two pages are 44px tall in every state that offers one", () => {
  it("the approval page asks for Approve or No", async () => {
    renderWithApi(<ApprovePage token="t" />, stubApi({ getApproval: () => Promise.resolve(sampleView()) }));
    await screen.findByRole("button", { name: "Approve" });
    expect(pressed()).toEqual([["Approve", "44px"], ["No", "44px"]]);
  });

  it("the approval page asks for the one-time permission", async () => {
    renderWithApi(
      <ApprovePage token="t" />,
      stubApi({ getApproval: () => Promise.resolve(sampleView({ needsConsent: true })) }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await screen.findByRole("button", { name: "Allow and send this reply" });
    expect(pressed()).toEqual([["Allow and send this reply", "44px"], ["Not now", "44px"]]);
  });

  it("the approval page cannot load the request", async () => {
    renderWithApi(<ApprovePage token="t" />, stubApi({ getApproval: () => Promise.reject(new ApiError(0, "network")) }));
    await screen.findByRole("button", { name: "Try again" });
    expect(pressed()).toEqual([["Try again", "44px"]]);
  });

  it("the deletion page asks to delete everything or keep the data", async () => {
    renderWithApi(<DeletePage token="t" />, stubApi({ getDeletion: () => Promise.resolve(sampleDeletionView()) }));
    await screen.findByRole("button", { name: "Delete everything" });
    expect(pressed()).toEqual([["Delete everything", "44px"], ["Keep my data", "44px"]]);
  });

  it("the deletion page cannot load the request", async () => {
    renderWithApi(<DeletePage token="t" />, stubApi({ getDeletion: () => Promise.reject(new ApiError(0, "network")) }));
    await screen.findByRole("button", { name: "Try again" });
    expect(pressed()).toEqual([["Try again", "44px"]]);
  });
});
