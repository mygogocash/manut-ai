// A chat's own pull request (item 100, part 2): the address is read from what `gh pr create` printed, only for a command Kit's
// dial read as a push, and the chat is linked to it only once one view says it is in the chat's own repository, from a branch of
// that very repository. Then the chat names it, its request names the chat, and its row shows it as a lane's does.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { asLanePull, chatOfPull, chatPullOf, forgetChatPull, noteChatPull, opensPull, pullAddress, resetChatPulls } from "./chatPull";
import { notePulls, resetPulls } from "../tasks/pulls";
import type { TaskHost } from "../tasks/host";
import type { TaskItem } from "../tasks/types";
import { ChatPullView } from "../sessions/SessionView";
import { t } from "../i18n";

// the chat's own branch: a lane's, or the one its folder had when it was read
const WHERE = { cwd: "/code/site", root: "/code/site", home: "/home/you", branch: "fix/qr" };
// what `gh pr create` prints (recorded shape: the progress lines on stderr are not in a step's output; the address last)
const CREATED = "\u001b[0;32mhttps://github.com/baanmali/site/pull/41\u001b[0m\n";
const end = (over: Record<string, unknown> = {}) => ({ event: "tool.end", tool_id: "t1", name: "", ok: true, ms: 900, command: 'gh pr create --title "Make the QR bigger" --body "On phones"', output: CREATED, ...over });
const item = (over: Partial<TaskItem> = {}): TaskItem => ({ number: 41, title: "Make the QR bigger", state: "open", url: "https://github.com/baanmali/site/pull/41", labels: [], author: "noi", created: 0, updated: 0, checks: null, head: "fix/qr", same: true, from: "baanmali/site", ...over });

function host(view: TaskItem = item(), remote: { source: "github" | "gitlab"; repo: string } | null = { source: "github", repo: "baanmali/site" }) {
  return {
    remote: vi.fn(async () => remote),
    view: vi.fn(async () => ({ item: view, body: "", comments: [], checks: [] })),
  } satisfies Pick<TaskHost, "remote" | "view">;
}

beforeEach(() => {
  resetChatPulls();
  resetPulls();
});

describe("reading what the command printed", () => {
  it("finds the last github.com pull request address, colours taken out", () => {
    expect(pullAddress(CREATED)).toEqual({ source: "github", repo: "baanmali/site", number: 41, url: "https://github.com/baanmali/site/pull/41" });
    expect(pullAddress("see https://github.com/a/b/pull/1\nhttps://github.com/a/b/pull/2")?.number).toBe(2);
    for (const none of ["", "https://github.com/a/b/issues/3", "http://github.com/a/b/pull/3", "https://gh.example.com/a/b/pull/3", "https://github.com/a/b/pull/3x", "https://github.com/a/b/pull/3/files", "https://github.com/.x/b/pull/3"]) expect(pullAddress(none), none).toBeNull();
  });

  it("is a pull request only when the dial reads the command as a push with gh pr create in it", () => {
    expect(opensPull("gh pr create --fill", WHERE)).toBe(true);
    expect(opensPull("git push -u origin fix/qr && gh pr create --fill", WHERE)).toBe(true);
    for (const no of ["gh pr view 41", "gh pr list", "git push origin fix/qr", "gh pr create --web", "gh api repos/a/b/pulls -f title=x", "echo gh pr create"]) expect(opensPull(no, WHERE), no).toBe(false);
  });
});

// what `glab mr create` prints, recorded from glab's source (gitlab-org/cli `mrutils.DisplayMR`): off a terminal only the web
// address; on one, the request's reference, title and branch, then the address
const GL_CREATED = "!12 Pre-order page (kit/preorder)\n https://gitlab.com/baanmali/shop/app/-/merge_requests/12\n";
const glEnd = (over: Record<string, unknown> = {}) => end({ command: 'glab mr create --title "Pre-order page" --description "For the new menu" --yes', output: GL_CREATED, ...over });

