// Pause everyone, which is the Team page's own (the design canvas's "Team: pause everyone"): the button in its top bar, the
// question, the banners, each member's tag and the side panel, drawn with react-dom/server from what the demo runtime says
// of the team (started at 10:00 on Sunday 22 November). The last tests run the call on the demo runtime and the connected
// one's refusal.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import type { TeamState } from "../runtime/mission";
import { MockHost, MockRuntime } from "../runtime/mock";
import { LOADING, type Load } from "./load";
import { PAUSE_START, pauseStep, type PauseUi } from "./pause";
import { TeamView, teamRows, type TeamPauseProps, type TeamRow } from "./TeamPage";
import { createStore } from "../state/store";

const BOOT = new Date(2026, 10, 22, 10, 0).getTime() / 1000;
const NOW = BOOT * 1000;
const NAMES: Record<string, string> = { buddy: "Buddy", nam: "Nam", pim: "Pim", ton: "Ton", kit: "Kit" };
const nameOf = (bot: string) => NAMES[bot] ?? bot;

const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
/** What follows the opening tag that carries `testid`. */
const after = (html: string, testid: string) => html.slice(html.indexOf(`data-testid="${testid}"`)).replace(/^[^>]*>/, "");
const noop = () => {};

async function demoRuntime() {
  const rt = new MockRuntime(new MockHost({ now: () => BOOT }));
  await rt.connect();
  return rt;
}

const member = (name: string, status: TeamRow["status"] = "idle"): TeamRow => ({ name, displayName: nameOf(name), description: "", status, open: noop });
const MEMBERS = ["buddy", "nam", "pim", "ton", "kit"].map((n) => member(n));

function draw(state: Load<TeamState>, over: Partial<TeamPauseProps> = {}, members: TeamRow[] = MEMBERS) {
  setLang("en");
  return renderToString(<TeamView members={members} pause={{ state, ui: PAUSE_START, nowMs: NOW, nameOf, onAsk: noop, onKeep: noop, onPause: noop, onResume: noop, onOpenJob: noop, ...over }} />);
}
const ui = (over: Partial<PauseUi>): PauseUi => ({ ...PAUSE_START, ...over });

afterEach(() => setLang("en"));

describe("Pause everyone before it is asked", () => {
  it("offers one button in the top bar, and says what it does and does not do beside the team", async () => {
    const rt = await demoRuntime();
    const html = draw({ kind: "ready", value: await rt.request("team.state", {}) });
    // the Team board's quiet button, not red: pausing can be undone (item 85i)
    expect(html).toMatch(/<button[^>]*class="btn"[^>]*data-testid="pause-open"[^>]*>Pause everyone<\/button>/);
    expect(html).not.toContain("disabled");
    const side = words(after(html, "pause-side"));
    expect(side).toContain("Pause everyone");
    expect(side).toContain("One button stops the whole team at the next safe point. Use it when something looks wrong and you want to look first.");
    expect(side).toContain("It does not unsend anything.");
    expect(side).toContain("It does not take your pages offline.");
    for (const id of ["pause-dialog", "pause-banner", "pause-back", "pause-error"]) expect(html, id).not.toContain(`data-testid="${id}"`);
    // the team is still listed as it was
    expect(words(html)).toContain("Nam");
  });

  it("waits with the button held back while the team's state is being read", () => {
    const html = draw(LOADING);
    expect(html).toMatch(/<button[^>]*class="btn"[^>]*disabled=""[^>]*data-testid="pause-open"/);
    expect(html).toContain('aria-busy="true"');
    // the question is never drawn without the state it quotes
    expect(draw(LOADING, { ui: ui({ ask: true }) })).not.toContain('data-testid="pause-dialog"');
  });

  it("leaves the button out when there is no one to pause: no team, or a team of the lead alone", async () => {
    const rt = await demoRuntime();
    const state = await rt.request("team.state", {});
    expect(draw({ kind: "ready", value: state }, {}, [])).not.toContain('data-testid="pause-open"');
    expect(draw({ kind: "ready", value: { ...state, members: [] } })).not.toContain('data-testid="pause-open"');
  });
});

