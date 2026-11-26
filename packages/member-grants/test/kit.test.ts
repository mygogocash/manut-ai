import { describe, expect, it } from "vitest";
import {
  DEFAULT_KIT_LEVEL,
  KIT_ACTIONS,
  KIT_LEVELS,
  kitDecide,
  kitLevelOf,
  mayAlwaysAllow,
  newConnection,
  type KitAction,
  type KitLevel,
  type Roster,
} from "../src";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 24, 9, 0);
// A developer's own project on this Mac: connected when it was added, with no practice days.
const project = newConnection(T0, 0);
const now = T0 + 60_000;

const alone = { answer: "alone" } as const;
const ask = (always: boolean) => ({ answer: "ask", kind: "command", mayAlwaysAllow: always }) as const;

describe("Kit's dial", () => {
  it("has the canvas's four stops, lowest first, and starts at the lowest", () => {
    expect(KIT_LEVELS).toEqual(["asks_every_time", "edits_alone", "edits_and_safe_commands", "everything_in_project"]);
    expect(DEFAULT_KIT_LEVEL).toBe("asks_every_time");
  });

  // Every level against every kind of step, inside the project, with no rule kept. Reading and checks never ask
  // ("Reading files and running the tests do not"); each level adds what the canvas's line says it does alone; going
  // live and what nobody can read ask at every level.
  const table: Record<KitAction, Record<KitLevel, unknown>> = {
    read: { asks_every_time: alone, edits_alone: alone, edits_and_safe_commands: alone, everything_in_project: alone },
    check: { asks_every_time: alone, edits_alone: alone, edits_and_safe_commands: alone, everything_in_project: alone },
    edit: { asks_every_time: ask(false), edits_alone: alone, edits_and_safe_commands: alone, everything_in_project: alone },
    change: { asks_every_time: ask(true), edits_alone: ask(true), edits_and_safe_commands: alone, everything_in_project: alone },
    install: { asks_every_time: ask(true), edits_alone: ask(true), edits_and_safe_commands: ask(true), everything_in_project: alone },
    delete: { asks_every_time: ask(true), edits_alone: ask(true), edits_and_safe_commands: ask(true), everything_in_project: alone },
    push: { asks_every_time: ask(true), edits_alone: ask(true), edits_and_safe_commands: ask(true), everything_in_project: alone },
    live: { asks_every_time: ask(false), edits_alone: ask(false), edits_and_safe_commands: ask(false), everything_in_project: ask(false) },
    unknown: { asks_every_time: ask(false), edits_alone: ask(false), edits_and_safe_commands: ask(false), everything_in_project: ask(false) },
  };
  for (const action of KIT_ACTIONS)
    for (const level of KIT_LEVELS)
      it(`${level}: ${action} inside the project`, () => {
        expect(kitDecide({ action, outside: false }, level, project, now)).toEqual(table[action][level]);
      });
});

describe("rules no level or data can change", () => {
  it("going live asks at every level, whatever a kept rule or the data says", () => {
    for (const level of KIT_LEVELS) {
      expect(kitDecide({ action: "live", outside: false, alwaysAllowed: true }, level, project, now)).toEqual(ask(false));
    }
    expect(mayAlwaysAllow("live")).toBe(false);
  });

  it("blocks anything outside the project at every level, reads included, rule or not", () => {
    for (const action of KIT_ACTIONS)
      for (const level of KIT_LEVELS)
        expect(kitDecide({ action, outside: true, alwaysAllowed: true }, level, project, now)).toEqual({
          answer: "blocked",
          reason: "outside_project",
        });
  });

  it("never saves or sends a change holding a key alone, and offers no rule for it", () => {
    for (const action of ["change", "push", "install", "delete", "edit"] as const)
      for (const level of KIT_LEVELS)
        expect(kitDecide({ action, outside: false, holdsSecret: true, alwaysAllowed: true }, level, project, now)).toEqual(ask(false));
    // a read or a check saves nothing, so a key in the change does not stop it
    expect(kitDecide({ action: "check", outside: false, holdsSecret: true }, "asks_every_time", project, now)).toEqual(alone);
  });

  it("asks for a step nobody can read, at every level, and keeps no rule for it", () => {
    expect(mayAlwaysAllow("unknown")).toBe(false);
    expect(kitDecide({ action: "unknown", outside: false, alwaysAllowed: true }, "everything_in_project", project, now)).toEqual(ask(false));
  });

  it("refuses a step it does not know, and falls back to the lowest level for a level it does not know", () => {
    expect(kitDecide({ action: "fly" as KitAction, outside: false }, "everything_in_project", project, now)).toEqual({
      answer: "refused",
      reason: "unknown_action",
    });
    expect(kitLevelOf("everything_in_project")).toBe("everything_in_project");
    for (const broken of ["Everything", "", null, undefined, 3, "everything_in_project "])
      expect(kitLevelOf(broken)).toBe("asks_every_time");
    expect(kitDecide({ action: "install", outside: false }, "everything" as KitLevel, project, now)).toEqual(ask(true));
  });

  it("uses approval-core's kind for Kit's job: command", () => {
    const d = kitDecide({ action: "install", outside: false }, "asks_every_time", project, now);
    expect(d).toMatchObject({ answer: "ask", kind: "command" });
  });
});