describe("a GitLab merge request a chat opened (item 100b)", () => {
  it("reads the last merge request address on a GitLab host", () => {
    expect(pullAddress(GL_CREATED)).toEqual({ source: "gitlab", repo: "baanmali/shop/app", number: 12, url: "https://gitlab.com/baanmali/shop/app/-/merge_requests/12" });
    expect(pullAddress("https://gitlab.example.co.th/g/p/-/merge_requests/3")).toEqual({ source: "gitlab", repo: "g/p", number: 3, url: "https://gitlab.example.co.th/g/p/-/merge_requests/3" });
    // the last address printed wins, whichever host
    expect(pullAddress("https://github.com/a/b/pull/1\nhttps://gitlab.com/g/p/-/merge_requests/2")?.source).toBe("gitlab");
    for (const none of ["https://mygitlab.com/g/p/-/merge_requests/3", "https://gitlab.com/p/-/merge_requests/3", "https://gitlab.com/g/p/merge_requests/3", "https://gitlab.com/g/p/-/merge_requests/3/diffs", "https://gitlab.com/.g/p/-/merge_requests/3", "http://gitlab.com/g/p/-/merge_requests/3"])
      expect(pullAddress(none), none).toBeNull();
  });

  it("is a merge request only when the dial reads glab mr create as a push", () => {
    expect(opensPull("glab mr create --fill --yes", WHERE)).toBe(true);
    expect(opensPull("git push -u origin kit/preorder && glab mr create --fill", WHERE)).toBe(true);
    for (const no of ["glab mr list", "glab mr view 12", "glab api projects/1/merge_requests -X POST", "glab mr create --repo https://gitlab.example.com/g/p --fill", "echo glab mr create"]) expect(opensPull(no, WHERE), no).toBe(false);
  });

  it("links the chat once one view says the request is the project's own, and not for a fork or another project", async () => {
    const remote = { source: "gitlab" as const, repo: "baanmali/shop/app" };
    const mr = item({ number: 12, title: "Pre-order page", url: "https://gitlab.com/baanmali/shop/app/-/merge_requests/12", head: "kit/preorder", from: "" });
    const h = host(mr, remote);
    expect(await noteChatPull(h, "agent:g1", glEnd(), WHERE)).toEqual({ linked: { source: "gitlab", repo: "baanmali/shop/app", number: 12, url: mr.url, title: "Pre-order page", state: "open", head: "kit/preorder" } });
    expect(h.view).toHaveBeenCalledWith("gitlab", "baanmali/shop/app", "prs", 12);
    expect(chatOfPull("gitlab", "baanmali/shop/app", 12)).toBe("agent:g1");
    expect(await noteChatPull(host(item({ ...mr, same: false }), remote), "agent:g2", glEnd(), WHERE)).toEqual({ why: "fork" });
    // each in a folder of its own: a folder's remote is read once
    const other = host(mr, { source: "gitlab", repo: "baanmali/other" });
    expect(await noteChatPull(other, "agent:g3", glEnd(), { ...WHERE, cwd: "/code/other", root: "/code/other" })).toEqual({ why: "other_repo" });
    expect(other.view).not.toHaveBeenCalled();
    // a GitHub project's chat is never linked to a GitLab address
    expect(await noteChatPull(host(mr), "agent:g4", glEnd(), { ...WHERE, cwd: "/code/hub", root: "/code/hub" })).toEqual({ why: "other_repo" });
  });
});

describe("linking a chat to the request it opened", () => {
  it("links both ways once one view says the request is the chat's own repository's", async () => {
    const h = host();
    const got = await noteChatPull(h, "agent:s1", end(), WHERE);
    expect(got).toEqual({ linked: { source: "github", repo: "baanmali/site", number: 41, url: "https://github.com/baanmali/site/pull/41", title: "Make the QR bigger", state: "open", head: "fix/qr" } });
    expect(h.remote).toHaveBeenCalledWith("/code/site");
    expect(h.view).toHaveBeenCalledTimes(1);
    expect(h.view).toHaveBeenCalledWith("github", "baanmali/site", "prs", 41);
    expect(chatPullOf("agent:s1")?.number).toBe(41);
    expect(chatOfPull("github", "BaanMali/site", 41)).toBe("agent:s1");
    forgetChatPull("agent:s1");
    expect(chatPullOf("agent:s1")).toBeNull();
    expect(chatOfPull("github", "baanmali/site", 41)).toBeNull();
  });

  it("refuses an address of another repository than the chat's, before reading it", async () => {
    const h = host();
    const got = await noteChatPull(h, "agent:s1", end({ output: "https://github.com/stranger/site/pull/41\n" }), WHERE);
    expect(got).toEqual({ why: "other_repo" });
    expect(h.view).not.toHaveBeenCalled();
    expect(chatPullOf("agent:s1")).toBeNull();
  });

  it("refuses a request whose branch is a fork's, one the view does not name, and a folder with no remote", async () => {
    expect(await noteChatPull(host(item({ same: false, from: "stranger/site" })), "agent:s1", end(), WHERE)).toEqual({ why: "fork" });
    expect(await noteChatPull(host(item({ number: 40 })), "agent:s1", end(), WHERE)).toEqual({ why: "unread" });
    const failing = { remote: async () => ({ source: "github" as const, repo: "baanmali/site" }), view: async () => Promise.reject(new Error("gh: Not Found")) };
    expect(await noteChatPull(failing, "agent:s1", end(), WHERE)).toEqual({ why: "unread" });
    expect(await noteChatPull(host(item(), null), "agent:s2", end(), { ...WHERE, cwd: "/code/notes", root: "/code/notes" })).toEqual({ why: "no_remote" });
    expect(chatPullOf("agent:s1")).toBeNull();
  });

  it("reads nothing for a command that is not a pull request, failed, was refused, or printed no address", async () => {
    const h = host();
    for (const ev of [end({ command: "gh pr view 41" }), end({ ok: false }), end({ declined: true }), { event: "tool.start", command: "gh pr create" }, end({ command: "" })]) expect(await noteChatPull(h, "agent:s1", ev, WHERE)).toEqual({ why: "not_a_pull" });
    expect(await noteChatPull(h, "agent:s1", end({ output: "Creating pull request for fix/qr into main\n" }), WHERE)).toEqual({ why: "no_address" });
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.view).not.toHaveBeenCalled();
  });
});

