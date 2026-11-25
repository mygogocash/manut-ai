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

export interface WorkflowsHost {
  readonly kind: "tauri" | "mock";
  read(): Promise<ShellFolder>;
  /** Makes the folder when it is not there, and answers its path. */
  folder(): Promise<string>;
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
}

/** What `window.__manutMockWorkflows` gives a test (mock host only). */
export interface MockWorkflowsControl {
  path: string;
  state: FolderState;
  files: ShellFile[];
  /** How many times the folder was read. */
  reads: number;
}

type MockGlobals = { __manutMockWorkflows?: MockWorkflowsControl };

export class MockWorkflowsHost implements WorkflowsHost {
  readonly kind = "mock" as const;
  readonly control: MockWorkflowsControl;
  constructor(g: MockGlobals = globalThis as MockGlobals) {
    this.control = g.__manutMockWorkflows ?? { path: "/Users/you/.manut/workflows", state: "missing", files: [], reads: 0 };
    g.__manutMockWorkflows = this.control;
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