describe("Always allow in this project", () => {
  it("is offered for commands that change, install, delete or push, and for nothing else", () => {
    expect(KIT_ACTIONS.filter(mayAlwaysAllow)).toEqual(["change", "install", "delete", "push"]);
  });

  it("lets a kept rule's command go alone below the level that would allow it", () => {
    for (const action of ["change", "install", "delete", "push"] as const)
      expect(kitDecide({ action, outside: false, alwaysAllowed: true }, "asks_every_time", project, now)).toEqual(alone);
  });

  it("is ignored for an edit, which the dial decides", () => {
    expect(kitDecide({ action: "edit", outside: false, alwaysAllowed: true }, "asks_every_time", project, now)).toEqual(ask(false));
  });
});

describe("in step with the rest of the team (decide)", () => {
  it("in practice, reads and checks still run and every change is a draft", () => {
    const practising = newConnection(T0);
    for (const level of KIT_LEVELS) {
      expect(kitDecide({ action: "read", outside: false }, level, practising, T0 + DAY)).toEqual(alone);
      expect(kitDecide({ action: "check", outside: false }, level, practising, T0 + DAY)).toEqual(alone);
      for (const action of ["edit", "change", "install", "delete", "push", "live", "unknown"] as const)
        expect(kitDecide({ action, outside: false, alwaysAllowed: true }, level, practising, T0 + DAY)).toEqual({
          answer: "draft_only",
          kind: "command",
        });
    }
    // and it is blocked outside the project, in practice or not
    expect(kitDecide({ action: "read", outside: true }, "asks_every_time", practising, T0 + DAY).answer).toBe("blocked");
  });

  it("without the project, Kit can do nothing", () => {
    for (const action of KIT_ACTIONS) {
      expect(kitDecide({ action, outside: false }, "everything_in_project", null, now)).toEqual({ answer: "not_connected" });
      expect(kitDecide({ action, outside: false }, "everything_in_project", { ...project, connected: false }, now)).toEqual({
        answer: "not_connected",
      });
    }
  });

  it("follows the roster: Kit's job may move, and Kit may be missing", () => {
    const moved = [
      { id: "kit", capabilities: [] },
      { id: "nam", capabilities: [{ id: "run_command", access: "write", kind: "command", needsConnection: true }] },
    ] as unknown as Roster;
    expect(kitDecide({ action: "read", outside: false }, "asks_every_time", project, now, moved)).toEqual({ answer: "not_my_job", member: "nam" });
    const noKit = [{ id: "nam", capabilities: [] }] as unknown as Roster;
    expect(kitDecide({ action: "read", outside: false }, "asks_every_time", project, now, noKit)).toEqual({
      answer: "refused",
      reason: "unknown_member",
    });
  });

  it("asks as a command even when the data calls Kit's job a read", () => {
    const sneaky = [{ id: "kit", capabilities: [{ id: "run_command", access: "read", needsConnection: true }] }] as unknown as Roster;
    expect(kitDecide({ action: "install", outside: false }, "asks_every_time", project, now, sneaky)).toEqual(ask(true));
    expect(kitDecide({ action: "live", outside: false }, "everything_in_project", project, now, sneaky)).toEqual(ask(false));
  });
});