// Item 120 (fifth security review): the address was the last one in the output, which the agent writes, so `gh pr create
// --dry-run … && echo <address>` linked the chat to another person's request of the same repository.
describe("a request the chat did not open (item 120)", () => {
  it("links only a request made from the chat's own branch", async () => {
    // a colleague's open request of the same repository, from a branch of its own
    const theirs = host(item({ number: 7, head: "noi/menu", url: "https://github.com/baanmali/site/pull/7" }));
    const got = await noteChatPull(theirs, "agent:s1", end({ command: "gh pr create -t x -b y; echo https://github.com/baanmali/site/pull/7", output: "https://github.com/baanmali/site/pull/7\n" }), WHERE);
    expect(got).toEqual({ why: "other_branch" });
    expect(chatPullOf("agent:s1")).toBeNull();
    expect(chatOfPull("github", "baanmali/site", 7)).toBeNull();
    // a chat whose branch is not known links nothing
    expect(await noteChatPull(host(), "agent:s2", end(), { ...WHERE, branch: undefined })).toEqual({ why: "other_branch" });
    expect(await noteChatPull(host(), "agent:s3", end(), { ...WHERE, branch: "" })).toEqual({ why: "other_branch" });
    // the plain twin: its own request links
    expect(await noteChatPull(host(), "agent:s4", end(), WHERE)).toMatchObject({ linked: { number: 41 } });
  });

  it("reads a `--dry-run`, which makes no request, as no pull request at all", async () => {
    const h = host();
    for (const command of ["gh pr create --dry-run -t x -b y && echo https://github.com/baanmali/site/pull/41", "gh pr create -t x --dry-run -b y", "gh pr create --dry-run=true -t x -b y"]) {
      expect([command, opensPull(command, WHERE)]).toEqual([command, false]);
      expect(await noteChatPull(h, "agent:s1", end({ command }), WHERE)).toEqual({ why: "not_a_pull" });
    }
    expect(h.view).not.toHaveBeenCalled();
  });
});

describe("where the link shows", () => {
  it("follows the lanes' list for its state, and shows on the chat's row only while open or a draft", async () => {
    await noteChatPull(host(), "agent:s1", end(), WHERE);
    expect(asLanePull(chatPullOf("agent:s1"))).toEqual({ source: "github", repo: "baanmali/site", number: 41, state: "open", title: "Make the QR bigger" });
    // the list read since says it merged: the header says so, and the row shows no request
    notePulls("github", "baanmali/site", [{ ...item({ state: "merged" }) }], 1, true);
    expect(chatPullOf("agent:s1")?.state).toBe("merged");
    expect(asLanePull(chatPullOf("agent:s1"))).toBeNull();
    expect(asLanePull(null)).toBeNull();
  });

  it("names the request on the chat's header, and nothing when the chat opened none", async () => {
    await noteChatPull(host(), "agent:s1", end(), WHERE);
    const html = renderToString(<ChatPullView pull={chatPullOf("agent:s1")} onOpen={() => {}} />);
    expect(html).toContain('data-testid="session-pull"');
    expect(html.replace(/<[^>]*>/g, "")).toContain(t("lane.pr", { n: 41, state: t("tasks.st.open") }));
    expect(renderToString(<ChatPullView pull={null} onOpen={() => {}} />)).toBe("");
  });
});
