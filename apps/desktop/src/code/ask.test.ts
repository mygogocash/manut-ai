// An ask a coding session raised, read as one of Kit's steps, then decided by Kit's dial for the project: first by
// what the shell names from the agent's own message (`tool`, src-tauri/src/ask_tool.rs), and an ask without it by the
// words the shell writes on it (agent_chat.rs and acp_chat.rs). The project is the canvas's baanmali-preorder.
import { describe, expect, it } from "vitest";
import { decideAsk, readAsk, type AskWords } from "./ask";
import { addRule, allowFolder, emptyProject, projectOf, setLevel, type KitProject } from "./project";
import type { Where } from "./command";
import type { AskTool } from "../lib/protocol";
import replays from "../state/__fixtures__/real-agent-replay.json";

const root = "/Users/fon/baanmali-preorder";
const where: Where = { cwd: root, root, home: "/Users/fon", branch: "kit/promptpay-qr" };
const run = (command: string) => ({ title: "Run this command?", command, cwd: root });
const at = (level: KitProject["level"]): KitProject => ({ ...emptyProject(), level });

/** An ask as the shell sends it now: its card's words for the person, and what the agent asked (`tool`). */
const named = (tool: AskTool, title = "Run this command?", command = ""): AskWords => ({ title, command, cwd: root, tool });
/** A command as Claude Code asks it: the card's command is the line made one line, as the shell's `clip` makes it. */
const cmd = (line: string, extra: Partial<AskTool> = {}): AskWords => named({ kind: "command", name: "Bash", line, cwd: root, ...extra }, "Run this command?", line.split(/\s+/).join(" "));
const decide = (ask: AskWords, project: KitProject, keys: string[] = []) => decideAsk(readAsk(ask, where)!, project, keys);

