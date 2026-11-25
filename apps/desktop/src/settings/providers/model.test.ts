// Settings › Providers' pure half (item 74): the page's first check is the shell's (the same table, argRules.json, which
// a Rust test holds equal to providers.rs), the patch never carries a saved variable's value back, and every refusal reads
// as words that name the option or the variable, never a value.
import { afterEach, describe, expect, it } from "vitest";
import { LANGS, setLang, t } from "../../i18n";
import { argLines, checkArgs, checkForm, checkVars, errorText, formOf, optionOf, patchOf, refusalOf, refusalText, statusLine, type ProviderView } from "./model";
import { planName } from "../accounts/rules";

const view = (over: Partial<ProviderView> = {}): ProviderView => ({
  id: "claude",
  label: "Claude Code",
  kind: "main",
  mode: "chat",
  off: false,
  name: "",
  found: "/Users/k/.local/bin/claude",
  path: "",
  path_ok: true,
  home_var: "CLAUDE_CONFIG_DIR",
  home: "",
  args: [],
  env: [],
  takes_path: true,
  takes_args: true,
  takes_vars: true,
  version: true,
  signin: true,
  chat: "/Users/k/.local/bin/claude -p",
  terminal: "/Users/k/.local/bin/claude",
  ...over,
});

afterEach(() => setLang("en"));

