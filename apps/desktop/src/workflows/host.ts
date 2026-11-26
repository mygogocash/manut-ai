// Where the workflow files are read (item 77b). In the desktop app: the shell's `workflows_read`, which reads `~/.manut/workflows/`
// and never writes there, and `workflows_folder`, which makes the folder for Show folder (src-tauri/src/workflows.rs). In a plain
// browser (dev, e2e against the mock bridge) there is no shell: a mock lists the files a test puts in
// `window.__manutMockWorkflows`.

/** One file as the shell lists it: its text, or why it did not read it. */
export interface ShellFile {
  name: string;
  text?: string;
  why?: string;
}

export type FolderState = "ok" | "missing" | "link" | "unreadable";

export interface ShellFolder {
  path: string;
  state: FolderState;
  files: ShellFile[];
  /** files past the shell's cap, not listed */
  more: number;
}

/** Why a workflow's project is not a folder a run may start in (src-tauri/src/workflows.rs `project`); `unchecked`: the shell
 *  could not say, or said something this page does not know, which allows nothing. */
export type ProjectWhy = "missing" | "link" | "too_broad" | "app_folder" | "not_repo" | "no_git" | "unchecked";
/** The project's real path, or why a run may not start in it. */
export type ProjectCheck = { real: string } | { why: ProjectWhy };

const PROJECT_WHYS: readonly ProjectWhy[] = ["missing", "link", "too_broad", "app_folder", "not_repo", "no_git"];

/** A shell's refusal (an Error's message, or the string Tauri rejects with) as a reason; anything else is `unchecked`. */
export function projectWhy(e: unknown): ProjectWhy {
  const code = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return (PROJECT_WHYS as readonly string[]).includes(code) ? (code as ProjectWhy) : "unchecked";
}

/** An answer as a check: a real path that is an absolute folder, or a reason this page knows; anything else is `unchecked`. */
export function readProjectCheck(v: unknown): ProjectCheck {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  if (typeof o.real === "string" && (o.real.startsWith("/") || /^[A-Za-z]:[\\/]/.test(o.real))) return { real: o.real };
  return { why: projectWhy(o.why) };
}

export interface WorkflowsHost {
  readonly kind: "tauri" | "mock";
  read(): Promise<ShellFolder>;
  /** Makes the folder when it is not there, and answers its path. */
  folder(): Promise<string>;
  /** Item 91: whether `project` is a folder a run may start in, as the disk has it now. */
  project(project: string): Promise<ProjectCheck>;
}

const STATES: readonly FolderState[] = ["ok", "missing", "link", "unreadable"];

/** The shell's answer, or an unreadable folder when any part of it is not what it should be. */
export function readShellFolder(v: unknown): ShellFolder {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const path = typeof o.path === "string" ? o.path : "";
  if (!STATES.includes(o.state as FolderState) || !Array.isArray(o.files)) return { path, state: "unreadable", files: [], more: 0 };
  const files = o.files.flatMap((f): ShellFile[] => {
    if (typeof f !== "object" || f === null) return [];
    const x = f as Record<string, unknown>;
    if (typeof x.name !== "string") return [];
    if (typeof x.text === "string") return [{ name: x.name, text: x.text }];
    return [{ name: x.name, why: typeof x.why === "string" ? x.why : "unreadable" }];
  });
  return { path, state: o.state as FolderState, files, more: typeof o.more === "number" && o.more > 0 ? o.more : 0 };
}

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class TauriWorkflowsHost implements WorkflowsHost {
  readonly kind = "tauri" as const;
  protected async core(): Promise<Pick<typeof import("@tauri-apps/api/core"), "invoke">> {
    return import("@tauri-apps/api/core");
  }
  async read() {
    const { invoke } = await this.core();
    return readShellFolder(await invoke<unknown>("workflows_read"));
  }
  async folder() {
    const { invoke } = await this.core();
    return String(await invoke<unknown>("workflows_folder"));
  }
  async project(project: string): Promise<ProjectCheck> {
    const { invoke } = await this.core();
    try {
      return readProjectCheck({ real: await invoke<unknown>("workflows_project", { project }) });
    } catch (e) {
      return { why: projectWhy(e) };
    }
  }
}

/** What `window.__manutMockWorkflows` gives a test (mock host only). */
export interface MockWorkflowsControl {
  path: string;
  state: FolderState;
  files: ShellFile[];
  /** How many times the folder was read. */
  reads: number;
  /** What the stand-in shell says of a project folder; one not named here is its own real path when the stand-in sessions shell
   *  knows it as a repository (`__manutBranches`, as src/sessions/host.ts's mock), else not a repository. */
  projects?: Record<string, ProjectCheck>;
}

type MockGlobals = { __manutMockWorkflows?: MockWorkflowsControl; __manutBranches?: Record<string, string> };

export class MockWorkflowsHost implements WorkflowsHost {
  readonly kind = "mock" as const;
  readonly control: MockWorkflowsControl;
  private readonly g: MockGlobals;
  constructor(g: MockGlobals = globalThis as MockGlobals) {
    this.g = g;
    this.control = g.__manutMockWorkflows ?? { path: "/Users/you/.manut/workflows", state: "missing", files: [], reads: 0 };
    g.__manutMockWorkflows = this.control;
  }
  async project(project: string): Promise<ProjectCheck> {
    const set = this.control.projects?.[project];
    if (set) return set;
    const repos = this.g.__manutBranches ?? { "/home/you/code/manut": "feat/session-controls" };
    return repos[project] ? { real: project } : { why: "not_repo" };
  }
  async read() {
    this.control.reads += 1;
    const c = this.control;
    return { path: c.path, state: c.state, files: c.state === "ok" ? c.files.map((f) => ({ ...f })) : [], more: 0 };
  }
  async folder() {
    if (this.control.state === "missing") this.control.state = "ok";
    return this.control.path;
  }
}

let host: WorkflowsHost | null = null;
export function getWorkflowsHost(): WorkflowsHost {
  return (host ??= inTauri() ? new TauriWorkflowsHost() : new MockWorkflowsHost());
}
