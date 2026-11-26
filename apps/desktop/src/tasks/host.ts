// Where the Tasks page's lists come from. In the desktop app: the shell's `tasks_*` commands (src-tauri/src/tasks.rs),
// which run the person's own `gh` / `glab` with a fixed, read-only argv. In a plain browser (dev, e2e against the mock
// bridge) a mock answers from `window.__manutTasks` and records every call in `window.__manutTaskCalls`.
//
// The "나" (Me) scope and the GitHub accounts (src-tauri/src/gh_me.rs) come through the same host: the page sends
// only an account id (`<login>@<host>`), a section word and a page number; a non-active account's token never
// reaches the page (the shell reads it for one `gh` call and drops it).
import { maskSecrets } from "../lib/secrets";
import type { CliSource, CliStatus, GhAccount, GhAccounts, MeFailKind, MeItem, MePage, MeSection, MergeMethods, OtherBoard, OtherRemote, PullBoard, PullDetail, PullRow, TaskDetail, TaskFilter, TaskItem, TaskKind, TaskPage, TaskRemote } from "./types";
import { PAGE } from "./types";
import { inTauri } from "../lib/tauri";

/** A "나" list that failed, with why (`rate`: GitHub's rate limit, `auth`: sign in again, `other`). */
export class MeFail extends Error {
  constructor(
    readonly kind: MeFailKind,
    line: string,
  ) {
    super(line);
  }
}

const failOf = (e: unknown): MeFail => {
  if (e instanceof MeFail) return e;
  const o = e && typeof e === "object" ? (e as { kind?: unknown; line?: unknown; message?: unknown }) : null;
  const kind = o?.kind === "rate" || o?.kind === "auth" ? o.kind : "other";
  const line = typeof o?.line === "string" ? o.line : typeof o?.message === "string" ? o.message : String(e);
  return new MeFail(kind, line);
};

export interface TaskHost {
  readonly kind: "tauri" | "mock";
  status(source: CliSource, fresh?: boolean): Promise<CliStatus>;
  /** `account` (GitHub): a chosen account's id; none: gh's own active account. */
  list(source: CliSource, repo: string, kind: TaskKind, filter: TaskFilter, page: number, account?: string): Promise<TaskPage>;
  view(source: CliSource, repo: string, kind: TaskKind, number: number, account?: string): Promise<TaskDetail>;
  /** The GitHub / GitLab repository folder `cwd` is in (its `.git/config`), or null. */
  remote(cwd: string): Promise<TaskRemote | null>;
  /** The GitHub accounts gh is signed in to. */
  ghAccounts(fresh?: boolean): Promise<GhAccounts>;
  /** One page of a "나" section as `account`; fails with a MeFail. `fresh` (⟳, window focus): read again past a
   *  short gap instead of the minute's answer. */
  me(account: string, section: MeSection, page: number, fresh?: boolean): Promise<MePage>;
  /** Pull requests (item 100, src-tauri/src/pulls.rs): `repo`'s open requests with their checks, review and conflict. Only reads;
   *  the shell gives a list read within the minute again without asking the host. */
  board?(source: CliSource, repo: string): Promise<PullBoard>;
  /** One request opened in the app: description, checks, changed files and counts. Only reads. */
  pullView?(source: CliSource, repo: string, number: number): Promise<PullDetail>;
  /** The merge methods `repo` allows. Only reads. */
  methods?(source: CliSource, repo: string): Promise<MergeMethods>;
  /** The Azure DevOps, Gitea or Forgejo repository the project at `cwd` is in (item 100b), read by the shell from the folder, when
   *  that host's CLI is installed; null otherwise. Only reads. */
  otherRemote?(cwd: string): Promise<OtherRemote | null>;
  /** That repository's open requests, through the host's own CLI; null when there is none or its CLI is not here. Only reads: the
   *  app merges and writes nothing there. */
  otherBoard?(cwd: string): Promise<OtherBoard | null>;
}

