import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { COMMAND_MAX, MIN_AGE_MS, commandLabel, commandText, evalCommand, inProject, listed, portsText, ranFor, rowKey, runFor, type RunningRow } from "./model";

const row = (o: Partial<RunningRow> = {}): RunningRow => ({ kind: "pty", session: 1, folder: "/home/you/code/baanmali-preorder", pid: 100, started: 1_000_000, argv: ["sleep", "30"], ports: [], ...o });

/** What Claude Code's Bash tool runs a command as, read from a live process list (a snapshot file, three settings,
 *  then `eval` of the command in single quotes, `< /dev/null`, and a file that keeps the folder it ended in). */
const claude = (command: string) =>
  `source /Users/you/.claude/shell-snapshots/snapshot-zsh-1795491096676-oqlsw4.sh 2>/dev/null || true && \\builtin setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL NO_BRACE_CCL NO_MAGIC_EQUAL_SUBST NO_EQUALS 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && eval '${command.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-b87f-cwd`;

describe("the command a row names", () => {
  it("is a program's own name and its arguments, not its path", () => {
    expect(commandText(["/usr/local/bin/vite", "--port", "3000"])).toBe("vite --port 3000");
    expect(commandText(["sleep", "30"])).toBe("sleep 30");
    // a login shell's argv[0] starts with a dash
    expect(commandText(["-zsh"])).toBe("zsh");
    expect(commandText([])).toBe("");
  });

  it("names a node script by its package, as the person typed it", () => {
    expect(commandText(["node", "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs", "dev"])).toBe("pnpm dev");
    expect(commandText(["/usr/local/bin/node", "/code/app/node_modules/.bin/vite", "--host"])).toBe("vite --host");
    expect(commandText(["node", "/code/app/node_modules/vite/bin/vite.js", "--port", "3000"])).toBe("vite --port 3000");
    expect(commandText(["node", "/code/app/node_modules/@angular/cli/bin/ng.js", "serve"])).toBe("@angular/cli serve");
    expect(commandText(["node", "/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js", "vitest"])).toBe("npx vitest");
    expect(commandText(["node", "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js", "run", "dev"])).toBe("npm run dev");
  });

  it("keeps the interpreter for a script of the project's own, and for a module run", () => {
    expect(commandText(["node", "/code/app/server.js", "--port", "3000"])).toBe("node server.js --port 3000");
    expect(commandText(["/usr/bin/python3", "/code/app/manage.py", "runserver"])).toBe("python3 manage.py runserver");
    expect(commandText(["python3", "-m", "http.server", "8000"])).toBe("python3 -m http.server 8000");
    expect(commandText(["bash", "/code/app/build.sh", "--fast"])).toBe("bash build.sh --fast");
    // node's own options come before the script
    expect(commandText(["node", "--max-old-space-size=4096", "/code/app/server.js"])).toBe("node server.js");
  });

  it("quotes an argument that holds a space, so it reads as one", () => {
    expect(commandText(["/usr/bin/open", "-a", "Visual Studio Code"])).toBe('open -a "Visual Studio Code"');
  });

  it("escapes a quote and a backslash inside a quoted argument, so where it ends is never in doubt", () => {
    expect(commandText(["/usr/bin/grep", 'say "hi"', "a b\\"])).toBe('grep "say \\"hi\\"" "a b\\\\"');
    // an argument without a space is shown as it is, backslash and all
    expect(commandText(["/usr/bin/grep", "a\\b"])).toBe("grep a\\b");
  });

  it("is the script of a shell's -c, in any spelling of the flag", () => {
    expect(commandText(["/bin/zsh", "-lc", "pnpm dev"])).toBe("pnpm dev");
    expect(commandText(["bash", "-c", "npm run dev"])).toBe("npm run dev");
    expect(commandText(["/bin/sh", "-ic", "tail -f log"])).toBe("tail -f log");
    // lines run together, so a row stays one line
    expect(commandText(["/bin/sh", "-c", "echo hi\nsleep 5"])).toBe("echo hi sleep 5");
    // the words after the script are the shell's own $0 and $1, not the command
    expect(commandText(["/bin/sh", "-c", "sleep $1", "name", "30"])).toBe("sleep $1");
  });

  it("is the command inside Claude Code's wrapper, not the wrapper", () => {
    expect(commandText(["/bin/zsh", "-c", claude("pnpm dev")])).toBe("pnpm dev");
    expect(commandText(["/bin/zsh", "-c", claude("pnpm test --filter @manut/desktop && echo done")])).toBe("pnpm test --filter @manut/desktop && echo done");
    // a quote inside the command comes through as the person wrote it
    expect(commandText(["/bin/zsh", "-c", claude("echo 'hi' && sleep 30")])).toBe("echo 'hi' && sleep 30");
  });
});

