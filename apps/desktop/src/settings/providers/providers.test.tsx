// Settings › Providers through the browser stand-in for the shell (MockHost, which applies providers.rs' checks over its
// copy of the file): an agent turned off is offered nowhere (both parts of the + menu, Buddy, a new draft); a display
// name is the name everywhere; a refused argument or a bad path is refused; a variable's value goes in once and never
// comes back to the page, its own log or the agent look-up. The shell's own refusal of a start is providers.rs' and
// agent_chat.rs' Rust tests'.
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MockHost, type MockCall } from "../../sessions/host";
import { agentDef, chatAgents, draftAgent, menuOrder, offeredAgents, registerAcp, terminalAgents, type AgentInfo } from "../../sessions/agents";
import { answering, noneSaid } from "../../runtime/mock/buddy";
import { LANGS, setLang, t } from "../../i18n";
import { ProviderDetail } from "./ProvidersPage";
import { signinAgent, statusLine } from "./model";
import { planName } from "../accounts/rules";

const ids = (l: { id: string }[]) => l.map((a) => a.id);
const SECRET = "sk-live-7f3a9c2e1b";

afterEach(() => {
  setLang("en");
  registerAcp([]);
});

describe("an agent turned off on Settings › Providers", () => {
  it("is offered nowhere: neither part of the + menu, not Buddy, not a new draft; and comes back when turned on", async () => {
    const g: Record<string, unknown> = { __manutMockAgents: ["claude", "codex", "gemini", "cursor-agent"] };
    const host = new MockHost(g);
    const on = await host.agents();
    expect(answering(on)).toBe("claude");
    expect(ids(chatAgents(offeredAgents(on), []))).toEqual(["claude", "codex", "gemini", "cursor-agent"]);

    const v = await host.providerSave("claude", { off: true });
    expect(v.off).toBe(true);
    const agents = await host.agents();
    registerAcp(agents);
    expect(agents.find((a) => a.id === "claude")).toMatchObject({ off: true, path: "/usr/local/bin/claude" });
    const offered = offeredAgents(agents);
    // the + menu's two parts: Chat with Kit and In a terminal (with More agents)
    expect(ids(chatAgents(offered, []))).toEqual(["codex", "gemini", "cursor-agent"]);
    const term = terminalAgents(offered, []);
    expect(ids([...term.shown, ...term.more])).not.toContain("claude");
    expect(ids(menuOrder(offered, []))).not.toContain("claude");
    // Buddy: no agent answers, and it says where to turn it on rather than how to install it
    expect(answering(agents)).toBeNull();
    expect(noneSaid(agents)).toBe(t("buddy.off", { agent: "Claude Code" }));
    // a new draft never opens on it, even when it was the last one used
    expect(draftAgent([{ agent: "claude", cwd: "/a", at: 1 }], agents)).toBe("codex");

    await host.providerSave("claude", { off: false });
    const back = await host.agents();
    expect(answering(back)).toBe("claude");
    expect(ids(chatAgents(offeredAgents(back), []))[0]).toBe("claude");
  });

  it("a person's own agent and an ACP agent are turned off the same way", async () => {
    const g: Record<string, unknown> = { __manutMockAgents: ["claude", "gemini"], __manutCustomFile: [{ id: "acme", label: "Acme", program: "acme-agent", args: ["acp"], install: "" }] };
    const host = new MockHost(g);
    await host.providerSave("acme", { off: true });
    await host.providerSave("gemini", { off: true });
    const agents = await host.agents();
    registerAcp(agents);
    expect(ids(chatAgents(offeredAgents(agents), []))).toEqual(["claude"]);
    const list = await host.providers();
    expect(list.find((v) => v.id === "acme")).toMatchObject({ kind: "custom", off: true, takes_path: false, takes_args: false });
  });
});

