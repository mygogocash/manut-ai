// Changes that go alone at "Edits alone" but make a program run later, or change what an agent may do (item 88,
// docs/code-editor.md "Files a change to which always asks"). A change to an agent's own settings or instructions, to a
// file a tool on the person's side runs by itself, or to package.json (whose scripts a check and Preview's Start run) is
// `unknown`: it asks at every level, Everything in this project included. Each is read by its path after `.` and `..`
// are taken out, and by name whatever its letter case, as macOS's disk finds it. A command that writes one, through a
// redirect, a move, a folder it went into first, or a link, asks too.
import { describe, expect, it } from "vitest";
import { decideAsk, readAsk, type AskWords } from "./ask";
import { readCommand, type Where } from "./command";
import { emptyProject, type KitProject } from "./project";
import type { AskTool } from "../lib/protocol";

const root = "/Users/fon/baanmali-preorder";
const where: Where = { cwd: root, root, home: "/Users/fon", branch: "kit/promptpay-qr" };
const at = (level: KitProject["level"]): KitProject => ({ ...emptyProject(), level });
const named = (tool: AskTool): AskWords => ({ title: "Allow Edit to change a file?", command: "", cwd: root, tool });
const decide = (ask: AskWords, level: KitProject["level"]) => decideAsk(readAsk(ask, where)!, at(level), []);

/** A file change asks at the dial's highest level only when it is no plain edit. */
const asksAtTop = (ask: AskWords) => decide(ask, "everything_in_project").answer === "ask";

/** [a path whose change must ask, a plain path beside it that still goes alone at Edits alone]. */
const PATHS: [string, string][] = [
  [".mcp.json", "mcp.md"],
  [".claude/settings.json", "docs/settings.json"],
  [".claude/settings.local.json", "src/settings.local.json"],
  [".claude/commands/deploy.md", "docs/commands/deploy.md"],
  [".claude/skills/qr/SKILL.md", "skills/qr/SKILL.md"],
  ["CLAUDE.md", "README.md"],
  ["CLAUDE.local.md", "NOTES.md"],
  ["apps/web/CLAUDE.md", "apps/web/README.md"],
  ["AGENTS.md", "CHANGELOG.md"],
  ["AGENTS.override.md", "CONTRIBUTING.md"],
  [".codex/config.toml", "config/app.toml"],
  [".agents/skills/qr/SKILL.md", "agents/skills/qr/SKILL.md"],
  [".cursor/rules/x.mdc", "cursor/rules/x.mdc"],
  [".cursor/mcp.json", "src/mcp.json"],
  [".cursorrules", "cursorrules.txt"],
  [".gemini/settings.json", "gemini/settings.json"],
  ["GEMINI.md", "GUIDE.md"],
  [".qwen/settings.json", "qwen/settings.json"],
  ["opencode.json", "tsconfig.json"],
  ["opencode.jsonc", "src/opencode.ts"],
  [".opencode/plugin/x.ts", "src/plugin/x.ts"],
  [".pi/settings.json", "pi/settings.json"],
  [".clinerules", "rules.md"],
  [".github/copilot-instructions.md", "docs/copilot-instructions.md"],
  [".github/workflows/ci.yml", "docs/workflows/ci.yml"],
  [".envrc", "env.example.txt"],
  [".husky/pre-commit", "scripts/pre-commit.md"],
  [".githooks/pre-push", "hooks/pre-push.md"],
  [".npmrc", "npmrc.txt"],
  [".yarnrc.yml", "yarn.config.md"],
  [".yarnrc", "yarnrc.md"],
  [".pnpmfile.cjs", "pnpmfile.md"],
  ["pnpm-workspace.yaml", "workspace.yaml"],
  ["bunfig.toml", "bun.toml"],
  [".vscode/tasks.json", "src/tasks.json"],
  [".vscode/settings.json", "settings/vscode.json"],
  [".idea/workspace.xml", "idea/workspace.xml"],
  [".devcontainer/devcontainer.json", "container/devcontainer.json"],
  ["package.json", "package-lock.md"],
  ["apps/web/package.json", "apps/web/index.ts"],
  ["Makefile", "make.md"],
  ["justfile", "just.md"],
  ["Taskfile.yml", "tasks.yml"],
  // turbo's settings can send its cache, and the key it is sent with, to a server they name (item 112)
  ["turbo.json", "turbo.md"],
  [".pre-commit-config.yaml", "pre-commit.md"],
  ["lefthook.yml", "lefthook.md"],
  [".lintstagedrc.json", "lintstaged.md"],
  [".gitmodules", "modules.md"],
  [".cargo/config.toml", "cargo/config.toml"],
  ["mise.toml", "mise.md"],
  ["shop.code-workspace", "shop.workspace.md"],
];