describe("the question", () => {
  const ask = async () => {
    const rt = await demoRuntime();
    return draw({ kind: "ready", value: await rt.request("team.state", {}) }, { ui: ui({ ask: true }) });
  };

  it("asks \"Pause everyone now?\", says whom it stops and how many routines wait, in the canvas's words", async () => {
    const html = await ask();
    expect(html).toMatch(/<div[^>]*role="dialog"[^>]*aria-labelledby="pause-title"[^>]*data-testid="pause-dialog"/);
    const text = words(after(html, "pause-dialog"));
    expect(text).toContain("Pause everyone now?");
    expect(text).toContain("Nam, Pim, Ton and Kit stop at the next safe point. 5 routines wait.");
  });

  it("says how many jobs are running and that what has already gone out stays out, job by job", async () => {
    const text = words(after(await ask(), "pause-dialog"));
    expect(text).toContain("2 jobs are running. What has already gone out stays out.");
    expect(text).toContain("Replies about weekend orders: 1 of 3 sent.");
    // a draft sends nothing, so it has no line about what went out
    expect(text).not.toContain("Captions for the pre-order page:");
  });

  it("says that requests in Needs you keep waiting and nothing expires", async () => {
    expect(words(after(await ask(), "pause-dialog"))).toContain("Requests in Needs you keep waiting. Nothing expires while the team is paused.");
  });

  it("has two buttons, Pause everyone and Keep working, and the safe one has the focus", async () => {
    const html = await ask();
    expect(html).toMatch(/<button[^>]*class="btn danger solid"[^>]*data-testid="pause-confirm"[^>]*>Pause everyone<\/button>/);
    expect(html).toMatch(/<button[^>]*class="btn"[^>]*data-testid="pause-keep"[^>]*>Keep working<\/button>/);
    // autoFocus is applied by React when the dialog mounts, so the markup only has to name the safe button
    expect(html.indexOf('data-testid="pause-keep"')).toBeGreaterThan(html.indexOf('data-testid="pause-confirm"'));
  });

  it("holds the Pause button while the request is on its way, and says why the last one did not go", async () => {
    const rt = await demoRuntime();
    const state: Load<TeamState> = { kind: "ready", value: await rt.request("team.state", {}) };
    expect(draw(state, { ui: ui({ ask: true, busy: true }) })).toMatch(/<button[^>]*class="btn danger solid"[^>]*disabled=""[^>]*data-testid="pause-confirm"/);
    const failed = draw(state, { ui: ui({ ask: true, error: "The team is paused. Resume everyone first." }) });
    expect(failed).toMatch(/role="alert"[^>]*data-testid="pause-error"|data-testid="pause-error"[^>]*role="alert"/);
    expect(words(failed)).toContain("The team is paused. Resume everyone first.");
    // and the question is still there to try again
    expect(failed).toContain('data-testid="pause-dialog"');
  });
});

describe("while everyone is paused", () => {
  const paused = async () => {
    const rt = await demoRuntime();
    const state = await rt.request("team.pause", {});
    const rows = (await rt.request("bots.list", {})).bots.map((b) => member(b.name, b.paused ? "paused" : "idle"));
    return { state, rows, html: draw({ kind: "ready", value: state }, {}, rows) };
  };

  it("says since when, and that nothing is drafted, sent, posted or paid", async () => {
    const { html } = await paused();
    expect(html).toMatch(/role="status"[^>]*data-testid="pause-banner"|data-testid="pause-banner"[^>]*role="status"/);
    expect(words(after(html, "pause-banner"))).toMatch(/^ *Everyone is paused since 10:00\. Nothing is drafted, sent, posted or paid\./);
  });

  it("tags each paused member Paused, and not the lead, who keeps answering", async () => {
    const { html } = await paused();
    expect(count(html, "tag\">Paused<")).toBe(4);
  });

  it("offers Resume everyone in place of Pause everyone, and no question", async () => {
    const { html } = await paused();
    expect(html).toMatch(/<button[^>]*class="btn dark"[^>]*data-testid="pause-resume"[^>]*>Resume everyone<\/button>/);
    expect(html).not.toContain('data-testid="pause-open"');
    expect(html).not.toContain('data-testid="pause-dialog"');
  });

  it("lists what was running, with what went out and what waits, or that the work is kept", async () => {
    const { html } = await paused();
    const side = words(after(html, "pause-side"));
    expect(side).toContain("What was running");
    expect(side).toContain("Replies about weekend orders 1 of 3 sent. 2 are waiting.");
    expect(side).toContain("Captions for the pre-order page Pim’s work is kept.");
  });

  it("says what still happens: customers write, live pages stay live, routines skip, no AI budget is used", async () => {
    const side = words(after((await paused()).html, "pause-side"));
    expect(side).toContain("What still happens");
    expect(side).toContain("Customers can still write. Their messages wait for the team.");
    expect(side).toContain("Your live pages stay live.");
    expect(side).toContain("Routines skip their runs and say so in History.");
    expect(side).toContain("A paused team uses nothing from the AI budget.");
    // what the explainer says before it is paused is gone
    expect(side).not.toContain("One button stops the whole team");
  });

  it("says nothing was running when no job was", async () => {
    const { state } = await paused();
    expect(words(after(draw({ kind: "ready", value: { ...state, running: [] } }), "pause-side"))).toContain("Nothing was running.");
  });

  it("opens a stopped job's page from its line", async () => {
    const { html } = await paused();
    expect(html).toMatch(/<button[^>]*data-testid="pause-job-weekend-replies"[^>]*>Replies about weekend orders<\/button>/);
  });
});