describe("the settings of one agent", () => {
  it("a display name is its name everywhere the app names it", async () => {
    const host = new MockHost({ __manutMockAgents: ["claude", "gemini"] } as Record<string, unknown>);
    await host.providerSave("claude", { name: "Claude at work" });
    await host.providerSave("gemini", { name: "Gemini" });
    const agents = await host.agents();
    registerAcp(agents);
    expect(agentDef("claude").label).toBe("Claude at work");
    expect(agentDef("gemini").label).toBe("Gemini");
    // the page still knows its own name
    expect((await host.providers()).find((v) => v.id === "claude")).toMatchObject({ label: "Claude Code", name: "Claude at work" });
    await expect(host.providerSave("claude", { name: "x; rm" })).rejects.toThrow("why:name");
  });

  it("refuses a bad path and an argument that skips the asks, by name, and keeps what was there", async () => {
    const g: Record<string, unknown> = { __manutMockAgents: ["claude", "pi"] };
    const host = new MockHost(g);
    await host.providerSave("claude", { args: ["--model=opus"] });
    await expect(host.providerSave("claude", { path: "claude" })).rejects.toThrow("why:path_shape");
    await expect(host.providerSave("claude", { path: "/nowhere/claude" })).rejects.toThrow("why:path_run");
    await expect(host.providerSave("claude", { args: ["--model=opus", "--dangerously-skip-permissions"] })).rejects.toThrow("why:arg_skips:--dangerously-skip-permissions");
    await expect(host.providerSave("claude", { args: ["--permission-prompt-tool=x"] })).rejects.toThrow("why:arg_own:--permission-prompt-tool");
    await expect(host.providerSave("pi", { args: ["--model=x"] })).rejects.toThrow("why:arg_unchecked");
    await expect(host.providerSave("claude", { env: [{ name: "CLAUDE_CONFIG_DIR", value: "/x" }] })).rejects.toThrow("why:var_home:CLAUDE_CONFIG_DIR");
    // nothing refused was kept
    expect((await host.providers()).find((v) => v.id === "claude")).toMatchObject({ path: "", args: ["--model=opus"], env: [] });
  });

  it("a variable's value is sent once and never comes back: not in a view, the look-up, the host's log or the page", async () => {
    const g: Record<string, unknown> = { __manutMockAgents: ["claude"] };
    const host = new MockHost(g);
    const saved = await host.providerSave("claude", { env: [{ name: "MY_KEY", value: SECRET }] });
    expect(saved.env).toEqual(["MY_KEY"]);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(JSON.stringify(await host.providers())).not.toContain(SECRET);
    expect(JSON.stringify(await host.agents())).not.toContain(SECRET);
    expect(JSON.stringify(g.__manutSessionCalls as MockCall[])).not.toContain(SECRET);
    // kept by the stand-in, as the shell keeps it in its file
    expect(JSON.stringify(g.__manutProviders)).toContain(SECRET);
    // saving again without retyping it keeps it; naming one the shell never had is refused
    await host.providerSave("claude", { env: [{ name: "MY_KEY" }], args: ["--model=opus"] });
    expect(JSON.stringify(g.__manutProviders)).toContain(SECRET);
    await expect(host.providerSave("claude", { env: [{ name: "OTHER" }] })).rejects.toThrow("why:var_keep:OTHER");
    // the page draws the saved variable by name with a hidden placeholder, never a value
    for (const lang of LANGS) {
      setLang(lang);
      const html = renderToString(<ProviderDetail v={(await host.providers()).find((v) => v.id === "claude")!} signin={null} onSaved={() => {}} />);
      expect(html).toContain("MY_KEY");
      expect(html).toContain(t("prov.varSaved").replace(/'/g, "&#x27;"));
      expect(html).not.toContain(SECRET);
    }
  });

  it("the page shows every setting with a line on what it does, and the command a chat and a terminal run", async () => {
    const host = new MockHost({ __manutMockAgents: ["claude", "dsh"] } as Record<string, unknown>);
    await host.providerSave("claude", { args: ["--model=opus"] });
    const views = await host.providers();
    const html = renderToString(<ProviderDetail v={views.find((v) => v.id === "claude")!} signin={{ logged_in: true, email: "me@example.com", plan: "pro" }} onSaved={() => {}} />);
    const text = html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    for (const k of ["prov.name", "prov.path", "prov.pathHint", "prov.args", "prov.argsHint", "prov.vars", "prov.varsHint", "prov.homeHint"] as const) expect(text, k).toContain(t(k));
    expect(text).toContain(t("prov.home", { var: "CLAUDE_CONFIG_DIR" }));
    expect(text).toContain("Signed in as me@example.com · Pro");
    expect(html).toContain('data-testid="provider-runs-chat"');
    expect(text).toContain("--model=opus");
    // one line says the checks are about a mistake or a pasted line, not against the person
    expect(text).toContain(t("prov.guard", { agent: "Claude Code" }));
    // DeepSeek Harness: a path only, and it says why nothing else
    const dsh = renderToString(<ProviderDetail v={views.find((v) => v.id === "dsh")!} signin={null} onSaved={() => {}} />);
    expect(dsh).not.toContain('data-testid="provider-args"');
    expect(dsh).not.toContain('data-testid="provider-vars"');
    expect(dsh).not.toContain('data-testid="provider-guard"');
    expect(dsh).toContain('data-testid="provider-path"');
  });
});

describe("the look-up's settings reach the menus only through the shell's answer", () => {
  it("an agent the look-up marks off is filtered however it arrives", () => {
    const agents: AgentInfo[] = [
      { id: "claude", label: "Claude Code", mode: "chat", path: "/x/claude", off: true },
      { id: "codex", label: "Codex", mode: "chat", path: "/x/codex" },
    ];
    expect(ids(offeredAgents(agents))).toEqual(["codex"]);
    expect(answering(agents)).toBeNull();
    expect(draftAgent([], agents)).toBe("codex");
  });
});

describe("Cursor's and Antigravity's sign-in (item 101a)", () => {
  it("is read from their own status commands through the shell, and only for those two", async () => {
    const g: Record<string, unknown> = {
      __manutMockAgents: ["claude", "codex", "gemini", "cursor-agent", "agy"],
      __manutMockSignins: { "cursor-agent": { logged_in: true, email: "me@example.com" }, agy: { logged_in: false } },
    };
    const host = new MockHost(g);
    const views = await host.providers();
    const by = (id: string) => views.find((v) => v.id === id)!;
    expect(["claude", "codex", "gemini", "cursor-agent", "agy"].map((id) => by(id).signin)).toEqual([true, true, false, true, true]);
    expect(signinAgent("cursor-agent") && signinAgent("agy") && !signinAgent("claude") && !signinAgent("gemini")).toBe(true);
    const cursor = await host.providerSignin("cursor-agent");
    expect(statusLine(by("cursor-agent"), cursor, planName).text).toBe(t("prov.signedInAs", { who: "me@example.com" }));
    expect(statusLine(by("agy"), await host.providerSignin("agy"), planName).text).toBe(t("prov.signedOut"));
    // an agent whose sign-in is not read this way, or one not installed, gets nothing
    expect(await host.providerSignin("gemini")).toBeNull();
    expect(await new MockHost({ __manutMockAgents: ["claude"] }).providerSignin("cursor-agent")).toBeNull();
    // a status command that said nothing: installed, nothing invented
    const quiet = new MockHost({ __manutMockAgents: ["agy"], __manutMockSignins: { agy: null } });
    expect(statusLine(by("agy"), await quiet.providerSignin("agy"), planName).text).toBe(t("ag.installed"));
  });
});
