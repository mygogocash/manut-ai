// Settings › Worktrees › For one project (item 99), drawn from props with react-dom/server: no projects says where they come
// from; a picked project shows each choice as all projects' (with its value) or its own, and its prefix with all projects' as
// the hint. What a press does is lib/worktrees.test.ts's and sessions/lanes.test.ts's.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WORKTREE_DEFAULTS } from "../lib/worktrees";
import { projectChoices, ProjectWorktreesView } from "./ProjectWorktrees";

const base = { projects: [] as string[], project: null, own: {}, all: { ...WORKTREE_DEFAULTS, prefix: "team/" }, prefixText: "", onProject: () => {}, onFlag: () => {}, onPrefixText: () => {}, onPrefixSave: () => {}, onPrefixClear: () => {} };
const draw = (over: Partial<Parameters<typeof ProjectWorktreesView>[0]>) => renderToString(createElement(ProjectWorktreesView, { ...base, ...over }));

describe("worktrees for one project", () => {
  it("says where projects come from while there are none", () => {
    expect(draw({})).toContain("No projects yet: they come from your coding chats.");
  });

  it("shows each choice as all projects' with its value, or the project's own, and all projects' prefix as the hint", () => {
    const html = draw({ projects: ["/w/shop"], project: "/w/shop", own: { remote: true, prefix: "shop/" }, prefixText: "shop/" });
    expect(html).toContain("/w/shop");
    expect(html).toContain("As all projects (Off)");
    expect(html).toMatch(/aria-checked="true"[^>]*>On</);
    expect(html).toContain("Leave it empty to use all projects&#x27; prefix, team/");
    expect(html).toContain("worktrees-project-prefix-clear");
  });

  it("lists every chat's folder, every project the dial knows and every one with its own choices, once each", () => {
    expect(projectChoices(["/w/b", "/w/a/", ""], ["/w/a"], ["/w/c"])).toEqual(["/w/a", "/w/b", "/w/c"]);
  });
});
