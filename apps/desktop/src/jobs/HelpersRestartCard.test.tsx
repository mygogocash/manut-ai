// The card a lead's chat shows when the app closed during a round of its helper lanes (item 102j-2), from props alone, drawn with
// react-dom/server as the other helpers cards are: each helper with where its work is, Land what they did only while some work waits
// for it, both presses off while the reports go, and one line once reported. What a press does is helperLanding.test.ts's and
// helperRuns.test.ts's.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelpersRestartView, type RestartRow } from "./HelpersRestartCard";
import type { LandingView, RestartView } from "./helperLanding";

const held: LandingView = { state: "held", files: [], filesTotal: 0, conflicts: [], keys: [], patch: "", why: "", error: "" };
const rows: RestartRow[] = [
  { n: 1, title: "Tests for the QR builder", landing: { ...held, state: "landed", files: ["src/qr.test.ts"], filesTotal: 1 } },
  { n: 2, title: "The receipt's Thai date", landing: held },
];
const view = (over: Partial<RestartView>): RestartView => ({ state: "offered", canLand: true, helpers: [], ...over });
const draw = (v: RestartView) => renderToString(createElement(HelpersRestartView, { view: v, rows }));
const disabled = (html: string, id: string) => new RegExp(`<button[^>]*disabled=""[^>]*data-testid="${id}"`).test(html);

describe("the card after a restart", () => {
  it("says the app closed and nothing went since, with each helper's work and both presses", () => {
    const html = draw(view({}));
    expect(html).toContain("The app closed while Kit&#x27;s helper lanes were out");
    expect(html).toContain("Nothing of theirs has landed in Kit&#x27;s folder or gone to Kit since.");
    expect(html).toContain("Helper 1: Tests for the QR builder");
    expect(html).toContain("Landed 1 file in Kit&#x27;s folder.");
    expect(html).toContain("Not landed: the app closed first.");
    expect(disabled(html, "helpers-restart-land")).toBe(false);
    expect(disabled(html, "helpers-restart-report")).toBe(false);
  });

  it("offers Land what they did only while work waits for it, and neither press while the reports go", () => {
    const landing = draw(view({ state: "landing", canLand: false }));
    expect(disabled(landing, "helpers-restart-land")).toBe(true);
    expect(landing).not.toContain("Nothing of theirs has landed");
    const reporting = draw(view({ state: "reporting", canLand: false }));
    expect(disabled(reporting, "helpers-restart-land")).toBe(true);
    expect(disabled(reporting, "helpers-restart-report")).toBe(true);
    expect(reporting).toContain("The reports go to Kit once their work has landed and Kit is idle.");
  });

  it("settles into one line once reported", () => {
    const html = draw(view({ state: "reported", canLand: false }));
    expect(html).toContain("Helper lanes from before the restart reported to Kit.");
    expect(html).not.toContain("helpers-restart-report");
  });
});
