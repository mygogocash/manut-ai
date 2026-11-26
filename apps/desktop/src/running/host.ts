// Where what keeps running is read and stopped. In the desktop app: the shell's `running_list` and `running_stop`
// (src-tauri/src/running.rs), which look only at the processes under this app's own terminals, chats and previews. In a
// plain browser (dev, e2e against the mock bridge) there is no shell, so a mock keeps the list the page's own test seeds
// through `window.__manutMockRunning` (and the mock preview adds its fake run to, code/previewHost.ts) and records every
// call in `window.__manutRunningCalls`.
import type { RunningRow } from "./model";
import { inTauri } from "../lib/tauri";

/** `stopping`: the command and what it started were told to end. `gone`: it had ended already. */
export type StopAnswer = "stopping" | "gone";

/** Which command: all the shell is told of one, never its words. */
export type RunningTarget = Pick<RunningRow, "kind" | "session" | "pid" | "started">;

export interface RunningHost {
  readonly kind: "tauri" | "mock";
  /** Every command this app's sessions started that still runs; null when this computer cannot say (Windows, or a shell
   *  that has no such command), so the page draws nothing and stops asking. A failed look rejects. */
  list(): Promise<RunningRow[] | null>;
  /** Stop one command and the processes it started. The shell answers at once; the command ends within a few seconds. */
  stop(target: RunningTarget): Promise<StopAnswer>;
}


const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A row as the shell sent it, or nothing when any part is not what it should be: a row that cannot be read whole is
 *  not shown, rather than shown wrong. */
export function readRow(v: unknown): RunningRow[] {
  if (typeof v !== "object" || v === null) return [];
  const o = v as Record<string, unknown>;
  const { kind, session, folder, pid, started, argv, ports } = o;
  if ((kind !== "pty" && kind !== "chat" && kind !== "preview") || !num(session) || typeof folder !== "string" || !num(pid)) return [];
  if (!(started === null || started === undefined || num(started))) return [];
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string")) return [];
  if (!Array.isArray(ports) || !ports.every((p) => num(p) && p > 0 && p < 65_536)) return [];
  return [{ kind, session, folder, pid, started: started ?? null, argv: argv as string[], ports: [...(ports as number[])] }];
}

/** The shell refused because this computer cannot say (Windows), or it has no such command (an older shell). */
const cannot = (e: unknown): boolean => /unsupported|not found/i.test(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

// ---- Tauri ----------------------------------------------------------------------------------

export class TauriRunningHost implements RunningHost {
  readonly kind = "tauri" as const;
  /** The shell's command bridge (a test stands in for it by overriding this). */
  protected async core(): Promise<Pick<typeof import("@tauri-apps/api/core"), "invoke">> {
    return import("@tauri-apps/api/core");
  }
  async list() {
    const { invoke } = await this.core();
    try {
      const rows = await invoke<unknown>("running_list");
      return Array.isArray(rows) ? rows.flatMap(readRow) : [];
    } catch (e) {
      if (cannot(e)) return null;
      throw e;
    }
  }
  async stop(t: RunningTarget) {
    const { invoke } = await this.core();
    const answer = await invoke<unknown>("running_stop", { kind: t.kind, session: t.session, pid: t.pid, started: t.started });
    return answer === "gone" ? "gone" : "stopping";
  }
}

// ---- Mock -----------------------------------------------------------------------------------

/** Every stop the page asked for (the polling is not logged: it never stops). */
export type MockRunningCall = { op: "stop" } & RunningTarget;

/** What `window.__manutMockRunning` gives a test (mock host only). */
export interface MockRunningControl {
  /** What runs now. */
  rows: RunningRow[];
  /** Replace what runs. The page looks again at once. */
  set(rows: RunningRow[]): void;
  add(row: RunningRow): void;
  clear(): void;
  /** How the next stops go: `end` (the command is gone from the next list), `ignore` (it goes on running), `refuse`
   *  (the shell would not). */
  stopMode: "end" | "ignore" | "refuse";
  /** This computer cannot say what runs (the list answers null). */
  unsupported: boolean;
  /** The mock preview's own Stop (code/previewHost.ts): a preview's row is stopped as the shell stops one, through the
   *  preview, so its pane says that it was stopped. None until a fake preview has run. */
  stopPreview: ((session: number) => void) | null;
}

type MockGlobals = { __manutMockRunning?: MockRunningControl; __manutRunningCalls?: MockRunningCall[] };

export class MockRunningHost implements RunningHost {
  readonly kind = "mock" as const;
  /** The page's feed asks to look again when a test changes what runs. */
  onChange: () => void = () => {};
  readonly control: MockRunningControl;
  constructor(private g: MockGlobals = globalThis as MockGlobals) {
    const change = () => this.onChange();
    this.control = {
      rows: [],
      set: (rows) => {
        this.control.rows = rows.map((r) => ({ ...r }));
        change();
      },
      add: (row) => {
        this.control.rows = [...this.control.rows, { ...row }];
        change();
      },
      clear: () => {
        this.control.rows = [];
        change();
      },
      stopMode: "end",
      unsupported: false,
      stopPreview: null,
    };
    g.__manutMockRunning = this.control;
  }
  private log(c: MockRunningCall) {
    (this.g.__manutRunningCalls ??= []).push(c);
  }
  async list() {
    if (this.control.unsupported) return null;
    return this.control.rows.map((r) => ({ ...r, argv: [...r.argv], ports: [...r.ports] }));
  }
  async stop(t: RunningTarget) {
    this.log({ op: "stop", kind: t.kind, session: t.session, pid: t.pid, started: t.started });
    if (this.control.stopMode === "refuse") throw new Error("the shell would not stop it");
    const at = this.control.rows.findIndex((r) => r.kind === t.kind && r.session === t.session && r.pid === t.pid && r.started === t.started);
    if (at < 0) return "gone";
    if (t.kind === "preview" && this.control.stopPreview) {
      // the fake preview ends, says so to its pane and takes its own row off the list, as the shell's preview does
      this.control.stopPreview(t.session);
      return "stopping";
    }
    if (this.control.stopMode === "end") this.control.rows = this.control.rows.filter((_, i) => i !== at);
    return "stopping";
  }
}

let host: RunningHost | null = null;
export function getRunningHost(): RunningHost {
  return (host ??= inTauri() ? new TauriRunningHost() : new MockRunningHost());
}