describe("reading an ask by what the shell names", () => {
  it("reads a command's whole line, whatever its title says", () => {
    expect(readAsk(cmd("pnpm add qrcode"), where)).toMatchObject({ what: "command", action: "install", outside: [], rule: { words: ["pnpm", "add"] }, line: "pnpm add qrcode", say: { key: "kit.say.add1" } });
    // Codex's reason is the title; the line is what runs
    expect(readAsk(named({ kind: "command", line: "pnpm install", cwd: root }, "Install the packages the QR code needs", "pnpm install"), where)).toMatchObject({ what: "command", action: "install" });
  });

  it("reads a command written on two lines as both, not as the one line its card shows", () => {
    const ask = cmd("pnpm test\ngit push origin main");
    expect(ask.command).toBe("pnpm test git push origin main");
    expect(readAsk(ask, where)).toMatchObject({ what: "command", action: "live" });
    expect(decide(ask, at("everything_in_project"))).toEqual({ answer: "ask", kind: "command", mayAlwaysAllow: false });
    // read by its card's words alone, the same ask is the tests, which run alone at every level
    expect(decide({ ...ask, tool: undefined }, at("asks_every_time"))).toEqual({ answer: "alone" });
  });

  it("matches a kept rule against the whole line", () => {
    const p = projectOf(addRule({}, root, { words: ["pnpm", "add"] }), root);
    const ask = cmd("pnpm add dayjs\nrm -rf src");
    expect(decide(ask, p)).toMatchObject({ answer: "ask" });
    expect(decide(cmd("pnpm add dayjs"), p)).toEqual({ answer: "alone" });
    // by its card's words it is one `pnpm add`, which the rule covers
    expect(decide({ ...ask, tool: undefined }, p)).toEqual({ answer: "alone" });
  });

  it("reads a command in the folder the agent names for it", () => {
    expect(readAsk(cmd("rm -rf build", { cwd: `${root}/packages/web` }), where)).toMatchObject({ action: "delete", outside: [] });
    expect(readAsk(cmd("rm -rf build", { cwd: "/Users/fon/other" }), where)).toMatchObject({ outside: ["/Users/fon/other"], folder: "/Users/fon/other" });
  });

  it("checks the path the agent found a command reaching, beside its line", () => {
    // Claude Code's shell had moved with an earlier `cd`: the line names a file here, Claude Code found it elsewhere
    const ask = cmd("echo hi > notes.txt", { paths: ["/Users/fon/elsewhere/notes.txt"] });
    expect(readAsk(ask, where)).toMatchObject({ what: "command", outside: ["/Users/fon/elsewhere/notes.txt"], folder: "/Users/fon/elsewhere", rule: null });
    expect(decide(ask, at("everything_in_project"))).toEqual({ answer: "blocked", reason: "outside_project" });
    // a read of a folder Kit may read is not blocked; a change there is
    const p = projectOf(allowFolder({}, root, "/Users/fon/Documents"), root);
    const allowed = { ...where, allowed: p.folders };
    expect(decideAsk(readAsk(cmd("cat tax.xlsx", { paths: ["/Users/fon/Documents/tax.xlsx"] }), allowed)!, p, [])).toEqual({ answer: "alone" });
    expect(decideAsk(readAsk(cmd("touch tax.xlsx", { paths: ["/Users/fon/Documents/tax.xlsx"] }), allowed)!, p, [])).toEqual({ answer: "blocked", reason: "outside_project" });
  });

  it("reads a file change by every path it names, where the title cut its list short", () => {
    const paths = [...Array.from({ length: 12 }, (_, i) => `${root}/src/f${i}.ts`), "/Users/fon/elsewhere/z.ts"];
    const ask = named({ kind: "edit", paths, cwd: root }, "Allow Codex to change src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, src/f4.ts, src/f5.ts, src/f6.ts, s…?");
    expect(readAsk(ask, where)).toMatchObject({ what: "edit", action: "edit", outside: ["/Users/fon/elsewhere/z.ts"], folder: "/Users/fon/elsewhere" });
    expect(decide(ask, at("everything_in_project"))).toEqual({ answer: "blocked", reason: "outside_project" });
    // by the title alone the cut list is not read at all
    expect(readAsk({ ...ask, tool: undefined }, where)).toBeNull();
  });

  it("says a change's files as the project names them, a long list cut after a whole name", () => {
    expect(readAsk(named({ kind: "edit", name: "Edit", paths: [`${root}/src/checkout.tsx`], cwd: root }, "Allow Edit to change src/checkout.tsx?"), where)).toMatchObject({ say: { key: "kit.say.edit", vars: { path: "src/checkout.tsx" } } });
    expect(readAsk(named({ kind: "write", name: "write", paths: ["notes.txt"], cwd: root }), where)).toMatchObject({ what: "edit", action: "edit", outside: [], say: { vars: { path: "notes.txt" } } });
    const many = Array.from({ length: 9 }, (_, i) => `${root}/src/components/checkout/part-${i}.tsx`);
    const said = String(readAsk(named({ kind: "edit", paths: many, cwd: root }), where)?.say.vars?.path);
    expect(said.startsWith("src/components/checkout/part-0.tsx, src/components/checkout/part-1.tsx")).toBe(true);
    expect(said.endsWith(", …")).toBe(true);
    expect(said.length).toBeLessThanOrEqual(163);
  });

  it("reads a delete as one, and a delete of the whole project as unknown", () => {
    const del = named({ kind: "delete", paths: [`${root}/src/old.ts`], cwd: root }, "Allow Codex to change src/old.ts?");
    expect(readAsk(del, where)).toMatchObject({ what: "edit", action: "delete", outside: [], say: { key: "kit.say.delete" } });
    expect(decide(del, at("edits_alone"))).toMatchObject({ answer: "ask", mayAlwaysAllow: true });
    expect(decide(del, at("everything_in_project"))).toEqual({ answer: "alone" });
    expect(readAsk(named({ kind: "delete", paths: [root], cwd: root }), where)).toMatchObject({ action: "unknown", say: { key: "kit.say.wipe" } });
    expect(readAsk(named({ kind: "delete", paths: ["/Users/fon"], cwd: root }), where)).toMatchObject({ action: "unknown", outside: ["/Users/fon"] });
  });

  it("reads a file read by its path, and the folder allowing it would add", () => {
    const ask = named({ kind: "read", name: "Read", paths: ["/Users/fon/Documents/tax-2026.xlsx"], cwd: root }, "Allow Read?", "/Users/fon/Documents/tax-2026.xlsx");
    expect(readAsk(ask, where)).toMatchObject({
      what: "read",
      action: "read",
      outside: ["/Users/fon/Documents/tax-2026.xlsx"],
      folder: "/Users/fon/Documents",
      say: { key: "kit.say.readFile", vars: { path: "/Users/fon/Documents/tax-2026.xlsx" } },
    });
    expect(decide(ask, at("everything_in_project"))).toEqual({ answer: "blocked", reason: "outside_project" });
    const p = projectOf(allowFolder({}, root, "/Users/fon/Documents"), root);
    expect(decideAsk(readAsk(ask, { ...where, allowed: p.folders })!, p, [])).toEqual({ answer: "alone" });
    // a path from the root needs no folder to be read
    expect(readAsk({ title: "", command: "", tool: { kind: "read", paths: [`${root}/README.md`] } }, where)).toMatchObject({ what: "read", outside: [] });
  });

  it("asks before a change in git's own folder at every level", () => {
    for (const kind of ["edit", "write", "delete"] as const)
      expect(decide(named({ kind, paths: [`${root}/.git/hooks/pre-commit`], cwd: root }), at("everything_in_project"))).toEqual({ answer: "ask", kind: "command", mayAlwaysAllow: false });
    expect(decide(named({ kind: "read", paths: [`${root}/.git/config`], cwd: root }), at("asks_every_time"))).toEqual({ answer: "alone" });
  });

  it("asks the person when a part it needs is left out, and never reads the title instead", () => {
    const words = { title: "Run this command?", command: "pnpm test", cwd: root };
    const broken: unknown[] = [
      { kind: "command", name: "Bash", cwd: root },
      { kind: "command", line: "pnpm test" },
      { kind: "command", line: 3, cwd: root },
      { kind: "edit", cwd: root },
      { kind: "edit", paths: [], cwd: root },
      { kind: "edit", paths: "src/a.ts", cwd: root },
      { kind: "edit", paths: ["src/a.ts", 3], cwd: root },
      { kind: "read", paths: ["notes.txt"] },
      { kind: "command", line: "pnpm test", paths: "x", cwd: root },
      { kind: "fetch", name: "WebFetch", cwd: root },
      { kind: "other", name: "mcp__shop__orders", cwd: root },
      { kind: "search", cwd: root },
      { line: "pnpm test", cwd: root },
      null,
      "Bash",
      [],
    ];
    for (const tool of broken) expect([tool, readAsk({ ...words, tool: tool as AskTool }, where)]).toEqual([tool, null]);
    // the same words with no `tool` at all are read as before
    expect(readAsk(words, where)).toMatchObject({ what: "command", action: "check" });
    // a plan is left to the person either way
    expect(readAsk({ ...named({ kind: "other", name: "ExitPlanMode", cwd: root }), plan: "1. Do it" }, where)).toBeNull();
  });
});

