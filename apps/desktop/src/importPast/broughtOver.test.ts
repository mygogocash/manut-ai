// History's conversations of the folders brought over (broughtOver.ts, item 101e): both agents asked for the same folders, one
// more than listed so History knows when there are more, newest first together, a failed read leaving only that agent out, and
// no read at all without a folder.
import { describe, expect, it, vi } from "vitest";
import type { PastChat } from "../sessions/host";
import { HISTORY_PER_AGENT, readBroughtOver } from "./broughtOver";

const chat = (agent: PastChat["agent"], n: number, at: number): PastChat => ({ agent, id: `${agent}-${n}`, cwd: "/home/you/code/web-app", title: `${agent} ${n}`, named: false, at });

describe("readBroughtOver", () => {
  it("asks each agent for the folders, one more than listed, and lists them newest first together", async () => {
    const pastRecent = vi.fn(async (agent: PastChat["agent"]) => (agent === "claude" ? [chat("claude", 1, 300), chat("claude", 2, 100)] : [chat("codex", 1, 200)]));
    const got = await readBroughtOver({ pastRecent }, ["/home/you/code/web-app", "/home/you/code/api"]);
    expect(pastRecent.mock.calls).toEqual([
      ["claude", ["/home/you/code/web-app", "/home/you/code/api"], HISTORY_PER_AGENT + 1],
      ["codex", ["/home/you/code/web-app", "/home/you/code/api"], HISTORY_PER_AGENT + 1],
    ]);
    expect(got.chats.map((c) => c.id)).toEqual(["claude-1", "codex-1", "claude-2"]);
    expect(got.more).toBe(false);
  });

  it("lists at most its share of each agent and says there are more", async () => {
    const many = Array.from({ length: HISTORY_PER_AGENT + 1 }, (_, i) => chat("claude", i, 1_000 - i));
    const got = await readBroughtOver({ pastRecent: async (a) => (a === "claude" ? many : []) }, ["/w"]);
    expect(got.chats).toHaveLength(HISTORY_PER_AGENT);
    expect(got.more).toBe(true);
  });

  it("leaves out only the agent whose read failed, and reads nothing without a folder or on a shell that cannot", async () => {
    const got = await readBroughtOver({ pastRecent: async (a) => (a === "codex" ? Promise.reject(new Error("no home")) : [chat("claude", 1, 5)]) }, ["/w"]);
    expect(got.chats.map((c) => c.id)).toEqual(["claude-1"]);
    const pastRecent = vi.fn(async () => []);
    expect(await readBroughtOver({ pastRecent }, [])).toEqual({ chats: [], more: false });
    expect(pastRecent).not.toHaveBeenCalled();
    expect(await readBroughtOver({}, ["/w"])).toEqual({ chats: [], more: false });
  });
});
