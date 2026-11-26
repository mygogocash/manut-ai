// A person who has Hermes but not oh-my-hermes (`omh`): the oh-my-hermes row reads "Hermes". The shell no longer
// reports that case (it looks for no Hermes), and the row is not offered (`offeredAgents`), but saved sessions and the
// pure helpers still name it, so their rules stay pinned here. The tests of the "add oh-my-hermes" installer offer
// went with that offer (src/sessions/addOmh.ts), which ran Oh My Hermes' own installer.
import { describe, expect, it } from "vitest";
import { AGENTS, agentLabel, hermesOnly, HERMES_LABEL, menuOrder, offeredAgents, rowModel, type AgentId, type AgentInfo, type SessionRec } from "./agents";

const info = (installed: AgentId[], omh: "omh" | "hermes" | "none"): AgentInfo[] =>
  AGENTS.map((a) =>
    a.id === "omh"
      ? omh === "omh"
        ? { id: a.id, label: a.label, mode: a.mode, path: "/u/.local/bin/omh" }
        : omh === "hermes"
          ? { id: a.id, label: HERMES_LABEL, mode: a.mode, path: "/u/.hermes/hermes-agent/venv/bin/python", via: "hermes" }
          : { id: a.id, label: a.label, mode: a.mode, path: null }
      : { id: a.id, label: a.label, mode: a.mode, path: installed.includes(a.id) ? `/bin/${a.id}` : null },
  );

const rec = (over: Partial<SessionRec> = {}): SessionRec => ({
  id: "s1",
  agent: "omh",
  cwd: "/home/you/code/web-app",
  startedAt: 1_700_000_000_000,
  status: "running",
  view: "chat",
  bot: "kami",
  ...over,
});

describe("Hermes without oh-my-hermes", () => {
  it("is told apart from both and from neither", () => {
    expect(hermesOnly(info(["claude"], "hermes"))).toBe(true);
    expect(hermesOnly(info(["claude"], "omh"))).toBe(false);
    expect(hermesOnly(info(["claude"], "none"))).toBe(false);
    // before the look-up answers nothing is offered
    expect(hermesOnly(null)).toBe(false);
  });

  it("names the row Hermes only then; every other agent keeps its name", () => {
    expect(agentLabel("omh", info([], "hermes"))).toBe("Hermes");
    expect(agentLabel("omh", info([], "omh"))).toBe("oh-my-hermes");
    expect(agentLabel("omh", info([], "none"))).toBe("oh-my-hermes");
    expect(agentLabel("omh", null)).toBe("oh-my-hermes");
    expect(agentLabel("claude", info([], "hermes"))).toBe("Claude Code");
  });

  it("lists the Hermes row with the installed agents (it can be picked)", () => {
    const order = menuOrder(info(["claude"], "hermes"), []).map((a) => a.id);
    expect(order.slice(0, 2)).toEqual(["claude", "omh"]);
    expect(menuOrder(info(["claude"], "none"), []).map((a) => a.id).indexOf("omh")).toBeGreaterThan(1);
  });

  it("is not offered for a new session, with or without the omh program", () => {
    for (const omh of ["omh", "hermes", "none"] as const) {
      const ids = offeredAgents(info(["claude"], omh)).map((a) => a.id);
      expect(ids).not.toContain("omh");
      expect(ids).toContain("claude");
    }
  });

  it("names the session's row Hermes on its second line", () => {
    expect(rowModel(rec(), undefined, { cwds: [], home: "/home/you", agents: info([], "hermes") }).sub).toBe("Hermes");
    expect(rowModel(rec(), undefined, { cwds: [], home: "/home/you", agents: info([], "omh") }).sub).toBe("oh-my-hermes");
  });
});
