// The job view, drawn with react-dom/server as smoke.test.tsx draws the first screen. The view is drawn from the job the
// runtime gives it, and the jobs here are the demo runtime's own, started at 10:00 so the canvas's timeline ("Proposed
// 09:10 · You approved 09:14 · Sent 09:14 · Checked 09:20") comes out of its real data.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import type { Job } from "../runtime/mission";
import { MockHost, MockRuntime } from "../runtime/mock";
import { LOADING, load, type Load } from "./load";
import { JobView, jobQuestion, type JobViewProps } from "./JobPage";

const BOOT = new Date(2026, 10, 22, 10, 0).getTime() / 1000;
const NOW = BOOT * 1000;

async function demoJob(id: string): Promise<Job> {
  const rt = new MockRuntime(new MockHost({ now: () => BOOT }));
  await rt.connect();
  return rt.request("jobs.get", { job: id });
}

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

function draw(over: Partial<JobViewProps> & { load: Load<Job> }) {
  setLang("en");
  return renderToString(
    <JobView
      who="Nam"
      nowMs={NOW}
      onBack={noop}
      hood
      onHood={noop}
      unwired={null}
      onUnwired={noop}
      ask=""
      onAsk={noop}
      onSubmitAsk={noop}
      onCopy={noop}
      copy="idle"
      {...over}
    />,
  );
}

afterEach(() => setLang("en"));

describe("the job view while it waits and when it cannot be shown", () => {
  it("says it is loading, in a status the page announces, with a way back", () => {
    const html = draw({ load: LOADING });
    expect(html).toContain('data-testid="page-job"');
    expect(html).toMatch(/role="status"[^>]*data-testid="job-loading"|data-testid="job-loading"[^>]*role="status"/);
    expect(words(html)).toContain("Loading the job");
    expect(html).toContain('data-testid="page-back"');
    expect(html).not.toContain('data-testid="job-timeline"');
  });

  it("says why when the runtime cannot show a job: its own words, not a made-up job", () => {
    const html = draw({ load: { kind: "unavailable", code: "not_yet", message: "Not yet: Connected mode cannot show this for now. It comes in a later version." } });
    expect(html).toMatch(/role="alert"[^>]*data-testid="job-unavailable"|data-testid="job-unavailable"[^>]*role="alert"/);
    const text = words(html);
    expect(text).toContain("This job cannot be shown");
    expect(text).toContain("Not yet: Connected mode cannot show this for now. It comes in a later version.");
    expect(html).toContain('data-testid="page-back"');
    expect(html).not.toContain('data-testid="job-timeline"');
    expect(html).not.toContain('data-testid="job-hood"');
  });
});