class TauriTaskHost implements TaskHost {
  readonly kind = "tauri" as const;
  private core = () => import("@tauri-apps/api/core");
  async status(source: CliSource, fresh = false) {
    const { invoke } = await this.core();
    return invoke<CliStatus>("tasks_status", { source, fresh });
  }
  async list(source: CliSource, repo: string, kind: TaskKind, filter: TaskFilter, page: number, account?: string) {
    const { invoke } = await this.core();
    return invoke<TaskPage>("tasks_list", { source, repo, kind, filter, page, account: account ?? null });
  }
  async view(source: CliSource, repo: string, kind: TaskKind, number: number, account?: string) {
    const { invoke } = await this.core();
    return invoke<TaskDetail>("tasks_view", { source, repo, kind, number, account: account ?? null });
  }
  async remote(cwd: string) {
    const { invoke } = await this.core();
    return invoke<TaskRemote | null>("tasks_remote", { cwd });
  }
  async ghAccounts(fresh = false) {
    const { invoke } = await this.core();
    return invoke<GhAccounts>("gh_accounts", { fresh });
  }
  async me(account: string, section: MeSection, page: number, fresh = false) {
    const { invoke } = await this.core();
    return invoke<MePage>("tasks_me", { account, section, page, fresh }).catch((e) => Promise.reject(failOf(e)));
  }
  async board(source: CliSource, repo: string) {
    const { invoke } = await this.core();
    return invoke<PullBoard>("pulls_board", { source, repo });
  }
  async pullView(source: CliSource, repo: string, number: number) {
    const { invoke } = await this.core();
    return invoke<PullDetail>("pulls_view", { source, repo, number });
  }
  async methods(source: CliSource, repo: string) {
    const { invoke } = await this.core();
    return invoke<MergeMethods>("pulls_methods", { source, repo });
  }
  async otherRemote(cwd: string) {
    const { invoke } = await this.core();
    return invoke<OtherRemote | null>("pulls_other_remote", { cwd });
  }
  async otherBoard(cwd: string) {
    const { invoke } = await this.core();
    return invoke<OtherBoard | null>("pulls_other_board", { cwd });
  }
}

// ---- Mock -----------------------------------------------------------------------------------

/** What the mock answers, set by a test before the page loads (`window.__manutTasks`). */
export interface MockTasks {
  status?: Partial<Record<CliSource, CliStatus>>;
  /** `<source>:<repo>:<kind>` -> every open row (the mock filters and pages them) */
  items?: Record<string, (TaskItem & { assignee?: boolean; mine?: boolean; mentions?: boolean })[]>;
  /** `<source>:<repo>:<kind>:<number>` -> the drawer's detail (else one made from the row) */
  details?: Record<string, Partial<TaskDetail>>;
  /** folder -> remote */
  remotes?: Record<string, TaskRemote>;
  /** `<source>:<repo>` -> an error line the list fails with */
  errors?: Record<string, string>;
  /** the GitHub accounts and the "나" lists */
  gh?: {
    installed?: boolean;
    accounts?: GhAccount[];
    /** `<login>@<host>:<section>` -> every row of that section */
    me?: Record<string, MeItem[]>;
    /** `<login>@<host>` -> why every list of that account fails */
    fail?: Record<string, { kind: MeFailKind; line: string }>;
  };
  /** Pull requests: `<source>:<repo>` -> every open request the list reads */
  boards?: Record<string, PullRow[]>;
  /** `<source>:<repo>:<number>` -> the request's detail beside its row (else none) */
  pullDetails?: Record<string, Partial<Omit<PullDetail, "pull">>>;
  /** `<source>:<repo>` -> the merge methods it allows (else all three, not read) */
  methods?: Record<string, MergeMethods>;
  /** Other hosts (item 100b): folder -> its repository there and every open request, as the shell answers when the host's CLI is
   *  installed (a folder not named: none, or its CLI is not here) */
  others?: Record<string, OtherRemote & { items: PullRow[]; error?: string }>;
}

export type MockTaskCall =
  | { op: "status"; source: CliSource }
  | { op: "list"; source: CliSource; repo: string; kind: TaskKind; filter: TaskFilter; page: number; account?: string }
  | { op: "view"; source: CliSource; repo: string; kind: TaskKind; number: number; account?: string }
  | { op: "remote"; cwd: string }
  | { op: "ghAccounts"; fresh: boolean }
  | { op: "me"; account: string; section: MeSection; page: number; fresh: boolean }
  | { op: "board"; source: CliSource; repo: string }
  | { op: "pullView"; source: CliSource; repo: string; number: number }
  | { op: "methods"; source: CliSource; repo: string }
  | { op: "otherRemote"; cwd: string }
  | { op: "otherBoard"; cwd: string };

type G = { __manutTasks?: MockTasks; __manutTaskCalls?: MockTaskCall[] };

