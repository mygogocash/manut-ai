// The page's side of item 103's door (`src-tauri/src/threads_mcp`): the switch, and the calls other programs make, each handed
// over as an app-wide event (`threads-mcp-call`) and answered once (`threads_mcp_reply`). A call the program gave up, or that
// waited ten minutes, comes as `threads-mcp-gone`. The shell hands the page nothing until the page says it listens
// (`threads_mcp_listen`), so a window that is not ready answers at once instead of leaving a call to wait.
//
// In the browser specs, `window.__manutThreadsMcpMock` stands in for the shell: the spec pushes calls with `call` and `gone`,
// and reads what the page answered from `replies`.
import { inTauri } from "../lib/tauri";

/** What Settings shows (`threads_mcp::Shown`). */
export interface McpSettings {
  on: boolean;
  /** This build offers it: the Mac app, not the App Store edition. */
  available: boolean;
  /** This app's program, which the address to copy names. */
  command: string;
  args: string[];
}

/** The program that asks, as the shell named it from the kernel (`door::Program`). */
export interface McpProgram {
  name: string;
  path: string;
  /** What it called itself: its own words, shown only as such. */
  callsItself: string | null;
}

/** The tools a call can be, and the shell's own card for a program not yet let in. */
export type McpTool = "let_in" | "list_chats" | "read_chat" | "send_to_chat" | "open_chat";

/** One call (`door::Call`). */
export interface McpCall {
  id: string;
  tool: McpTool;
  args: Record<string, unknown>;
  program: McpProgram;
}

export interface McpShell {
  settings(): Promise<McpSettings>;
  set(on: boolean): Promise<McpSettings>;
  /** Hears calls and calls that are gone, then tells the shell the page listens. */
  listen(onCall: (c: McpCall) => void, onGone: (id: string) => void): Promise<void>;
  /** Answers call `id` once. False when no call of that id waits (it was answered, or it is gone). */
  reply(id: string, text: string, error: boolean): Promise<boolean>;
}

interface MockState {
  state: McpSettings;
  replies: { id: string; text: string; error: boolean }[];
  pending: Set<string>;
  call?: (c: McpCall) => void;
  gone?: (id: string) => void;
}

interface MockGlobals {
  __manutThreadsMcpMock?: boolean;
  __manutThreadsMcp?: MockState;
}

const mockOn = () => typeof window !== "undefined" && !!(window as unknown as MockGlobals).__manutThreadsMcpMock;

function mockShell(): McpShell {
  const g = window as unknown as MockGlobals;
  const m: MockState = (g.__manutThreadsMcp ??= {
    state: { on: false, available: true, command: "/Applications/Manut AI.app/Contents/MacOS/manut", args: ["--threads-mcp"] },
    replies: [],
    pending: new Set(),
  });
  return {
    async settings() {
      return { ...m.state };
    },
    async set(on) {
      m.state = { ...m.state, on };
      return { ...m.state };
    },
    async listen(onCall, onGone) {
      m.call = (c) => {
        m.pending.add(c.id);
        onCall(c);
      };
      m.gone = (id) => {
        m.pending.delete(id);
        onGone(id);
      };
    },
    async reply(id, text, error) {
      if (!m.pending.delete(id)) return false;
      m.replies.push({ id, text, error });
      return true;
    },
  };
}

function tauriShell(): McpShell {
  return {
    async settings() {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<McpSettings>("threads_mcp_settings");
    },
    async set(on) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<McpSettings>("threads_mcp_set", { on });
    },
    async listen(onCall, onGone) {
      const [{ listen }, { invoke }] = await Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/core")]);
      await listen<McpCall>("threads-mcp-call", (e) => onCall(e.payload));
      await listen<string>("threads-mcp-gone", (e) => onGone(e.payload));
      await invoke<boolean>("threads_mcp_listen");
    },
    async reply(id, text, error) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<boolean>("threads_mcp_reply", { id, text, error });
    },
  };
}

/** A shell that offers nothing: a plain browser with no stand-in. */
const noShell: McpShell = {
  async settings() {
    return { on: false, available: false, command: "", args: [] };
  },
  async set() {
    throw new Error("not offered here");
  },
  async listen() {},
  async reply() {
    return false;
  },
};

let shell: McpShell | null = null;
/** The shell the page uses, made once. */
export function getMcpShell(): McpShell {
  shell ??= inTauri() ? tauriShell() : mockOn() ? mockShell() : noShell;
  return shell;
}