describe("an agent's own settings and instructions, a tool's that runs by itself, and package.json", () => {
  it("ask before any change, by every agent's file tool, at every level", () => {
    const wrong: string[] = [];
    for (const [guarded, plain] of PATHS) {
      for (const kind of ["edit", "write", "delete"] as const) {
        if (!asksAtTop(named({ kind, name: "Edit", paths: [`${root}/${guarded}`], cwd: root }))) wrong.push(`${kind} alone: ${guarded}`);
        if (!asksAtTop(named({ kind, name: "Edit", paths: [guarded], cwd: root }))) wrong.push(`${kind} alone, relative: ${guarded}`);
      }
      // by the words a shell without `tool` writes on the ask
      if (!asksAtTop({ title: `Allow Edit to change ${guarded}?`, command: "" })) wrong.push(`by words alone: ${guarded}`);
      // the plain file beside it is still an edit that goes alone at Edits alone
      const p = named({ kind: "edit", name: "Edit", paths: [`${root}/${plain}`], cwd: root });
      if (decide(p, "edits_alone").answer !== "alone") wrong.push(`plain asks: ${plain}`);
    }
    expect(wrong).toEqual([]);
    expect(PATHS.length).toBeGreaterThanOrEqual(50);
  });

  it("finds one whatever its letter case, through `.` and `..`, and from a folder inside it", () => {
    for (const p of [
      ".CLAUDE/settings.json", ".Claude/Settings.json", "PACKAGE.JSON", "Package.Json", "src/../package.json", "./.husky/pre-commit",
      "src/x/../../.vscode/tasks.json", `${root}/src/../.mcp.json`, `../baanmali-preorder/.npmrc`, ".Husky/pre-commit", "makefile",
      "GNUmakefile", ".Github/Workflows/ci.yml", "package.json.", ".envrc ", "PACKAG~1.JSO", "package.json::$DATA",
      "pacKage.json".replace("K", "k"), ".HUSKY/pre-commit",
    ])
      expect([p, asksAtTop(named({ kind: "write", name: "Write", paths: [p], cwd: root }))]).toEqual([p, true]);
    // a change Codex names from inside the agent's folder
    expect(asksAtTop(named({ kind: "edit", name: "Edit", paths: ["settings.json"], cwd: `${root}/.claude` }))).toBe(true);
    // a move that takes a file into one of them (Codex names where a move takes a file)
    expect(asksAtTop(named({ kind: "edit", name: "apply_patch", paths: [`${root}/notes.md`, `${root}/.claude/settings.json`], cwd: root }))).toBe(true);
    // a folder whose own name only looks like one is not one, and neither is the project's folder
    for (const p of ["src/claude/settings.json", "docs/package.json.md", "src/.claudex/a.ts", "src/my.vscode/a.json"]) expect([p, decide(named({ kind: "edit", name: "Edit", paths: [p], cwd: root }), "edits_alone").answer]).toEqual([p, "alone"]);
    const inside: Where = { cwd: "/Users/fon/.vscode/shop", root: "/Users/fon/.vscode/shop", home: "/Users/fon" };
    expect(decideAsk(readAsk(named({ kind: "edit", name: "Edit", paths: ["src/a.ts"], cwd: inside.cwd }), inside)!, at("edits_alone"), [])).toEqual({ answer: "alone" });
  });

  it("reads them as files, without asking", () => {
    for (const p of [".claude/settings.json", "package.json", ".github/workflows/ci.yml"])
      expect(decide(named({ kind: "read", name: "Read", paths: [p], cwd: root }), "asks_every_time")).toEqual({ answer: "alone" });
  });
});