describe("a job that is done: the owner's side", () => {
  it("opens with the job's title and the owner's goal, who does it, and the timeline", async () => {
    const html = draw({ load: { kind: "ready", value: await demoJob("late-parcels") } });
    expect(html).toMatch(/<h1[^>]*>Replies about late parcels<\/h1>/);
    expect(words(html)).toContain("Nam");
    expect(words(html)).toContain("Reply to customers whose parcels are late.");
    expect(words(after(html, "job-timeline"))).toMatch(/^ *Proposed 09:10 You approved 09:14 Sent 09:14 Checked 09:20/);
    // the last step is the one coloured for where the job stands
    expect(html).toMatch(/<span class="tag ok">Checked 09:20<\/span>/);
    expect(html).toMatch(/<span class="tag">Proposed 09:10<\/span>/);
  });

  it("says what happened, and who it went to with how each message stands", async () => {
    const html = draw({ load: { kind: "ready", value: await demoJob("late-parcels") } });
    const text = words(html);
    expect(text).toContain("Nam found 3 customers whose parcels were more than 2 days late");
    expect(text).toContain("All three were delivered and two have been read.");
    expect(text).toMatch(/Sent to 3 customers/);
    expect(text).toMatch(/P Khun Ploy Read M Khun Mint Read T Khun Tee Delivered/);
    expect(html).toMatch(/<span class="tag ok">Read<\/span>/);
    expect(html).toMatch(/<span class="tag">Delivered<\/span>/);
  });

  it("shows what it cost in baht from integer satang, and how long it took", async () => {
    const html = draw({ load: { kind: "ready", value: await demoJob("late-parcels") } });
    const text = words(html);
    expect(text).toMatch(/Cost ฿1\.20/);
    expect(text).toMatch(/Took 40 seconds/);
    expect(html).not.toMatch(/฿1\.2\b(?!0)/);
  });

  it("offers the three actions: Something was wrong, Do this whenever parcels are late, and Ask about this job", async () => {
    const html = draw({ load: { kind: "ready", value: await demoJob("late-parcels") } });
    expect(html).toMatch(/<button[^>]*data-testid="job-wrong"[^>]*>Something was wrong<\/button>/);
    expect(html).toMatch(/<button[^>]*data-testid="job-again"[^>]*>Do this whenever parcels are late<\/button>/);
    expect(html).toMatch(/<label[^>]*for="job-follow"[^>]*>Ask about this job<\/label>/);
    expect(html).toMatch(/<input[^>]*id="job-follow"[^>]*placeholder="Ask about this job"[^>]*data-testid="job-ask"/);
    expect(html).toMatch(/<button type="submit"[^>]*aria-label="Send"[^>]*disabled=""[^>]*data-testid="job-ask-send"/);
  });

  it("lets the question be sent once there are words to send, and keeps the words with why the last one did not go", async () => {
    const value = await demoJob("late-parcels");
    expect(draw({ load: { kind: "ready", value }, ask: "Why Tuesday?" })).toMatch(/<button type="submit"[^>]*aria-label="Send"(?![^>]*disabled)[^>]*data-testid="job-ask-send"/);
    const html = draw({ load: { kind: "ready", value }, ask: "Why Tuesday?", askError: "Not yet: Connected mode only reads for now." });
    expect(html).toContain('value="Why Tuesday?"');
    expect(html).toMatch(/role="alert"[^>]*data-testid="job-ask-error"[^>]*>Not sent · Not yet: Connected mode only reads for now\./);
  });

  it("puts the question to the member who did the job, in the owner's language, naming the job", async () => {
    expect(jobQuestion("Replies about late parcels", "Why Tuesday?")).toBe("About “Replies about late parcels”: Why Tuesday?");
    expect(jobQuestion("Replies about late parcels", "  Why Tuesday?  ")).toBe("About “Replies about late parcels”: Why Tuesday?");
    setLang("zh");
    expect(jobQuestion("给晚到包裹的回复", "为什么是周二？")).toContain("给晚到包裹的回复");
  });

  it("says an action is not yet possible, honestly, once it is pressed", async () => {
    const value = await demoJob("late-parcels");
    for (const [which, label] of [
      ["wrong", "Something was wrong"],
      ["again", "Do this whenever parcels are late"],
      ["replay", "Replay as a test"],
    ] as const) {
      const html = draw({ load: { kind: "ready", value }, unwired: which });
      expect(words(html), which).toContain(`Not yet: “${label}” does not work in this version.`);
      expect(html).toMatch(/role="status"[^>]*data-testid="job-notyet"|data-testid="job-notyet"[^>]*role="status"/);
    }
    expect(draw({ load: { kind: "ready", value } })).not.toContain('data-testid="job-notyet"');
  });
});

