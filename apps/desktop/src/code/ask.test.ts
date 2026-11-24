// An ask a coding session raised, read as one of Kit's steps by the words the shell writes on it (agent_chat.rs and
// acp_chat.rs), then decided by Kit's dial for the project. The project is the canvas's baanmali-preorder.
import { describe, expect, it } from "vitest";
import { decideAsk, readAsk } from "./ask";
import { addRule, allowFolder, emptyProject, projectOf, setLevel, type KitProject } from "./project";
import type { Where } from "./command";

const root = "/Users/fon/baanmali-preorder";
const where: Where = { cwd: root, root, home: "/Users/fon", branch: "kit/promptpay-qr" };
const run = (command: string) => ({ title: "Run this command?", command, cwd: root });
const at = (level: KitProject["level"]): KitProject => ({ ...emptyProject(), level });

describe("reading an ask", () => {
  it("reads a command, as Claude Code, Codex and the ACP agents ask it", () => {
    expect(readAsk(run("pnpm add qrcode"), where)).toMatchObject({ what: "command", action: "install", outside: [], rule: { words: ["pnpm", "add"] }, say: { key: "kit.say.add1" } });
    // Codex puts its reason in the title
    expect(readAsk({ title: "Install the packages the QR code needs", command: "pnpm install", cwd: root }, where)).toMatchObject({ what: "command", action: "install" });
  });

  it("reads a file change and where it is", () => {
    expect(readAsk({ title: "Allow Edit to change src/checkout.tsx?", command: "" }, where)).toMatchObject({ what: "edit", action: "edit", outside: [], say: { key: "kit.say.edit", vars: { path: "src/checkout.tsx" } } });
    expect(readAsk({ title: "Allow Write to change /Users/fon/other/x.ts?", command: "" }, where)).toMatchObject({ what: "edit", outside: ["/Users/fon/other/x.ts"], folder: "/Users/fon/other" });
    expect(readAsk({ title: "Allow Codex to change src/a.ts, ../b.ts?", command: "" }, where)).toMatchObject({ what: "edit", outside: ["../b.ts"] });
  });

  it("reads a file read, and the folder allowing it would add", () => {
    expect(readAsk({ title: "Allow Read?", command: "/Users/fon/Documents/tax-2026.xlsx" }, where)).toMatchObject({
      what: "read",
      action: "read",
      outside: ["/Users/fon/Documents/tax-2026.xlsx"],
      folder: "/Users/fon/Documents",
      say: { key: "kit.say.readFile", vars: { path: "/Users/fon/Documents/tax-2026.xlsx" } },
    });
    expect(readAsk({ title: "Allow Read?", command: `${root}/src/a.ts` }, where)).toMatchObject({ what: "read", outside: [] });
    expect(readAsk(run("cat ~/Documents/tax-2026.xlsx"), where)).toMatchObject({ what: "command", outside: ["~/Documents/tax-2026.xlsx"], folder: "/Users/fon/Documents" });
  });

  it("leaves alone what it cannot read whole: plans, other tools, cut paths, changes that name no file", () => {
    expect(readAsk({ title: "Start working on this plan?", command: "", plan: "1. Do it" }, where)).toBeNull();
    expect(readAsk({ title: "Allow WebFetch?", command: "https://example.com" }, where)).toBeNull();
    expect(readAsk({ title: "Allow mcp__shop__orders?", command: "status: open" }, where)).toBeNull();
    expect(readAsk({ title: "Allow Read?", command: "/Users/fon/a-very-long-folder/…" }, where)).toBeNull();
    expect(readAsk({ title: "Allow Codex to change files?", command: "" }, where)).toBeNull();
    expect(readAsk({ title: "Allow Codex to change src/a.ts, src/b…?", command: "" }, where)).toBeNull();
    expect(readAsk({ title: "Some tool", command: "" }, where)).toBeNull();
  });
});

describe("deciding an ask by Kit's dial", () => {
  const decide = (ask: Parameters<typeof readAsk>[0], project: KitProject, keys: string[] = []) => decideAsk(readAsk(ask, where)!, ask, project, keys);

  it("asks for the canvas's install, and offers to keep the rule", () => {
    expect(decide(run("pnpm add qrcode"), at("asks_every_time"))).toEqual({ answer: "ask", kind: "command", mayAlwaysAllow: true });
  });

  it("runs it alone once its rule is kept, but not a different command", () => {
    const p = projectOf(addRule({}, root, { words: ["pnpm", "add"] }), root);
    expect(decide(run("pnpm add dayjs"), p)).toEqual({ answer: "alone" });
    expect(decide(run("pnpm remove dayjs"), p)).toMatchObject({ answer: "ask" });
  });

  it("runs the tests alone at every level", () => {
    expect(decide(run("pnpm test"), at("asks_every_time"))).toEqual({ answer: "alone" });
  });

  it("edits alone from Edits alone up", () => {
    const edit = { title: "Allow Edit to change src/checkout.tsx?", command: "" };
    expect(decide(edit, at("asks_every_time"))).toMatchObject({ answer: "ask" });
    expect(decide(edit, at("edits_alone"))).toEqual({ answer: "alone" });
  });

  it("blocks a read outside the project, until its folder is allowed", () => {
    const ask = { title: "Allow Read?", command: "/Users/fon/Documents/tax-2026.xlsx" };
    expect(decide(ask, at("everything_in_project"))).toEqual({ answer: "blocked", reason: "outside_project" });
    const p = projectOf(allowFolder({}, root, "/Users/fon/Documents"), root);
    expect(decideAsk(readAsk(ask, { ...where, allowed: p.folders })!, ask, p, [])).toEqual({ answer: "alone" });
  });

  it("asks before a commit while the change holds a key, at every level", () => {
    const p = projectOf(setLevel({}, root, "everything_in_project"), root);
    expect(decide(run("git commit -m 'Add the QR'"), p)).toEqual({ answer: "alone" });
    expect(decide(run("git commit -m 'Add the QR'"), p, ["src/config.ts"])).toEqual({ answer: "ask", kind: "command", mayAlwaysAllow: false });
    expect(decide(run("git add -A"), p, ["src/config.ts"])).toEqual({ answer: "alone" });
  });

  it("asks before a change to git's own folder at every level", () => {
    for (const title of ["Allow Edit to change .git/config?", "Allow Write to change .git/hooks/pre-commit?", `Allow Edit to change ${root}/.git/config?`])
      expect([title, decide({ title, command: "" }, at("everything_in_project"))]).toEqual([title, { answer: "ask", kind: "command", mayAlwaysAllow: false }]);
    expect(decide({ title: "Allow Edit to change src/.gitignore?", command: "" }, at("edits_alone"))).toEqual({ answer: "alone" });
  });

  it("asks before going live at every level", () => {
    expect(decide(run("git push origin main"), at("everything_in_project"))).toEqual({ answer: "ask", kind: "command", mayAlwaysAllow: false });
  });
});
