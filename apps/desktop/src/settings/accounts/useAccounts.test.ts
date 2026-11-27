import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, AccountGroup } from "../../lib/protocol";

const NOW = 1_800_000_000;
const shown: { tag: string }[] = [];
let notify = true;
let groups: AccountGroup[] = [];
const disk = new Map<string, string>();

vi.mock("../../state/store", () => ({
  getStore: () => ({ actions: { accounts: async () => ({ groups }), setActiveAccount: async () => {}, systemNote: () => {} } }),
  notifyEnabled: () => notify,
  useStore: () => ({ conn: "open" }),
}));
vi.mock("../../lib/notify", () => ({ showNote: async (n: { tag: string }) => void shown.push(n) }));
// `useAccounts` is called here as a plain function: what it hands React to subscribe with is kept, so a test can read
// how the shared copy tells its readers.
const react = vi.hoisted(() => ({ subscribe: null as ((f: () => void) => () => void) | null }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (subscribe: (f: () => void) => () => void, get: () => unknown) => ((react.subscribe = subscribe), get()),
}));
const asked = vi.hoisted(() => ({ status: [] as string[], version: [] as string[] }));
vi.mock("./native", () => ({
  accountHost: () => ({
    clis: async () => ({ codex: true, grok: true, pi: true }),
    status: async (cli: string, id: string) => (asked.status.push(`${cli}:${id}`), null),
    version: async (cli: string) => (asked.version.push(cli), null),
  }),
}));

const acc = (id: string): Account => ({
  id,
  label: "",
  email: "",
  state: "ready",
  usage: { id: "codex", state: "ok", source_mtime: NOW, windows: [{ label: "5 hours", used_percent: 20, resets_at: NOW + 1800 }] },
});
const setAccounts = (n: number) => {
  groups = [{ cli: "codex", installed: true, active: "none", accounts: Array.from({ length: n }, (_, i) => acc(`id${i}`)) }];
};

beforeEach(() => {
  shown.length = 0;
  notify = true;
  disk.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  vi.stubGlobal("localStorage", { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v) });
});

describe("lapse notice across reloads", () => {
  it("tells each of 101 live pairs once, not again on the next reload", async () => {
    const { reloadAccounts } = await import("./useAccounts");
    setAccounts(101);
    await reloadAccounts();
    expect(shown).toHaveLength(101);
    await reloadAccounts();
    expect(shown).toHaveLength(101);
  });

  it("records nothing while Notify me is off, so turning it on before the reset still tells once", async () => {
    const { reloadAccounts } = await import("./useAccounts");
    setAccounts(1);
    notify = false;
    await reloadAccounts();
    expect(shown).toHaveLength(0);
    notify = true;
    await reloadAccounts();
    expect(shown).toHaveLength(1);
    await reloadAccounts();
    expect(shown).toHaveLength(1);
  });
});

describe("the shared copy's readers", () => {
  it("tells its readers from a copy taken first (as before lib/changes.ts), and not after they unsubscribe", async () => {
    const { reloadAccounts, useAccounts } = await import("./useAccounts");
    useAccounts();
    const subscribe = react.subscribe!;
    const told: string[] = [];
    let offB = () => {};
    let first = true;
    const offA = subscribe(() => {
      told.push("a");
      if (!first) return;
      first = false;
      offB();
    });
    offB = subscribe(() => told.push("b"));
    setAccounts(1);
    await reloadAccounts();
    // `b`, removed while `a` was told of the first change, still hears that one change and no later one
    expect(told.slice(0, 2)).toEqual(["a", "b"]);
    expect(told.filter((x) => x === "b")).toHaveLength(1);
    expect(told.length).toBeGreaterThan(2);
    offA();
    const before = told.length;
    await reloadAccounts();
    expect(told).toHaveLength(before);
  });
});

describe("the sign-in read for each CLI's accounts (item 101d)", () => {
  it("asks for every Grok and pi account's own sign-in, as for Claude Code and Codex, and for no CLI that has none", async () => {
    const { reloadAccounts } = await import("./useAccounts");
    asked.status.length = 0;
    asked.version.length = 0;
    const row = (id: string): Account => ({ id, label: "", email: "", state: "login" });
    groups = (["grok", "pi", "omp", "gemini"] as const).map((cli) => ({ cli, installed: true, active: "default", accounts: [row("default"), row("work")] }));
    await reloadAccounts();
    expect(asked.status.sort()).toEqual(["grok:default", "grok:work", "pi:default", "pi:work"]);
    expect(asked.version.sort()).toEqual(["grok", "pi"]);
  });
});
