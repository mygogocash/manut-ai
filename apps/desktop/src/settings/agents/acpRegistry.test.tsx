// Settings › Providers › From the ACP registry (item 101c): the list and its search over the shell's list (the mock
// host's copy, which acp_registry.rs' test holds equal to what the shell computes for an Apple silicon Mac), each row's
// words, the foot, and the confirm card through the browser stand-in: only an offered entry has a card, it is the custom
// agent card drafted as a bot's draft is, nothing is written until Add, and after Add the entry is the person's own.
// The shell's own reading of the pinned file and its checks are acp_registry.rs' Rust tests.
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MockHost, type MockCall } from "../../sessions/host";
import { setLang } from "../../i18n";
import mock from "./mockAcpRegistry.json";
import { pinnedText, registryError, registryMark, registryRows, searchRank, stateText, withMine, type RegistryList as List, type RegistryOffer } from "./acpRegistry";
import { RegistryList } from "./RegistryList";
import { AgentConfirmCard } from "./AgentsPage";

const LIST = mock as List;
const ids = (l: RegistryOffer[]) => l.map((o) => o.id);
const row = (id: string) => LIST.agents.find((o) => o.id === id)!;

afterEach(() => setLang("en"));

describe("the search", () => {
  it("ranks as T3 Code does: the id or name whole, then a prefix, then word starts, inside, the authors, the description", () => {
    const goose = row("goose");
    expect(searchRank(goose, "")).toBe(100);
    expect(searchRank(goose, "goose")).toBe(0);
    expect(searchRank(goose, "GOO")).toBe(10);
    expect(searchRank(row("mistral-vibe"), "vibe")).toBe(20);
    expect(searchRank(row("crow-cli"), "row")).toBe(30);
    expect(searchRank(row("junie"), "jetbrains")).toBe(40);
    expect(searchRank(row("goose"), "extensible")).toBe(50);
    expect(searchRank(goose, "nothing like it")).toBeUndefined();
  });

  it("lists every entry with nothing typed, the ones that can be added first, each part by name", () => {
    const all = registryRows(LIST.agents, "");
    expect(all).toHaveLength(LIST.agents.length);
    const firstHeld = all.findIndex((o) => o.state !== "offered");
    expect(firstHeld).toBeGreaterThan(0);
    expect(all.slice(firstHeld).every((o) => o.state !== "offered")).toBe(true);
    const offered = all.slice(0, firstHeld).map((o) => o.name.toLowerCase());
    expect(offered).toEqual([...offered].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("finds an agent by its name, its maker or its words, best match first, and nothing for no match", () => {
    expect(ids(registryRows(LIST.agents, "goose"))[0]).toBe("goose");
    expect(ids(registryRows(LIST.agents, "kimi"))).toEqual(["kimi", "kimi-code"]);
    expect(ids(registryRows(LIST.agents, "jetbrains"))).toEqual(expect.arrayContaining(["junie"]));
    expect(ids(registryRows(LIST.agents, "rust"))).toContain("corust-agent");
    expect(registryRows(LIST.agents, "zzzz no such agent")).toEqual([]);
  });
});

describe("each row", () => {
  it("says why an entry has no Add…", () => {
    expect(stateText(row("claude-acp"))).toBe("In Providers as Claude Code");
    expect(stateText(row("grok-build"))).toBe("In Providers as Grok");
    expect(stateText(row("vtcode"))).toBe("Set aside by the registry's own checks: Missing windows builds");
    expect(stateText(row("auggie"))).toBe("Needs AUGMENT_DISABLE_AUTO_UPDATE, which Manut AI does not set");
    expect(stateText(row("kilo"))).toBe("Kilo Code is not offered.");
    expect(stateText({ ...row("goose"), state: "start" })).toBe("Starts with options Manut AI has not checked");
    expect(stateText({ ...row("goose"), state: "platform" })).toBe("Not for this computer");
    expect(stateText({ ...row("goose"), state: "bin" })).toBe("Its command is not known");
    expect(stateText({ ...row("goose"), state: "refused", note: "interp" })).toBe("The registry names a shell or an interpreter as its program.");
    expect(stateText({ ...row("goose"), state: "yours", note: "My goose" })).toBe("Added as My goose");
    expect(stateText(row("goose"))).toBe("");
    setLang("zh");
    expect(stateText(row("claude-acp"))).toBe("已在提供方中，名为 Claude Code");
  });

  it("draws each product's own mark where item 122 has one, else the monogram", () => {
    expect(registryMark("claude-acp")).toBe("claude");
    expect(registryMark("amp-acp")).toBe("amp");
    expect(registryMark("goose")).toBe("goose");
    expect(registryMark("dirac")).toBe("dirac");
    const html = renderToString(<RegistryList list={LIST} query="goose" onQuery={() => {}} busy={false} onAdd={() => {}} />);
    expect(html).toContain('data-agent="goose"');
    const mono = renderToString(<RegistryList list={LIST} query="dirac" onQuery={() => {}} busy={false} onAdd={() => {}} />);
    expect(mono).toContain('data-letter="D"');
  });

  it("says the pinned release and its date once, at the foot", () => {
    expect(pinnedText(LIST.pin)).toBe(`ACP registry ${LIST.pin.tag}, published 26 Nov 2026`);
    expect(pinnedText({ ...LIST.pin, published: "not a date" })).toBe(`ACP registry ${LIST.pin.tag}, published not a date`);
    setLang("ja");
    expect(pinnedText(LIST.pin)).toBe(`ACP レジストリ ${LIST.pin.tag}（2026年11月26日 公開）`);
  });
});

describe("the list", () => {
  const html = (query: string, list: List | null = LIST) => renderToString(<RegistryList list={list} query={query} onQuery={() => {}} busy={false} onAdd={() => {}} />);

  it("shows the rows that match, each with its name, description and Add… or why not, and the pin once", () => {
    const h = html("goose");
    expect(h).toContain('data-testid="acpreg-row-goose"');
    expect(h).toContain("A local, extensible, open source AI agent");
    expect(h).toContain('data-testid="acpreg-add-goose"');
    expect(h).toContain('aria-label="Add goose…"');
    expect(h).not.toContain('data-testid="acpreg-row-dirac"');
    expect(h.match(/data-testid="acpreg-pin"/g)).toHaveLength(1);
    const claude = html("claude");
    expect(claude).toContain('data-testid="acpreg-why-claude-acp"');
    expect(claude).toContain("In Providers as Claude Code");
    expect(claude).not.toContain('data-testid="acpreg-add-claude-acp"');
  });

  it("says when nothing matches, and that it is reading before the shell answers", () => {
    expect(html("zzzz")).toContain('data-testid="acpreg-none"');
    const reading = html("", null);
    expect(reading).toContain("Reading the registry");
    expect(reading).not.toContain('data-testid="acpreg-pin"');
  });
});

describe("the confirm card from the registry, through the mock host", () => {
  it("is the custom agent card, drafted as a bot's draft is, with the install line shown and nothing written", async () => {
    const g: Record<string, unknown> = {};
    const host = new MockHost(g);
    const card = await host.acpRegistryPreview("dirac");
    expect(card.entry).toEqual({ id: "dirac", label: "Dirac", program: "dirac", args: ["--acp"], install: "npm install -g dirac-cli@0.6.2" });
    expect(card.registry).toMatchObject({ id: "dirac", via: "npx", install: "npm install -g dirac-cli@0.6.2", tag: LIST.pin.tag });
    expect(g.__manutCustomFile).toBeUndefined();
    const ops = ((g.__manutSessionCalls as MockCall[] | undefined) ?? []).map((c) => c.op);
    expect(ops).not.toContain("custom.confirm");

    const h = renderToString(<AgentConfirmCard card={card} busy={false} onCancel={() => {}} onAdd={() => {}} onChange={() => {}} />);
    expect(h).toContain('data-testid="agent-confirm-registry"');
    expect(h).toContain("npm install -g dirac-cli@0.6.2");
    expect(h).toContain("Manut AI never runs this");
    expect(h).toContain('data-testid="agent-confirm-change"');
    // an archive: its address and checksum to download from, never fetched
    const goose = await host.acpRegistryPreview("goose");
    const gh = renderToString(<AgentConfirmCard card={goose} busy={false} onCancel={() => {}} onAdd={() => {}} />);
    expect(gh).toContain('data-testid="agent-confirm-archive"');
    expect(gh).toContain("Manut AI never downloads it");
    expect(gh).not.toContain('data-testid="agent-confirm-change"');
    // the form's card and a bot's have no registry part
    const plain = await host.customPreview("Acme", "acme-agent", "acp", "");
    expect(renderToString(<AgentConfirmCard card={plain} busy={false} onCancel={() => {}} onAdd={() => {}} />)).not.toContain("agent-confirm-registry");
  });

  it("has no card for an entry that is not offered, and after Add the entry is the person's own", async () => {
    const g: Record<string, unknown> = {};
    const host = new MockHost(g);
    await expect(host.acpRegistryPreview("claude-acp")).rejects.toThrow("why:builtin");
    await expect(host.acpRegistryPreview("kilo")).rejects.toThrow("why:kilo");
    await expect(host.acpRegistryPreview("auggie")).rejects.toThrow("why:registry");
    await expect(host.acpRegistryPreview("no-such-agent")).rejects.toThrow("why:registry");
    expect(registryError(new Error("why:registry"))).toBe("This registry entry cannot be added now.");
    expect(registryError(new Error("why:builtin"))).toBe("That name belongs to an agent Manut AI already offers.");

    const card = await host.acpRegistryPreview("goose");
    await host.customConfirm(card.entry);
    expect(g.__manutCustomFile).toEqual([card.entry]);
    const after = await host.acpRegistry();
    expect(after.agents.find((o) => o.id === "goose")).toMatchObject({ state: "yours", note: "goose" });
    await expect(host.acpRegistryPreview("goose")).rejects.toThrow("why:dup");
    expect((await host.customList()).agents.map((a) => a.id)).toEqual(["goose"]);
  });

  it("matches a person's own agent by its program, wherever it is", () => {
    const l = withMine(LIST, [{ label: "My Dirac", program: "/opt/x/dirac" }]);
    expect(l.agents.find((o) => o.id === "dirac")).toMatchObject({ state: "yours", note: "My Dirac" });
    // an agent already among manut's stays so
    expect(withMine(LIST, [{ label: "x", program: "claude-agent-acp" }]).agents.find((o) => o.id === "claude-acp")?.state).toBe("there");
  });
});