describe("evalCommand", () => {
  it("reads the quoted word after eval, with a quote spelled '\"'\"'", () => {
    expect(evalCommand("a && eval 'pnpm dev' < /dev/null")).toBe("pnpm dev");
    expect(evalCommand(`a && eval 'say '"'"'hi'"'"'' < /dev/null`)).toBe("say 'hi'");
    expect(evalCommand("eval 'a b'")).toBe("a b");
  });

  it("reads only the first eval, which is the wrapper's, and leaves any other text alone", () => {
    // the word eval inside the command is part of the command
    expect(evalCommand("a && eval 'echo eval done' < /dev/null")).toBe("echo eval done");
    expect(evalCommand("a && eval 'x' && eval 'y'")).toBe("x");
    expect(evalCommand("pnpm dev")).toBeNull();
    expect(evalCommand("evaluate 'x'")).toBeNull();
    // a word that is not quoted, and a quote that never closes, are not read
    expect(evalCommand("eval pnpm dev")).toBeNull();
    expect(evalCommand("eval 'pnpm dev")).toBeNull();
    expect(evalCommand("eval ''")).toBeNull();
  });
});

describe("the words shown", () => {
  it("hides a key in the command, as the cards do", () => {
    const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const shown = commandLabel(["node", "/code/app/server.js", `--token=${key}`]);
    expect(shown).not.toContain("ghp_");
    expect(shown).toContain("••••");
    expect(shown.startsWith("node server.js")).toBe(true);
    // a key set the way a shell sets it for one command
    expect(commandLabel(["/bin/sh", "-c", "API_KEY=abc123xyz node server.js"])).toBe("API_KEY=•••• node server.js");
    // and a key inside Claude Code's wrapper
    expect(commandLabel(["/bin/zsh", "-c", claude(`curl -H "x: 1" https://x.test/?token=sekret99`)])).toBe(`curl -H "x: 1" https://x.test/?token=••••`);
  });

  it("hides a key before it cuts a long command, so a cut never leaves half of one", () => {
    const key = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    // the key starts 12 characters before the limit: `ghp_` and seven more of its characters would be left by a cut
    // first, one short of the eight the masker needs to know a key, so they would show
    const long = `${"x".repeat(COMMAND_MAX - 12)} ${key}`;
    expect(long.slice(0, COMMAND_MAX).endsWith("ghp_A1b2C3d")).toBe(true);
    const shown = commandLabel(["/bin/sh", "-c", long]);
    expect(shown).not.toMatch(/ghp_|A1b2C3/);
    expect(shown.endsWith("••••")).toBe(true);
  });

  it("cuts a long command with an ellipsis, inside the limit", () => {
    const shown = commandLabel(["/bin/sh", "-c", "echo " + "a".repeat(COMMAND_MAX * 2)]);
    expect([...shown].length).toBe(COMMAND_MAX);
    expect(shown.endsWith("…")).toBe(true);
    expect(commandLabel(["sleep", "30"])).toBe("sleep 30");
  });
});

