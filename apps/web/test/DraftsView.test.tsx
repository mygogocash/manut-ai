import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Shop, type WorkerJobEntry, type WorkerJobsPage, type WorkerJobsQuery } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { DraftsView } from "../src/ops/DraftsView";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { deferred, renderWithApi, stubApi } from "./helpers";

const NOW = Date.parse("2026-11-23T03:00:00Z");

const SHOPS: Shop[] = [
  { tenant: "t1", name: "Baan Mali", ownerName: "Fon", lineConnectionId: "line_1", consent: true },
  { tenant: "t2", name: "Sabai Tea", ownerName: "Dao", consent: false },
];

const taskId = (n: number) => `worker-task-6a7c1f00-0000-4000-8000-${String(n).padStart(12, "0")}`;

function job(n: number, overrides: Partial<WorkerJobEntry> = {}): WorkerJobEntry {
  return { taskId: taskId(n), member: "nam", job: "reply", at: "2026-11-23T02:00:00.000Z", ending: { state: "done" },
    draft: { text: `Draft number ${n}`, at: "2026-11-23T02:00:05.000Z" }, ...overrides };
}

function page(tenant: string, jobs: WorkerJobEntry[], next: string | null = null): WorkerJobsPage {
  return { tenant, jobs, next };
}

/// Each job of the shop's list as an operator reads it.
function rows(name: string): string[] {
  return within(screen.getByRole("list", { name })).getAllByRole("listitem").map((item) => item.textContent ?? "");
}

