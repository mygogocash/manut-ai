// Where a lane's preview is read, started, stopped and opened (previewRun.ts says what is decided, previewStore.ts keeps each
// lane's). In the desktop app: the shell's `preview_read`, `preview_start`, `preview_stop` and `preview_open`
// (src-tauri/src/preview.rs). In a plain browser (dev, e2e against the mock bridge, Practice) there is no shell, so a mock runs a
// fake preview: it prints a dev server's lines and its address, lists itself with what keeps running (running/host.ts's mock),
// and records every call in `window.__manutPreviewCalls`. A test says what a folder holds and how the run goes through
// `window.__manutMockPreview`.
import { MockRunningHost, getRunningHost } from "../running/host";
import { readProject, START_WAIT_MS, type PreviewProject } from "./previewRun";

/** What a running preview says: lines it printed (stdout and stderr, as they arrived), and once, how it ended. */
export type PreviewEvent = { event: "lines"; lines: string[] } | { event: "exit"; code: number | null; stopped: boolean };

export interface PreviewHost {
  readonly kind: "tauri" | "mock";
  /** How long a preview may take to print its address before the view stops saying it is starting (a test's mock shortens it). */
  readonly startWait: number;
  /** What the lane's own folder `dir` holds. Rejects with the shell's word (`not_a_lane`, `unsupported`). */
  read(dir: string): Promise<PreviewProject>;
  /** Start `argv` in `dir`, chosen from the package.json text `packageJson`, with the secrets `env` over the few variables a dev
   *  server needs. Its id; rejects with the shell's word (`changed`, `running`, `missing:pnpm`, …). */
  start(dir: string, argv: string[], packageJson: string, env: [string, string][], onEvent: (ev: PreviewEvent) => void): Promise<number>;
  /** `stopping`, or `gone` when it had ended already. */
  stop(id: number): Promise<"stopping" | "gone">;
  /** Its address in the person's browser: only an address of this computer, which the shell checks again. */
  open(url: string): Promise<void>;
}

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** An event as the shell sent it, or null when it is not one: a line that is not text is dropped rather than shown wrong. */
export function readEvent(v: unknown): PreviewEvent | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.event === "lines" && Array.isArray(o.lines)) return { event: "lines", lines: o.lines.filter((l): l is string => typeof l === "string") };
  if (o.event === "exit") return { event: "exit", code: typeof o.code === "number" && Number.isInteger(o.code) ? o.code : null, stopped: o.stopped === true };
  return null;
}

/** The shell's refusal as its word. */
const word = (e: unknown): string => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

// ---- Tauri ----------------------------------------------------------------------------------

export class TauriPreviewHost implements PreviewHost {
  readonly kind = "tauri" as const;
  readonly startWait = START_WAIT_MS;
  /** The shell's command bridge (a test stands in for it by overriding this). */
  protected async core(): Promise<Pick<typeof import("@tauri-apps/api/core"), "invoke" | "Channel">> {
    return import("@tauri-apps/api/core");
  }
  async read(dir: string) {
    const { invoke } = await this.core();
    let raw: unknown;
    try {
      raw = await invoke<unknown>("preview_read", { cwd: dir });
    } catch (e) {
      // a shell older than the preview has no such command: it cannot run one
      throw new Error(/not found/i.test(word(e)) ? "unsupported" : word(e));
    }
    const p = readProject(raw);
    if (!p) throw new Error("unsupported");
    return p;
  }
  async start(dir: string, argv: string[], packageJson: string, env: [string, string][], onEvent: (ev: PreviewEvent) => void) {
    const { invoke, Channel } = await this.core();
    const ch = new Channel<unknown>();
    ch.onmessage = (raw) => {
      const ev = readEvent(raw);
      if (ev) onEvent(ev);
    };
    try {
      return await invoke<number>("preview_start", { cwd: dir, argv, package: packageJson, env, onEvent: ch });
    } catch (e) {
      throw new Error(word(e));
    }
  }
  async stop(id: number) {
    const { invoke } = await this.core();
    return (await invoke<unknown>("preview_stop", { id })) === "gone" ? ("gone" as const) : ("stopping" as const);
  }
  async open(url: string) {
    const { invoke } = await this.core();
    await invoke("preview_open", { url });
  }
}

// ---- Mock -----------------------------------------------------------------------------------

/** How a fake preview goes: `serve` prints its lines and then its address; `quiet` prints lines and never an address; `crash`
 *  prints an error (with a key in it, which the view must hide) and ends by itself with exit 1; `refuse:<word>` is a start the
 *  shell refuses with that word (`refuse:missing:pnpm`, `refuse:changed`). */
export type MockPreviewMode = "serve" | "quiet" | "crash" | `refuse:${string}`;

/** What `window.__manutMockPreview` gives a test (mock host only). */
export interface MockPreviewControl {
  /** What a folder holds, by folder; a folder left out holds `MOCK_PROJECT`. */
  projects: Record<string, PreviewProject>;
  mode: MockPreviewMode;
  /** How long a fake run takes to print its address, or to crash (ms). */
  delay: number;
  /** The read rejects with this word (`not_a_lane`, `unsupported`). */
  readError: string | null;
  /** How long the view waits for an address before it stops saying it is starting (ms): a test need not wait a minute. */
  startWait: number;
}

export type MockPreviewCall =
  | { op: "read"; dir: string }
  | { op: "start"; dir: string; argv: string[]; env: [string, string][]; id?: number }
  | { op: "stop"; id: number }
  | { op: "open"; url: string };

type MockGlobals = { __manutMockPreview?: MockPreviewControl; __manutPreviewCalls?: MockPreviewCall[] };