describe("the page's own check of extra arguments (the shell's, run sooner)", () => {
  it("takes only --name, --name=value, -x and -x=value, one per line, never split on spaces", () => {
    expect(argLines("--model=opus\n\n--name=two words\r\n")).toEqual(["--model=opus", "--name=two words"]);
    for (const ok of ["--model=opus", "--model", "-n", "-n=work", "--effort=high"]) expect(checkArgs("claude", [ok]), ok).toBeNull();
    for (const bad of ["opus", "mcp", "--", "-", "-abc", "-mopus", "---x", "--=x", " --model=x"]) expect(checkArgs("claude", [bad])?.why, bad).toBe("arg_shape");
    expect(optionOf("--model=a=b")).toEqual(["model", true]);
    expect(optionOf("-c=k=v")).toEqual(["c", false]);
  });

  it("refuses by name what would skip the asks or the sandbox, as each CLI's help spells it", () => {
    const skips: [string, string[]][] = [
      ["claude", ["--dangerously-skip-permissions", "--permission-mode=bypassPermissions", "--allowedTools=Bash", "--allowed-tools=Edit", "--settings={}", "--add-dir=/", "--DANGEROUSLY_SKIP_PERMISSIONS"]],
      ["codex", ["--dangerously-bypass-approvals-and-sandbox", "-a=never", "--sandbox=danger-full-access", "-s=danger-full-access", "--approve-for-me", "--search", "-c=approval_policy=\"never\"", "--config=sandbox_mode=\"x\"", "-c"]],
      ["gemini", ["-y", "--yolo", "--approval-mode=yolo", "--no-sandbox", "--skip-trust"]],
      ["cursor-agent", ["-f", "--force", "--yolo", "--sandbox=disabled", "--approve-mcps", "--trust"]],
      ["agy", ["--dangerously-skip-permissions", "--mode=auto", "--settings={}"]],
      ["grok", ["--always-approve", "--permission-mode=dontAsk"]],
      ["omp", ["--auto-approve", "--approval-mode=yolo"]],
      ["opencode", ["--auto"]],
    ];
    for (const [id, args] of skips) {
      for (const a of args) {
        const r = checkArgs(id, [a]);
        expect(r?.why, `${id} ${a}`).toBe("arg_skips");
        expect(r?.what.includes("="), `${id} ${a}`).toBe(false);
      }
    }
    // the app's own options: the chat mode, where the asks go, the conversation
    for (const a of ["-p", "--input-format=text", "--permission-prompt-tool=x", "--resume=x", "--continue"]) expect(checkArgs("claude", [a])?.why, a).toBe("arg_own");
    expect(checkArgs("gemini", ["--acp"])?.why).toBe("arg_own");
    // a key in an argument is refused, and the refusal does not carry it
    expect(checkArgs("cursor-agent", ["--api-key=sk-123"])).toEqual({ why: "arg_own", what: "--api-key" });
    // an agent whose options were not read takes none
    expect(checkArgs("pi", ["--model=x"])?.why).toBe("arg_unchecked");
    expect(checkArgs("codex", ["-c=model=\"o3\"", "-m=o3"])).toBeNull();
  });

  it("refuses every spelling the CLI's parser takes, and takes only options known to be harmless", () => {
    // yargs (Gemini CLI) reads camelCase and a dot's object form; Codex takes --yolo, which its help does not print
    const other: [string, string[]][] = [
      ["gemini", ["--approvalMode=yolo", "--skipTrust", "--includeDirectories=/", "--allowedTools=x", "--sandbox.enabled=false", "--s=false", "--noSandbox"]],
      ["codex", ["--yolo", "--full-auto", "--not-so-yolo", "--enable=x", "-c=features.x=true"]],
      ["claude", ["--permissionMode=bypassPermissions", "--addDir=/"]],
    ];
    for (const [id, args] of other) for (const a of args) expect(checkArgs(id, [a])?.why, `${id} ${a}`).toBe("arg_skips");
    // the rule turned round: an option on no list is refused, naming the option only
    expect(checkArgs("claude", ["--agent=reviewer"])).toEqual({ why: "arg_unlisted", what: "--agent" });
    expect(checkArgs("codex", ["-c=model_providers.x.base_url=\"https://x\""])).toEqual({ why: "arg_unlisted", what: "-c" });
    expect(checkArgs("gemini", ["--screenReader", "-m=x"])).toBeNull();
    expect(checkArgs("claude", ["--model.x=1"])?.why).toBe("arg_unlisted");
    setLang("en");
    expect(refusalText({ why: "arg_unlisted", what: "--agent" }, "Claude Code")).toBe("--agent is not on the short list of options Manut AI knows are harmless for Claude Code, so it does not pass it.");
  });

  it("refuses variables the app sets itself, the home variable and a name twice", () => {
    expect(checkVars("claude", [{ name: "ANTHROPIC_BASE_URL", value: "x" }])).toBeNull();
    expect(checkVars("claude", [{ name: "PATH" }])).toEqual({ why: "var_own", what: "PATH" });
    expect(checkVars("claude", [{ name: "manut_x" }])?.why).toBe("var_own");
    expect(checkVars("claude", [{ name: "CLAUDE_CONFIG_DIR" }])).toEqual({ why: "var_home", what: "CLAUDE_CONFIG_DIR" });
    expect(checkVars("grok", [{ name: "GROK_SANDBOX" }])?.why).toBe("var_own");
    // a variable that skips the asks, lifts the sandbox or points at other settings, in any case and with or without _
    for (const [id, name] of [["gemini", "GEMINI_CLI_SYSTEM_SETTINGS_PATH"], ["gemini", "gemini_cli_system_settings_path"], ["gemini", "GEMINICLISYSTEMSETTINGSPATH"], ["claude", "CLAUDE_CODE_SANDBOXED"], ["opencode", "OPENCODE_CONFIG"], ["codex", "CODEX_EXEC_SERVER_URL"]]) {
      expect(checkVars(id, [{ name }]), `${id} ${name}`).toEqual({ why: "var_own", what: name });
    }
    expect(checkVars("claude", [{ name: "CLAUDECONFIGDIR" }])?.why).toBe("var_home");
    expect(checkVars("claude", [{ name: "A" }, { name: "a" }])?.why).toBe("var_name");
    expect(checkVars("claude", [{ name: "1A" }])?.why).toBe("var_name");
    expect(checkVars("dsh", [{ name: "A" }], false)?.why).toBe("var_none");
  });
});

