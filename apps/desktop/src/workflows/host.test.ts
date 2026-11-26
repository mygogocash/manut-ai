// The shell's word on a workflow's project, as the page reads it (item 91): a real path, or a reason it knows; anything else
// (an older shell, an error, a reason it does not know, a path that is not absolute) is `unchecked`, which allows nothing.
import { describe, expect, it } from "vitest";
import { MockWorkflowsHost, projectWhy, readProjectCheck, TauriWorkflowsHost } from "./host";

describe("a project's check", () => {
  it("reads a real path, and each reason the shell gives", () => {
    expect(readProjectCheck({ real: "/Users/nam/code/shop" })).toEqual({ real: "/Users/nam/code/shop" });
    expect(readProjectCheck({ real: "C:\\code\\shop" })).toEqual({ real: "C:\\code\\shop" });
    for (const why of ["missing", "link", "too_broad", "app_folder", "not_repo", "no_git"]) expect(readProjectCheck({ why })).toEqual({ why });
  });

  it("allows nothing on an answer it does not understand", () => {
    for (const v of [null, undefined, "", "/Users/nam", 7, [], {}, { real: "" }, { real: "code/shop" }, { real: 1 }, { why: "ok" }, { why: "unchecked" }, { why: "__proto__" }]) {
      expect(readProjectCheck(v), JSON.stringify(v)).toEqual({ why: "unchecked" });
    }
    expect(projectWhy(new Error("too_broad"))).toBe("too_broad");
    expect(projectWhy("link")).toBe("link");
    for (const e of [new Error("invoke failed"), "command workflows_project not found", undefined, 3]) expect(projectWhy(e)).toBe("unchecked");
  });

  it("asks the shell once per check and reads a refusal as its reason", async () => {
    const calls: unknown[] = [];
    const answer = (v: unknown, fail = false) =>
      new (class extends TauriWorkflowsHost {
        protected override async core() {
          return { invoke: (async (cmd: string, args: unknown) => { calls.push([cmd, args]); if (fail) throw v; return v; }) as never };
        }
      })();
    expect(await answer("/Users/nam/code/shop").project("/Users/nam/code/shop")).toEqual({ real: "/Users/nam/code/shop" });
    expect(calls).toEqual([["workflows_project", { project: "/Users/nam/code/shop" }]]);
    expect(await answer("too_broad", true).project("/Users/nam")).toEqual({ why: "too_broad" });
    expect(await answer("something else", true).project("/x")).toEqual({ why: "unchecked" });
    expect(await answer({ not: "a path" }).project("/x")).toEqual({ why: "unchecked" });
  });

  it("the browser's stand-in: a folder its stand-in sessions shell knows as a repository, else not one, unless a test says", async () => {
    const g = { __manutBranches: { "/home/you/code/shop": "main" } } as Record<string, unknown>;
    const h = new MockWorkflowsHost(g as never);
    expect(await h.project("/home/you/code/shop")).toEqual({ real: "/home/you/code/shop" });
    expect(await h.project("/home/you")).toEqual({ why: "not_repo" });
    h.control.projects = { "/home/you": { why: "too_broad" } };
    expect(await h.project("/home/you")).toEqual({ why: "too_broad" });
  });
});