describe("the shell's real asks", () => {
  // Every ask in the agents' recorded streams, as the shell's adapters sent it (real-agent-replay.json, written by
  // agent_chat.rs's `real_streams_end_their_turns_and_say_nothing_outside_one`), in their /w/proj.
  const asks = (replays as { name: string; events: Record<string, unknown>[] }[]).flatMap((r) =>
    r.events.filter((e) => e.event === "approval.request").map((e) => ({ name: r.name, ask: e as unknown as AskWords })),
  );
  const inProj: Where = { cwd: "/w/proj", root: "/w/proj", home: "/w" };
  const gist = (r: ReturnType<typeof readAsk>) => r && { what: r.what, action: r.action, outside: r.outside, say: r.say };

  it("each names what it is", () => {
    expect(asks.length).toBeGreaterThanOrEqual(28);
    for (const { name, ask } of asks) expect([name, typeof ask.tool?.kind]).toEqual([name, "string"]);
  });

  it("each reads as its words read it, wherever the words read it whole", () => {
    let both = 0;
    for (const { name, ask } of asks) {
      const byWords = readAsk({ ...ask, tool: undefined }, inProj);
      if (!byWords) continue;
      both++;
      expect([name, ask.title, gist(readAsk(ask, inProj))]).toEqual([name, ask.title, gist(byWords)]);
    }
    expect(both).toBeGreaterThanOrEqual(20);
  });
});

describe("reading an ask by its words, when the shell names nothing", () => {
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
    expect(decideAsk(readAsk(ask, { ...where, allowed: p.folders })!, p, [])).toEqual({ answer: "alone" });
  });

  it("asks before a commit while the change holds a key, at every level", () => {
    const p = projectOf(setLevel({}, root, "everything_in_project"), root);
    expect(decide(run("git commit -m 'Add the QR'"), p)).toEqual({ answer: "alone" });
    expect(decide(run("git commit -m 'Add the QR'"), p, ["src/config.ts"])).toEqual({ answer: "ask", kind: "command", mayAlwaysAllow: false });
    expect(decide(run("git add -A"), p, ["src/config.ts"])).toEqual({ answer: "alone" });
  });

  it("asks before a change to git's own folder at every level", () => {
    for (const title of ["Allow Edit to change .git/config?", "Allow Write to change .git/hooks/pre-commit?", `Allow Edit to change ${root}/.git/config?`, "Allow Edit to change .GIT/config?", "Allow Write to change .Git/hooks/pre-push?"])
      expect([title, decide({ title, command: "" }, at("everything_in_project"))]).toEqual([title, { answer: "ask", kind: "command", mayAlwaysAllow: false }]);
    expect(decide({ title: "Allow Edit to change src/.gitignore?", command: "" }, at("edits_alone"))).toEqual({ answer: "alone" });
  });

  it("asks before going live at every level", () => {
    expect(decide(run("git push origin main"), at("everything_in_project"))).toEqual({ answer: "ask", kind: "command", mayAlwaysAllow: false });
  });
});