describe("the form and its patch", () => {
  it("sends only what changed, and a saved variable the person did not retype without a value", () => {
    const v = view({ name: "Work", args: ["--model=opus"], env: ["MY_KEY", "OTHER"] });
    const f = formOf(v);
    expect(f.env).toEqual([
      { name: "MY_KEY", value: null, saved: true },
      { name: "OTHER", value: null, saved: true },
    ]);
    expect(patchOf(v, f)).toEqual({});
    // retype one, remove the other, add a new one
    const next = { ...f, env: [{ name: "MY_KEY", value: "new-value", saved: true }, { name: "NEW", value: "n", saved: false }] };
    expect(patchOf(v, next)).toEqual({ env: [{ name: "MY_KEY", value: "new-value" }, { name: "NEW", value: "n" }] });
    // removing one sends the rest without their values: the shell keeps them
    expect(patchOf(v, { ...f, env: [f.env[0]] })).toEqual({ env: [{ name: "MY_KEY" }] });
    // a value is never put back into a form: the form of a saved view has none
    expect(JSON.stringify(formOf(v))).not.toContain("new-value");
    expect(patchOf(v, { ...f, name: " Team ", args: "--model=sonnet\n--effort=high" })).toEqual({ name: "Team", args: ["--model=sonnet", "--effort=high"] });
    expect(patchOf(v, { ...f, path: "/opt/claude" })).toEqual({ path: "/opt/claude" });
  });

  it("checks the form as the shell will before it is sent", () => {
    const v = view();
    expect(checkForm(v, { ...formOf(v), args: "--model=opus\n--dangerously-skip-permissions" })).toEqual({ why: "arg_skips", what: "--dangerously-skip-permissions" });
    expect(checkForm(view({ id: "pi", takes_args: false }), { ...formOf(view()), args: "--model=x" })?.why).toBe("arg_unchecked");
    expect(checkForm(v, { ...formOf(v), env: [{ name: "PATH", value: "/x", saved: false }] })?.why).toBe("var_own");
  });
});

describe("refusals in words", () => {
  it("names the option or the variable and the agent, never the code or a value, in every language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      for (const raw of ["why:arg_skips:--dangerously-skip-permissions", "why:arg_own:--resume", "why:var_home:CLAUDE_CONFIG_DIR", "why:path_run", "why:arg_unchecked", "why:var_keep:MY_KEY", "why:file"]) {
        const text = errorText(new Error(raw), "Claude Code");
        expect(text, `${lang} ${raw}`).not.toMatch(/why:|arg_|var_|path_/);
        const what = refusalOf(new Error(raw))!.what;
        if (what) expect(text, `${lang} ${raw}`).toContain(what);
      }
    }
    setLang("en");
    expect(refusalText({ why: "arg_skips", what: "--yolo" }, "Gemini CLI")).toBe("--yolo would let Gemini CLI act without asking first, or outside its sandbox, so Manut AI does not pass it.");
    expect(errorText(new Error("Claude Code is not installed"), "Claude Code")).toBe("Claude Code is not installed");
  });
});

describe("a row's line", () => {
  it("says off, not installed, a path gone, signed in as who, or installed where the app cannot tell", () => {
    expect(statusLine(view({ off: true }), null, planName).text).toBe(t("prov.offLine"));
    expect(statusLine(view({ found: null }), null, planName).text).toBe(t("ag.notInstalled"));
    expect(statusLine(view({ path: "/gone", path_ok: false, found: null }), null, planName).tone).toBe("warn");
    expect(statusLine(view(), { logged_in: true, email: "me@example.com", plan: "max_20x" }, planName).text).toBe("Signed in as me@example.com · Max 20x");
    expect(statusLine(view(), { logged_in: false }, planName).text).toBe("Not signed in");
    // an agent with no sign-in check of its own: installed, nothing invented
    expect(statusLine(view({ id: "gemini", signin: false }), null, planName).text).toBe(t("ag.installed"));
  });
});