class MockTaskHost implements TaskHost {
  readonly kind = "mock" as const;
  constructor(private g: G = globalThis as G) {}
  private log(c: MockTaskCall) {
    (this.g.__manutTaskCalls ??= []).push(c);
  }
  private get data(): MockTasks {
    return this.g.__manutTasks ?? {};
  }
  async status(source: CliSource) {
    this.log({ op: "status", source });
    return this.data.status?.[source] ?? { installed: true, signed_in: true };
  }
  async list(source: CliSource, repo: string, kind: TaskKind, filter: TaskFilter, page: number, account?: string) {
    this.log({ op: "list", source, repo, kind, filter, page, ...(account ? { account } : {}) });
    await new Promise((r) => setTimeout(r, 30));
    const err = this.data.errors?.[`${source}:${repo}`];
    if (err) throw new Error(err);
    const all = (this.data.items?.[`${source}:${repo}:${kind}`] ?? []).filter((i) =>
      filter === "assigned" ? i.assignee : filter === "created" ? i.mine : filter === "mentioned" ? i.mentions : true,
    );
    const items = all.slice(page * PAGE, (page + 1) * PAGE).map(({ assignee: _a, mine: _m, mentions: _n, ...i }) => i);
    return { items, more: all.length > (page + 1) * PAGE };
  }
  async view(source: CliSource, repo: string, kind: TaskKind, number: number, account?: string) {
    this.log({ op: "view", source, repo, kind, number, ...(account ? { account } : {}) });
    await new Promise((r) => setTimeout(r, 30));
    let row = (this.data.items?.[`${source}:${repo}:${kind}`] ?? []).find((i) => i.number === number);
    // a "나" row: the drawer reads it as its account
    if (!row && account)
      for (const [k, rows] of Object.entries(this.data.gh?.me ?? {})) {
        const m = k.startsWith(`${account}:`) ? rows.find((i) => i.repo === repo && i.number === number) : undefined;
        if (m) row = { number: m.number, title: m.title, state: m.state, url: m.url, labels: m.labels, author: m.author, created: m.created, updated: m.updated, checks: null };
      }
    if (!row) throw new Error(`no #${number}`);
    const { assignee: _a, mine: _m, mentions: _n, ...item } = row;
    const d = this.data.details?.[`${source}:${repo}:${kind}:${number}`] ?? {};
    return { item, body: d.body ?? "", comments: d.comments ?? [], checks: d.checks ?? [] };
  }
  async remote(cwd: string) {
    this.log({ op: "remote", cwd });
    return this.data.remotes?.[cwd] ?? null;
  }
  async ghAccounts(fresh = false) {
    this.log({ op: "ghAccounts", fresh });
    const gh = this.data.gh ?? {};
    return { installed: gh.installed ?? true, accounts: gh.accounts ?? [] };
  }
  async me(account: string, section: MeSection, page: number, fresh = false) {
    this.log({ op: "me", account, section, page, fresh });
    await new Promise((r) => setTimeout(r, 30));
    const fail = this.data.gh?.fail?.[account];
    if (fail) throw new MeFail(fail.kind, fail.line);
    const all = this.data.gh?.me?.[`${account}:${section}`] ?? [];
    const base = section === "mentions" ? 30 : 50;
    return { items: all.slice(page * base, (page + 1) * base), more: all.length > (page + 1) * base };
  }
  async board(source: CliSource, repo: string): Promise<PullBoard> {
    this.log({ op: "board", source, repo });
    await new Promise((r) => setTimeout(r, 30));
    const err = this.data.errors?.[`${source}:${repo}`];
    if (err) throw new Error(err);
    return { items: this.data.boards?.[`${source}:${repo}`] ?? [], more: false, at: Math.floor(Date.now() / 1000) };
  }
  async pullView(source: CliSource, repo: string, number: number): Promise<PullDetail> {
    this.log({ op: "pullView", source, repo, number });
    await new Promise((r) => setTimeout(r, 30));
    const pull = (this.data.boards?.[`${source}:${repo}`] ?? []).find((p) => p.number === number);
    if (!pull) throw new Error(`no #${number}`);
    const d = this.data.pullDetails?.[`${source}:${repo}:${number}`] ?? {};
    return { pull, body: d.body ?? "", checks: d.checks ?? [], files: d.files ?? [], additions: d.additions ?? null, deletions: d.deletions ?? null, changed: d.changed ?? null };
  }
  async methods(source: CliSource, repo: string): Promise<MergeMethods> {
    this.log({ op: "methods", source, repo });
    return this.data.methods?.[`${source}:${repo}`] ?? { merge: true, squash: true, rebase: true, read: false };
  }
  async otherRemote(cwd: string): Promise<OtherRemote | null> {
    this.log({ op: "otherRemote", cwd });
    const o = this.data.others?.[cwd];
    return o ? { host: o.host, name: o.name, repo: o.repo } : null;
  }
  async otherBoard(cwd: string): Promise<OtherBoard | null> {
    this.log({ op: "otherBoard", cwd });
    await new Promise((r) => setTimeout(r, 30));
    const o = this.data.others?.[cwd];
    if (!o) return null;
    if (o.error) throw new Error(o.error);
    return { host: o.host, name: o.name, repo: o.repo, items: o.items, more: false, at: Math.floor(Date.now() / 1000) };
  }
}