describe("a command that changes one of them", () => {
  const action = (line: string) => readCommand(line, where).action;

  it("asks at every level, whatever way the command reaches it", () => {
    const rows: [string, string, string][] = [
      ["echo '{}' > .claude/settings.json", "echo '{}' > notes/settings.json", "change"],
      ["echo x >> .npmrc", "echo x >> notes.md", "change"],
      ["printf x >| .envrc", "printf x >| env.txt", "change"],
      ["cat a.txt <> package.json", "cat a.txt", "read"],
      ["tee .husky/pre-commit < hook.sh", "tee notes.md < hook.sh", "change"],
      ["cp hook.sh .husky/pre-commit", "cp hook.sh scripts/hook.sh", "change"],
      ["mv x.json .vscode/tasks.json", "mv x.json src/tasks.json", "change"],
      ["mv tmp .claude", "mv tmp build", "change"],
      ["git mv x.json package.json", "git mv x.json src/x.json", "change"],
      ["sed -i '' 's/a/b/' package.json", "sed -i '' 's/a/b/' src/a.ts", "change"],
      ["cd .husky && echo x > pre-commit", "cd src && echo x > a.txt", "change"],
      ["cd .claude && cp ../x.json settings.json", "cd src && cp ../x.json y.json", "change"],
      ["touch .envrc", "touch src/new.ts", "change"],
      ["mkdir -p .github/workflows", "mkdir -p src/qr", "change"],
      ["install -m 755 x .githooks/pre-commit", "install -m 755 x bin/x", "change"],
      ["sort -o.npmrc a.txt", "sort a.txt", "read"],
      ["rm -rf .claude", "rm -rf build", "delete"],
      ["rm .claude/settings.local.json", "rm src/old.ts", "delete"],
      ["git checkout -- package.json", "git checkout -- src/a.ts", "delete"],
      ["git restore .mcp.json", "git restore src/a.ts", "delete"],
      ["git add .claude/settings.json", "git add src/a.ts", "change"],
      ["dos2unix Makefile", "dos2unix src/a.ts", "change"],
      ["truncate -s 0 .yarnrc.yml", "truncate -s 0 log.txt", "change"],
      ["gunzip package.json.gz", "gunzip data.json.gz", "change"],
      ["echo x > ./src/../.PNPMFILE.cjs", "echo x > ./src/../notes.txt", "change"],
    ];
    const wrong: string[] = [];
    for (const [hostile, plain, as] of rows) {
      if (action(hostile) !== "unknown") wrong.push(`${action(hostile)}: ${hostile}`);
      if (action(plain) !== as) wrong.push(`plain read as ${action(plain)}: ${plain}`);
    }
    expect(wrong).toEqual([]);
  });

  it("asks before making a link, which can make a later change land somewhere its path does not say", () => {
    for (const line of ["ln -s .claude/settings.json notes.json", "ln -s ~ home", "ln -s ../.. up", "ln x.json y.json", "cp -s .npmrc x", "cp -l package.json pkg.json", "cp --symbolic-link a b"])
      expect([line, action(line)]).toEqual([line, "unknown"]);
    expect(action("cp a.txt b.txt")).toBe("change");
  });

  it("asks before unpacking or applying what names its own files", () => {
    for (const line of ["tar -xf a.tar", "tar xzf a.tgz", "tar --extract -f a.tar", "unzip a.zip", "unzip -o a.zip -d src", "patch -p1 < fix.patch", "git apply fix.patch", "git am 0001.patch", "git clean -fdx", "git clean -fX"])
      expect([line, action(line)]).toEqual([line, "unknown"]);
    for (const [line, as] of [["tar -czf a.tgz src", "change"], ["tar -cf a.tar src", "change"], ["git clean -fd", "delete"]] as const) expect([line, action(line)]).toEqual([line, as]);
  });

  it("still reads them without asking", () => {
    for (const line of ["cat .claude/settings.json", "cat package.json", "git diff package.json", "git log -p .github/workflows/ci.yml", "ls .husky", "jq .scripts package.json"])
      expect([line, action(line)]).toEqual([line, "read"]);
  });
});