describe("a job's depth for developers", () => {
  it("is under the hood, for developers, with what it is", async () => {
    const html = draw({ load: { kind: "ready", value: await demoJob("late-parcels") } });
    const text = words(html);
    expect(html).toMatch(/aria-label="Under the hood"/);
    expect(text).toContain("Under the hood");
    expect(text).toContain("For developers");
    expect(text).toContain("The same job, step by step: every tool call, model and cost.");
    expect(html).toMatch(/<button[^>]*aria-expanded="true"[^>]*data-testid="job-hood"[^>]*>Close the hood<\/button>/);
  });

  it("is one row per step with its tool, what it found, how long it took and its cost, and a total", async () => {
    const html = draw({ load: { kind: "ready", value: await demoJob("late-parcels") } });
    expect(html.split('data-testid="job-trace-row"').length - 1).toBe(6);
    const text = words(html);
    expect(text).toMatch(/shopee\.list_orders late > 2 days, 3 found 0\.8 s/);
    expect(text).toMatch(/carrier\.track × 3 new arrival: Tuesday 1\.9 s/);
    expect(text).toMatch(/draft_reply demo-standard, 1,412 tokens 31 s ฿0\.98/);
    expect(text).toMatch(/approval\.wait allow once, by you 4 min/);
    expect(text).toMatch(/line\.send × 3 3 accepted 1\.1 s/);
    expect(text).toMatch(/verify\.delivery 3 of 3 delivered 5\.0 s ฿0\.22 pass/);
    expect(text).toMatch(/Total 1,964 tokens ฿1\.20/);
    // the top of the page and the total under the hood are the same figure
    expect(text).toMatch(/Cost ฿1\.20/);
  });

  it("copies the trace and offers a replay as a test, and says how the copy went", async () => {
    const value = await demoJob("late-parcels");
    const html = draw({ load: { kind: "ready", value } });
    expect(html).toMatch(/<button[^>]*data-testid="job-copy"[^>]*>Copy trace<\/button>/);
    expect(html).toMatch(/<button[^>]*data-testid="job-replay"[^>]*>Replay as a test<\/button>/);
    expect(words(draw({ load: { kind: "ready", value }, copy: "done" }))).toContain("Copied");
    expect(draw({ load: { kind: "ready", value }, copy: "failed" })).toMatch(/role="alert"[^>]*>Could not copy/);
    expect(words(html)).not.toContain("Copied");
  });

  it("can be closed, leaving the owner's side alone", async () => {
    const html = draw({ load: { kind: "ready", value: await demoJob("late-parcels") }, hood: false });
    expect(html).not.toContain('aria-label="Under the hood"');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*data-testid="job-hood"[^>]*>Open the hood<\/button>/);
    expect(words(html)).toContain("Reply to customers whose parcels are late.");
  });
});

describe("a job that is still going, and ones that sent nothing", () => {
  it("says Working with no time, shows what has not gone out yet as waiting, and leaves out how long it took", async () => {
    const html = draw({ load: { kind: "ready", value: await demoJob("weekend-replies") } });
    const text = words(html);
    expect(html).toMatch(/<span class="tag run">Working<\/span>/);
    expect(text).toContain("Going to 3 customers");
    expect(html).toMatch(/<span class="tag">Waiting<\/span>/);
    expect(text).not.toContain("Took");
    expect(text).toMatch(/Cost ฿0\.45/);
  });

  it("leaves out Sent to when it wrote to nobody, and Do this whenever when there is no rule to keep", async () => {
    const html = draw({ load: { kind: "ready", value: await demoJob("daily-summary") }, who: "Ton" });
    const text = words(html);
    expect(text).not.toContain("Sent to");
    expect(text).not.toContain("Going to");
    expect(html).not.toContain('data-testid="job-again"');
    expect(html).toContain('data-testid="job-wrong"');
    expect(text).toContain("It went only to you.");
  });

  it("says a proposal waits for the owner, and names the day when the job began on another day", async () => {
    const html = draw({ load: { kind: "ready", value: await demoJob("teaser-post") }, who: "Pim" });
    expect(html).toMatch(/<span class="tag warn">Proposed \d\d:\d\d<\/span>/);
    expect(words(html)).toContain("Yesterday");
  });
});