// ---- Masking --------------------------------------------------------------------------------

const maskItem = <T extends TaskItem>(i: T): T => ({ ...i, title: maskSecrets(i.title), labels: i.labels.map((l) => ({ ...l, name: maskSecrets(l.name) })) });

/** A failed call as an Error whose message has no token-like string in it. */
const masked = (e: unknown) => new Error(maskSecrets(e instanceof Error ? e.message : String(e)));

/** `inner` with every text it answers (titles, labels, descriptions, comments, check names, error lines) passed
 *  through manut's one masker (src/lib/secrets.ts). The shell masks the same strings already; this keeps every
 *  surface the page draws from (the list, the drawer, Start in thread's text, the error line) masked whichever
 *  host answered. */
export class MaskingTaskHost implements TaskHost {
  constructor(private inner: TaskHost) {}
  get kind() {
    return this.inner.kind;
  }
  status(source: CliSource, fresh?: boolean) {
    return this.inner.status(source, fresh).catch((e) => Promise.reject(masked(e)));
  }
  async list(source: CliSource, repo: string, kind: TaskKind, filter: TaskFilter, page: number, account?: string): Promise<TaskPage> {
    const p = await this.inner.list(source, repo, kind, filter, page, account).catch((e) => Promise.reject(masked(e)));
    return { ...p, items: p.items.map(maskItem) };
  }
  async view(source: CliSource, repo: string, kind: TaskKind, number: number, account?: string): Promise<TaskDetail> {
    const d = await this.inner.view(source, repo, kind, number, account).catch((e) => Promise.reject(masked(e)));
    return {
      item: maskItem(d.item),
      body: maskSecrets(d.body),
      comments: d.comments.map((c) => ({ ...c, body: maskSecrets(c.body) })),
      checks: d.checks.map((c) => ({ ...c, name: maskSecrets(c.name) })),
    };
  }
  remote(cwd: string) {
    return this.inner.remote(cwd).catch((e) => Promise.reject(masked(e)));
  }
  ghAccounts(fresh?: boolean) {
    return this.inner.ghAccounts(fresh).catch((e) => Promise.reject(masked(e)));
  }
  async me(account: string, section: MeSection, page: number, fresh?: boolean): Promise<MePage> {
    const p = await this.inner.me(account, section, page, fresh).catch((e) => {
      const f = failOf(e);
      return Promise.reject(new MeFail(f.kind, maskSecrets(f.message)));
    });
    return { ...p, items: p.items.map((i) => ({ ...i, title: maskSecrets(i.title), labels: i.labels.map((l) => ({ ...l, name: maskSecrets(l.name) })) })) };
  }
  async board(source: CliSource, repo: string): Promise<PullBoard> {
    if (!this.inner.board) throw new Error("no_shell");
    const b = await this.inner.board(source, repo).catch((e) => Promise.reject(masked(e)));
    return { ...b, items: b.items.map(maskItem) };
  }
  async pullView(source: CliSource, repo: string, number: number): Promise<PullDetail> {
    if (!this.inner.pullView) throw new Error("no_shell");
    const d = await this.inner.pullView(source, repo, number).catch((e) => Promise.reject(masked(e)));
    return { ...d, pull: maskItem(d.pull), body: maskSecrets(d.body), checks: d.checks.map((c) => ({ ...c, name: maskSecrets(c.name) })), files: d.files.map((f) => ({ ...f, path: maskSecrets(f.path) })) };
  }
  methods(source: CliSource, repo: string): Promise<MergeMethods> {
    if (!this.inner.methods) return Promise.resolve({ merge: true, squash: true, rebase: true, read: false });
    return this.inner.methods(source, repo).catch((e) => Promise.reject(masked(e)));
  }
  async otherRemote(cwd: string): Promise<OtherRemote | null> {
    if (!this.inner.otherRemote) return null;
    const r = await this.inner.otherRemote(cwd).catch((e) => Promise.reject(masked(e)));
    return r ? { ...r, name: maskSecrets(r.name), repo: maskSecrets(r.repo) } : null;
  }
  async otherBoard(cwd: string): Promise<OtherBoard | null> {
    if (!this.inner.otherBoard) return null;
    const b = await this.inner.otherBoard(cwd).catch((e) => Promise.reject(masked(e)));
    return b ? { ...b, name: maskSecrets(b.name), repo: maskSecrets(b.repo), items: b.items.map(maskItem) } : null;
  }
}


let host: TaskHost | null = null;
export function taskHost(): TaskHost {
  return (host ??= new MaskingTaskHost(inTauri() ? new TauriTaskHost() : new MockTaskHost()));
}