describe("how long it has run", () => {
  afterEach(() => setLang("en"));

  it("counts from the system's own start time, else from when the page first saw it", () => {
    const now = 2_000_000;
    expect(ranFor(row({ started: 1_940_000 }), now, new Map())).toBe(60_000);
    expect(ranFor(row({ started: null, pid: 7 }), now, new Map([[rowKey(row({ started: null, pid: 7 })), 1_990_000]]))).toBe(10_000);
    expect(ranFor(row({ started: null }), now, new Map())).toBeNull();
    // a clock a little behind the system's is no negative time
    expect(ranFor(row({ started: 2_000_500 }), now, new Map())).toBe(0);
  });

  it("is seconds under a minute, then the app's own minutes, hours and days", () => {
    expect(runFor(38_000)).toBe("38s");
    expect(runFor(61_000)).toBe("1m");
    expect(runFor(42 * 60_000)).toBe("42m");
    expect(runFor(107 * 60_000)).toBe("1h 47m");
    expect(runFor((4 * 24 + 23) * 3_600_000)).toBe("4d 23h");
    setLang("ko");
    expect(runFor(42 * 60_000)).toBe("42분");
  });
});

describe("the port a command listens on", () => {
  afterEach(() => setLang("en"));

  it("names one port, several, and counts the rest", () => {
    expect(portsText([3000])).toBe("port 3000");
    expect(portsText([3000, 3001])).toBe("ports 3000, 3001");
    expect(portsText([3000, 3001, 3002, 3003, 3004])).toBe("ports 3000, 3001, 3002 +2");
    expect(portsText([])).toBe("");
    setLang("ja");
    expect(portsText([3000])).toBe("ポート 3000");
  });
});

describe("what is listed", () => {
  const now = 1_000_000;

  it("lists a command once it has run a few seconds, so a quick one never flickers in", () => {
    const young = row({ pid: 1, started: now - (MIN_AGE_MS - 1) });
    const old = row({ pid: 2, started: now - MIN_AGE_MS });
    expect(listed([young, old], now, new Map()).map((r) => r.pid)).toEqual([2]);
  });

  it("lists the oldest first, and keeps that order as it runs", () => {
    const a = row({ pid: 30, started: now - 60_000 });
    const b = row({ pid: 20, started: now - 600_000 });
    const c = row({ pid: 10, started: now - 600_000 });
    expect(listed([a, b, c], now, new Map()).map((r) => r.pid)).toEqual([10, 20, 30]);
  });

  it("lists a command whose start the system would not say from when the page first saw it", () => {
    const unknown = row({ pid: 5, started: null });
    expect(listed([unknown], now, new Map())).toEqual([]);
    expect(listed([unknown], now, new Map([[rowKey(unknown), now - 6_000]])).map((r) => r.pid)).toEqual([5]);
    expect(listed([unknown], now, new Map([[rowKey(unknown), now - 1_000]]))).toEqual([]);
  });

  it("tells one command from another run later under the same process number", () => {
    expect(rowKey(row({ pid: 9, started: 1 }))).not.toBe(rowKey(row({ pid: 9, started: 2 })));
    expect(rowKey(row({ pid: 9, session: 1 }))).not.toBe(rowKey(row({ pid: 9, session: 2 })));
    expect(rowKey(row({ pid: 9, kind: "pty" }))).not.toBe(rowKey(row({ pid: 9, kind: "chat" })));
  });

  it("keeps the project's own commands, comparing folders as the Code page does", () => {
    const mine = row({ pid: 1, folder: "/home/you/code/baanmali-preorder/" });
    const other = row({ pid: 2, folder: "/home/you/code/other" });
    const inside = row({ pid: 3, folder: "/home/you/code/baanmali-preorder/apps/web" });
    expect(inProject([mine, other, inside], "/home/you/code//baanmali-preorder").map((r) => r.pid)).toEqual([1]);
    expect(inProject([mine, other], undefined).map((r) => r.pid)).toEqual([1, 2]);
  });

  it("keeps a lane's commands with its project, though they run in the lane's own folder", () => {
    const lane = row({ pid: 4, session: 7, folder: "/home/you/.manut/lanes/baanmali-preorder/promptpay-qr" });
    const mine = row({ pid: 1, folder: "/home/you/code/baanmali-preorder" });
    // the session's own folder, as the page knows it
    const projectOf = (r: RunningRow) => (r.session === 7 ? "/home/you/code/baanmali-preorder" : r.folder);
    expect(inProject([mine, lane], "/home/you/code/baanmali-preorder", projectOf).map((r) => r.pid)).toEqual([1, 4]);
    expect(inProject([mine, lane], "/home/you/code/baanmali-preorder").map((r) => r.pid)).toEqual([1]);
  });
});