describe("the app's own storage", () => {
  const home = "/Users/fon";
  const lane = `${home}/.manut/lanes/baanmali-preorder/promptpay-qr`;
  const inLane: Where = { cwd: lane, root: lane, home };
  const read = (w: Where, paths: string[], cwd = w.cwd) => readAsk(named({ kind: "write", name: "Write", paths, cwd }), w)!;
  /** Asked at every level: read as `unknown`, and never taken alone, at Everything in this project either. */
  const asks = (w: Where, p: string, cwd?: string) => {
    const r = read(w, [p], cwd);
    return r.action === "unknown" && decideAsk(r, at("everything_in_project"), []).answer !== "alone";
  };

  it("asks before any change in it, from a lane, from the home folder, or from a project inside it", () => {
    const wrong: string[] = [];
    const cases: [Where, string][] = [
      [inLane, `${home}/.manut/workflows/x.json`],
      [inLane, `${home}/.manut/lanes/baanmali-preorder/other-lane/src/a.ts`],
      [inLane, "../other-lane/src/a.ts"],
      [inLane, `${home}/.manut/lanes/baanmali-preorder/promptpay-qr.json`],
      [inLane, `${home}/.manut/lanes/.no-hooks`],
      [inLane, "~/.manut/providers.json"],
      [inLane, "~/.manut/custom-agents.json.tmp"],
      [inLane, `${home}/.MANUT/Workflows/x.json`],
      [inLane, `${home}/.Manut/lanes/baanmali-preorder/promptpay-qr/src/a.ts`],
      [inLane, `${lane}/../../../peers.json`],
      [inLane, `${home}/Library/WebKit/xyz.manut.desktop/WebsiteData/x`],
      [inLane, `${home}/Library/Caches/XYZ.Manut.Desktop/x`],
      [{ cwd: home, root: home, home }, ".manut/workflows/x.json"],
      [{ cwd: home, root: home, home }, ".manut/computer/x.json"],
      [{ cwd: home, root: home, home }, "Library/Caches/xyz.manut.desktop/x"],
      [{ cwd: `${home}/.manut`, root: `${home}/.manut`, home }, "workflows/x.json"],
      [{ cwd: `${home}/.manut`, root: `${home}/.manut`, home }, "buddy/chat/a.md"],
      // a folder above the lane is the app's, not the session's own
      [{ cwd: `${home}/.manut/lanes/baanmali-preorder`, root: `${home}/.manut/lanes/baanmali-preorder`, home }, "promptpay-qr/src/a.ts"],
      // the home folder not known: `~` cannot be placed, and is the app's all the same
      [{ cwd: lane, root: lane }, "~/.manut/workflows/x.json"],
    ];
    for (const [w, p] of cases) if (!asks(w, p)) wrong.push(`${w.root}: ${p}`);
    expect(wrong).toEqual([]);
    // a command that writes there, by a redirect, a copy, or from a folder it went into first
    for (const line of ["echo '{}' > ~/.manut/workflows/x.json", "cp x.json ~/.manut/workflows/", "cd ../other-lane && touch a.ts", "ln -s ~/.manut/workflows wf"])
      expect([line, readCommand(line, inLane).action]).toEqual([line, "unknown"]);
  });

  it("lets the lane change its own folder as any project's", () => {
    for (const p of ["src/a.ts", `${lane}/src/checkout.tsx`, "./docs/notes.md"]) expect([p, decideAsk(read(inLane, [p]), at("edits_alone"), [])]).toEqual([p, { answer: "alone" }]);
    expect(readCommand("echo x > src/a.txt", inLane).action).toBe("change");
    expect(readCommand("cat ~/.manut/lanes/baanmali-preorder/promptpay-qr.json", inLane).action).toBe("read");
  });
});