describe("after Resume everyone", () => {
  it("says everyone is back at work, and offers Pause everyone again", async () => {
    const rt = await demoRuntime();
    await rt.request("team.pause", {});
    const state = await rt.request("team.resume", {});
    const html = draw({ kind: "ready", value: state }, { ui: ui({ back: true }) });
    expect(words(after(html, "pause-back"))).toMatch(/^ *Everyone is back at work\./);
    expect(html).toContain('data-testid="pause-open"');
    expect(html).not.toContain('data-testid="pause-banner"');
    expect(count(html, "tag\">Paused<")).toBe(0);
  });
});

describe("on the connected runtime", () => {
  it("cannot say, so the button stays and the runtime's own \"not yet\" shows when it is pressed, with no question", () => {
    const refusal: Load<TeamState> = { kind: "unavailable", code: "not_yet", message: "Not yet: Connected mode cannot show this for now. It comes in a later version." };
    const idle = draw(refusal);
    expect(idle).toMatch(/<button[^>]*class="btn"[^>]*data-testid="pause-open"/);
    expect(idle).not.toContain("disabled");
    const pressed = draw(refusal, { ui: ui({ ask: true, error: "Not yet: Connected mode cannot show this for now. It comes in a later version." }) });
    expect(words(after(pressed, "pause-error"))).toContain("Not yet: Connected mode cannot show this for now. It comes in a later version.");
    expect(pressed).not.toContain('data-testid="pause-dialog"');
    // the explainer is still honest: it says what Pause everyone is, which is true of the button
    expect(words(after(pressed, "pause-side"))).toContain("It does not unsend anything.");
  });
});

describe("a member's tag", () => {
  it("is Paused, from the runtime's own flag on the member", async () => {
    const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
    await store.actions.init();
    expect(teamRows(store.getSnapshot()).some((r) => r.status === "paused")).toBe(false);
    await store.actions.teamPause();
    await new Promise((r) => setTimeout(r, 10));
    expect(Object.fromEntries(teamRows(store.getSnapshot()).map((r) => [r.name, r.status === "paused"]))).toEqual({ buddy: false, nam: true, pim: true, ton: true, kit: true });
  });
});

describe("making the call", () => {
  it("pauses on the demo runtime and moves the page on to paused with the new state", async () => {
    const rt = await demoRuntime();
    const step = await pauseStep(() => rt.request("team.pause", {}), false);
    expect(step.action).toEqual({ type: "done", paused: true });
    expect(step.state).toMatchObject({ paused: true, since: BOOT });
  });

  it("resumes, and moves the page on to back", async () => {
    const rt = await demoRuntime();
    await rt.request("team.pause", {});
    const step = await pauseStep(() => rt.request("team.resume", {}), true);
    expect(step.action).toEqual({ type: "done", paused: false });
    expect(step.state).toMatchObject({ paused: false });
  });

  it("keeps the runtime's own words when it says no, as the connected runtime does", async () => {
    const step = await pauseStep(() => Promise.reject({ code: "not_yet", message: "Not yet: Connected mode only reads for now." }), false);
    expect(step).toEqual({ action: { type: "failed", message: "Not yet: Connected mode only reads for now." }, state: null });
    expect((await pauseStep(() => Promise.reject(new Error("boom")), false)).action).toEqual({ type: "failed", message: "boom" });
  });
});

const count = (html: string, needle: string) => html.split(needle).length - 1;