/** The canvas's project: a Vite app with a `dev` script and pnpm's lockfile, whose `.env.example` names the shop ID and a Stripe
 *  key (with a sample that looks like a real key, so it is a secret by its value too). */
export const MOCK_PROJECT: PreviewProject = {
  packageJson: JSON.stringify({ name: "baanmali-preorder", private: true, scripts: { dev: "vite", build: "vite build", deploy: "wrangler deploy" } }, null, 2),
  files: [".env.example", "index.html", "package.json", "pnpm-lock.yaml", "src", "vite.config.ts"],
  envExample: "# PromptPay ID the QR code pays to\nPROMPTPAY_SHOP_ID=\n\n# Stripe, for cards\nSTRIPE_SECRET_KEY=sk_test_replace_me\nVITE_SHOP_NAME=Baan Mali\n",
};

const ESC = "\u001b";

interface FakeRun {
  dir: string;
  emit: (ev: PreviewEvent) => void;
  timers: ReturnType<typeof setTimeout>[];
  pid: number;
  started: number;
  argv: string[];
}

export class MockPreviewHost implements PreviewHost {
  readonly kind = "mock" as const;
  readonly control: MockPreviewControl;
  private next = 0;
  private runs = new Map<number, FakeRun>();
  constructor(private g: MockGlobals = globalThis as MockGlobals) {
    this.control = g.__manutMockPreview ?? { projects: {}, mode: "serve", delay: 400, readError: null, startWait: START_WAIT_MS };
    g.__manutMockPreview = this.control;
  }
  get startWait() {
    return this.control.startWait;
  }
  private log(c: MockPreviewCall) {
    (this.g.__manutPreviewCalls ??= []).push(c);
  }
  /** The mock list of what keeps running, when the page uses one. */
  private running(): MockRunningHost | null {
    const h = getRunningHost();
    return h instanceof MockRunningHost ? h : null;
  }
  async read(dir: string) {
    this.log({ op: "read", dir });
    if (this.control.readError) throw new Error(this.control.readError);
    const p = this.control.projects[dir] ?? MOCK_PROJECT;
    return { packageJson: p.packageJson, files: [...p.files], envExample: p.envExample };
  }
  async start(dir: string, argv: string[], _packageJson: string, env: [string, string][], onEvent: (ev: PreviewEvent) => void) {
    const call: MockPreviewCall = { op: "start", dir, argv: [...argv], env: env.map(([k, v]) => [k, v]) };
    this.log(call);
    const mode = this.control.mode;
    if (mode.startsWith("refuse:")) throw new Error(mode.slice("refuse:".length));
    if ([...this.runs.values()].some((r) => r.dir === dir)) throw new Error("running");
    const id = ++this.next;
    call.id = id;
    const [manager, , script] = argv;
    const run: FakeRun = { dir, emit: onEvent, timers: [], pid: 40_000 + id, started: Date.now(), argv: ["node", `/usr/local/lib/node_modules/${manager}/bin/${manager}.cjs`, "run", script] };
    this.runs.set(id, run);
    const later = (ms: number, fn: () => void) => run.timers.push(setTimeout(fn, ms));
    later(0, () => onEvent({ event: "lines", lines: ["", `> baanmali-preorder@0.0.0 ${script} ${dir}`, "> vite", ""] }));
    if (mode === "serve") {
      later(this.control.delay, () => {
        onEvent({ event: "lines", lines: [`  ${ESC}[32m${ESC}[1mVITE${ESC}[22m v7.1.2${ESC}[39m  ready in 312 ms`, "", `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`, `  ${ESC}[2m➜  Network: use --host to expose${ESC}[22m`] });
        this.running()?.control.add({ kind: "preview", session: id, folder: dir, pid: run.pid, started: run.started, argv: run.argv, ports: [5173] });
      });
    } else if (mode === "quiet") {
      later(this.control.delay, () => onEvent({ event: "lines", lines: ["Compiling the first build…", "Still compiling…"] }));
      later(this.control.delay, () => this.running()?.control.add({ kind: "preview", session: id, folder: dir, pid: run.pid, started: run.started, argv: run.argv, ports: [] }));
    } else {
      later(this.control.delay, () => {
        onEvent({ event: "lines", lines: ["Error: Cannot find module 'vite'", "Require stack:", "- loaded with STRIPE_SECRET_KEY sk-FAKE0000000000000000TEST", "    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)"] });
        this.end(id, 1, false);
      });
    }
    const control = this.running()?.control;
    if (control) control.stopPreview = (session) => void this.stop(session);
    return id;
  }
  /** The fake run `id` ends: its timers stop, its row leaves what keeps running, and its pane hears how it ended. */
  private end(id: number, code: number | null, stopped: boolean) {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.delete(id);
    run.timers.forEach(clearTimeout);
    const running = this.running();
    if (running) running.control.set(running.control.rows.filter((r) => !(r.kind === "preview" && r.session === id)));
    run.emit({ event: "exit", code, stopped });
  }
  async stop(id: number) {
    this.log({ op: "stop", id });
    if (!this.runs.has(id)) return "gone" as const;
    // a hang-up a dev server ends on at once, as the shell's Stop gets from a real one
    setTimeout(() => this.end(id, null, true), 150);
    return "stopping" as const;
  }
  async open(url: string) {
    this.log({ op: "open", url });
  }
}

let host: PreviewHost | null = null;
export function getPreviewHost(): PreviewHost {
  return (host ??= inTauri() ? new TauriPreviewHost() : new MockPreviewHost());
}