describe("the Drafts page", () => {
  it("opens from the side menu and lists the chosen shop's jobs newest first, each draft in full and marked not sent", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    renderWithApi(<OpsConsole />,
      createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test" }));

    const nav = await screen.findByRole("button", { name: "Drafts" });
    await screen.findByRole("button", { name: "Baan Mali" });
    fireEvent.click(nav);
    expect(await screen.findByRole("heading", { name: "Drafts" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBe("page");
    await screen.findByRole("list", { name: "Baan Mali's worker jobs" });
    const read = rows("Baan Mali's worker jobs");
    expect(read).toHaveLength(7);

    // Newest first: Nam's reply to Khun Ploy, then Pim's reply that Nam has not taken up.
    expect(read[0]).toContain("Nam");
    expect(read[0]).toContain("sales chat");
    expect(read[0]).toContain("Reply to a customer");
    expect(read[0]).toContain("Done");
    expect(read[0]).toContain("ขออภัยที่พัสดุล่าช้านะคะ ตอนนี้ของออกจากคลังแล้ว คาดว่าจะถึงภายในวันอังคารค่ะ");
    expect(read[0]).toContain("Answers message msg_ploy");
    expect(read[0]).toContain("Model cost ฿0.02");
    expect(read[0]).toContain("Not sent");
    expect(read[0]).toContain("To send it, propose it as a reply on the Messages tab. Fon approves it before anything is sent.");
    // A handover nobody has taken up: the member, the tag, no draft.
    expect(read[1]).toContain("Pim");
    expect(read[1]).toContain("Passed to Nam");
    expect(read[1]).toContain("Nam has not taken it up yet.");
    expect(read[1]).not.toContain("Not sent");
    // Waiting for the owner, with the draft Pim wrote.
    expect(read[2]).toContain("Waiting for Fon");
    expect(read[2]).toContain("Free gift wrapping all December.");
    expect(read[2]).toContain("Not sent");
    // A failure, in words, with no draft.
    expect(read[3]).toContain("Ton");
    expect(read[3]).toContain("Failed");
    expect(read[3]).toContain("The shop's recorded payments could not be read.");
    expect(read[3]).toContain("No draft was written.");
    // A job Nam passed to Ton, who did it.
    expect(read[6]).toContain("Ton");
    expect(read[6]).toContain("Sales summary");
    expect(read[6]).toContain("Nam passed this job to Ton.");
    expect(read[6]).toContain("Yesterday: 3 paid orders, ฿2,370 in sales. Nothing needs checking.");
    expect(read[6]).toContain("Sales on 21 November");
    // Every draft says it has not been sent: five jobs wrote one.
    expect(read.filter((text) => text.includes("This is a draft. It has not been sent to anyone."))).toHaveLength(5);
    // Thai is marked as Thai so it is read and shaped as Thai.
    expect(document.querySelector('[lang="th"]')?.textContent).toContain("ขออภัยที่พัสดุล่าช้า");

    // Going back to a shop leaves the Drafts page.
    fireEvent.click(screen.getByRole("button", { name: "Sabai Tea" }));
    expect(await screen.findByRole("heading", { name: "Sabai Tea" })).toBeTruthy();
    expect(nav.getAttribute("aria-current")).toBeNull();
  });

  it("offers no way to send anything: the only controls are the shop, Refresh and older jobs, and no other route is read", async () => {
    // A reply that needs the owner's approval to go out, and one more page behind it.
    const listWorkerJobs = vi.fn(async (): Promise<WorkerJobsPage> => page("t1", [
      job(2, { draft: { text: "Hello Khun Ploy, your parcel ships today.", at: "2026-11-23T02:00:05.000Z",
        about: { messageId: "msg_1" }, send: { answer: "ask", kind: "reply" } } }),
    ], taskId(2)));
    // Every other route fails loudly if it is reached (stubApi), so a send, a proposal or a decision would fail this test.
    const { container } = renderWithApi(<DraftsView shops={SHOPS} tenant="t1" onForget={() => {}} />,
      stubApi({ listWorkerJobs }));
    await screen.findByText("Hello Khun Ploy, your parcel ships today.");

    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual(["Refresh", "Show older jobs"]);
    expect(screen.queryByRole("button", { name: /send|post|publish|approve|propose|reply/i })).toBeNull();
    expect(container.querySelector("form, textarea, input")).toBeNull();
    expect(container.querySelector("a[href]")).toBeNull();
    // It says so, in words, more than once.
    expect(screen.getAllByText(/has not been sent to anyone/).length).toBeGreaterThan(1);
    expect(listWorkerJobs).toHaveBeenCalledTimes(1);
  });

  it("pages back through older jobs, and starts from the newest page again after a refresh or another shop", async () => {
    const listWorkerJobs = vi.fn(async (tenant: string, query: WorkerJobsQuery = {}): Promise<WorkerJobsPage> => {
      if (tenant === "t2") return page("t2", [job(9, { member: "ton", job: "daily_summary" })]);
      if (!query.before) return page("t1", [job(3), job(2)], taskId(2));
      return page("t1", [job(1)]);
    });
    renderWithApi(<DraftsView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listWorkerJobs }));

    await screen.findByText("Draft number 3");
    expect(rows("Baan Mali's worker jobs")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show older jobs" }));
    await screen.findByText("Draft number 1");
    expect(rows("Baan Mali's worker jobs")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show older jobs" })).toBeNull();
    expect(listWorkerJobs.mock.calls).toEqual([["t1", { limit: 10 }], ["t1", { before: taskId(2), limit: 10 }]]);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(rows("Baan Mali's worker jobs")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Show older jobs" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    await screen.findByRole("list", { name: "Sabai Tea's worker jobs" });
    expect(rows("Sabai Tea's worker jobs")).toEqual([expect.stringContaining("Sales summary")]);
  });

  it("shows a page that comes back empty while there is more to read, and still offers the next page", async () => {
    const listWorkerJobs = vi.fn(async (_tenant: string, query: WorkerJobsQuery = {}): Promise<WorkerJobsPage> =>
      query.before ? page("t1", [job(1)]) : page("t1", [], taskId(5)));
    renderWithApi(<DraftsView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listWorkerJobs }));
    fireEvent.click(await screen.findByRole("button", { name: "Show older jobs" }));
    await screen.findByText("Draft number 1");
    expect(screen.queryByRole("button", { name: "Show older jobs" })).toBeNull();
  });

  it("marks each way a job stands: running, done, failed, waiting for the owner, passed on, cancelled", async () => {
    const listWorkerJobs = vi.fn(async (): Promise<WorkerJobsPage> => page("t1", [
      job(6, { ending: { state: "running" }, draft: null }),
      job(5, { ending: { state: "cancelled" }, draft: null }),
      job(4, { ending: { state: "handed_over", to: "ton" }, member: "nam", job: "daily_summary", draft: null }),
      job(3, { ending: { state: "awaiting_owner" } }),
      job(2, { ending: { state: "failed", reason: "budget" }, draft: null }),
      job(1, { member: "ton", passedFrom: "nam", job: "daily_summary", costSatang: 129000 }),
    ]));
    renderWithApi(<DraftsView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listWorkerJobs }));
    await screen.findByRole("list", { name: "Baan Mali's worker jobs" });
    const read = rows("Baan Mali's worker jobs");
    expect(read[0]).toContain("Running");
    expect(read[0]).toContain("Still working on it.");
    expect(read[0]).toContain("No draft yet.");
    expect(read[1]).toContain("Cancelled");
    expect(read[1]).toContain("It was stopped before it finished.");
    expect(read[2]).toContain("Passed to Ton");
    expect(read[2]).toContain("Ton has not taken it up yet.");
    expect(read[3]).toContain("Waiting for Fon");
    expect(read[4]).toContain("Failed");
    expect(read[4]).toContain("The shop's model budget ran out.");
    expect(read[5]).toContain("Nam passed this job to Ton.");
    expect(read[5]).toContain("Model cost ฿1,290");
  });

  it("shows a code or a member it does not know yet as it is, rather than dropping the job", async () => {
    const listWorkerJobs = vi.fn(async (): Promise<WorkerJobsPage> => page("t1", [
      job(1, { member: "kit" as never, job: "refund" as never, ending: { state: "failed", reason: "flood" }, draft: null }),
    ]));
    renderWithApi(<DraftsView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listWorkerJobs }));
    await screen.findByRole("list", { name: "Baan Mali's worker jobs" });
    const [only] = rows("Baan Mali's worker jobs");
    expect(only).toContain("kit");
    expect(only).toContain("refund");
    expect(only).toContain("Reason: flood.");
  });

  it("shows a busy state while the first page is read", async () => {
    const answer = deferred<WorkerJobsPage>();
    renderWithApi(<DraftsView shops={SHOPS} tenant="t1" onForget={() => {}} />,
      stubApi({ listWorkerJobs: () => answer.promise }));
    expect(screen.getByLabelText("Loading drafts")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Baan Mali's worker jobs" })).toBeNull();
    answer.resolve(page("t1", [job(1)]));
    await screen.findByText("Draft number 1");
    expect(screen.queryByLabelText("Loading drafts")).toBeNull();
  });

  it("says when the team has done nothing for the shop yet, and when there are no shops", async () => {
    const listWorkerJobs = vi.fn(async (tenant: string): Promise<WorkerJobsPage> => page(tenant, []));
    const first = renderWithApi(<DraftsView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listWorkerJobs }));
    expect(await screen.findByText("Nobody on the team has worked for this shop yet.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Baan Mali's worker jobs" })).toBeNull();
    first.unmount();
    renderWithApi(<DraftsView shops={[]} tenant={null} onForget={() => {}} />, stubApi({}));
    expect(await screen.findByText("No shops yet.")).toBeTruthy();
  });

  it("says so when the jobs cannot be read, and offers another key when the API refuses this one", async () => {
    let answer: ApiError = new ApiError(503, "drafts_unavailable");
    const listWorkerJobs = vi.fn(async () => { throw answer; });
    const onForget = vi.fn();
    renderWithApi(<DraftsView shops={SHOPS} tenant="t1" onForget={onForget} />, stubApi({ listWorkerJobs }));
    expect((await screen.findByRole("alert")).textContent).toContain("The API could not read this shop's jobs.");
    // A failed read is never shown as an empty shop.
    expect(screen.queryByText("Nobody on the team has worked for this shop yet.")).toBeNull();
    answer = new ApiError(403, "forbidden");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/The API refused the operator key/);
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
  });

  it("says so when the shop list itself cannot be read, and offers to try again or to enter another key", async () => {
    const onRetry = vi.fn();
    const onForget = vi.fn();
    // Every route fails loudly if it is reached, so reading jobs for a shop nobody could list would fail this test.
    const first = renderWithApi(
      <DraftsView shops={null} tenant={null} listError={new ApiError(0, "network")} onRetry={onRetry} onForget={onForget} />,
      stubApi({}));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the API.");
    expect(screen.queryByLabelText("Loading drafts")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    first.unmount();
    renderWithApi(
      <DraftsView shops={null} tenant={null} listError={new ApiError(403, "forbidden")} onRetry={onRetry} onForget={onForget} />,
      stubApi({}));
    await screen.findByText(/The API refused the operator key/);
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(onForget).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("drops an older page that arrives after the shop was changed, so it is never shown under another shop's jobs", async () => {
    const older = deferred<WorkerJobsPage>();
    const listWorkerJobs = vi.fn(async (tenant: string, query: WorkerJobsQuery = {}): Promise<WorkerJobsPage> => {
      if (tenant === "t2") return page("t2", [job(9, { member: "ton" })]);
      return query.before ? older.promise : page("t1", [job(3)], taskId(3));
    });
    renderWithApi(<DraftsView shops={SHOPS} tenant="t1" onForget={() => {}} />, stubApi({ listWorkerJobs }));
    fireEvent.click(await screen.findByRole("button", { name: "Show older jobs" }));
    fireEvent.change(screen.getByLabelText("Shop"), { target: { value: "t2" } });
    await screen.findByRole("list", { name: "Sabai Tea's worker jobs" });
    older.resolve(page("t1", [job(1, { draft: { text: "Baan Mali's old draft", at: "2026-11-22T02:00:05.000Z" } })]));
    await waitFor(() => expect(listWorkerJobs).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("Baan Mali's old draft")).toBeNull();
    expect(rows("Sabai Tea's worker jobs")).toHaveLength(1);
  });
});
