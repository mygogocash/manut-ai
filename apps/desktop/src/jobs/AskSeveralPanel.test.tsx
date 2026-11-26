// The Ask several agents panel (item 102a) drawn with react-dom/server from props, and its controls read from the elements it
// returns (the view uses no hooks; the chat box is a slot). What the panel does with a send is sessions/askSeveral.test.ts's.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t } from "../i18n";
import { AskSeveralView, limitWord, refusalWords, type AskRowView, type AskSeveralViewProps } from "./AskSeveralPanel";

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const AGENTS = [
  { id: "claude" as const, label: "Claude Code", limit: "" },
  { id: "codex" as const, label: "Codex", limit: "" },
];
const row = (agent: "claude" | "codex", over: Partial<AskRowView> = {}): AskRowView => ({
  pick: { agent, model: "", effort: "" },
  agents: AGENTS,
  account: "",
  limit: "",
  signedOut: false,
  models: [{ id: "opus", label: "Opus" }],
  efforts: ["low", "high"],
  ...over,
});
const props = (rows: AskRowView[], over: Partial<AskSeveralViewProps> = {}): AskSeveralViewProps => ({
  folder: "/Users/fon/baanmali-preorder",
  rows,
  onAgent: vi.fn(),
  onModel: vi.fn(),
  onEffort: vi.fn(),
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  onBack: vi.fn(),
  blocked: "",
  problem: "",
  box: createElement("textarea", { "data-testid": "composer" }),
  ...over,
});
const html = (p: AskSeveralViewProps) => renderToString(createElement(AskSeveralView, p));
const find = (p: AskSeveralViewProps, id: string) => drawn(AskSeveralView(p)).filter((e) => e.props["data-testid"] === id);

afterEach(() => setLang("en"));

describe("the Ask several agents panel", () => {
  it("is headed with the folder, says what it does, and holds a row for each agent and the shared box", () => {
    const out = html(props([row("claude"), row("codex")]));
    expect(out).toContain("Ask several agents");
    expect(out).toContain("baanmali-preorder");
    expect(out).toContain("Nothing is sent until you press Send.");
    expect(out.split('data-testid="ask-row-').length - 1).toBe(2);
    expect(out).toContain('data-testid="composer"');
  });

  it("offers each row's agent, model and effort, the agent's own first, and what the agent listed after", () => {
    const out = html(props([row("claude"), row("codex")]));
    expect(out).toContain("Agent&#x27;s own");
    for (const word of ["Opus", "Low", "High", "Claude Code", "Codex"]) expect(out, word).toContain(word);
  });

  it("names the account a lane would run as, and says Limited until a time for a limited account's row", () => {
    const out = html(props([row("claude", { account: "as work@…" }), row("codex", { limit: "Limited until 14:00" })]));
    expect(out).toContain("as work@…");
    expect(out).toContain('data-testid="ask-limit-1"');
    expect(out).toContain("Limited until 14:00");
    expect(out).not.toContain('data-testid="ask-limit-0"');
  });

  it("shows a limited agent in the list but cannot pick it, unless it is the row's own", () => {
    const limited = AGENTS.map((a) => (a.id === "codex" ? { ...a, limit: "Limited until 14:00" } : a));
    const out = html(props([row("claude", { agents: limited })]));
    expect(out).toContain("Codex · Limited until 14:00");
    expect(out).toMatch(/<option value="codex" disabled="">/);
    expect(out).not.toMatch(/<option value="claude" disabled/);
  });

  it("says in words when a send is blocked, and why a send was refused", () => {
    const out = html(props([row("claude"), row("codex", { limit: "Limited" })], { blocked: "Codex is at its limit. Pick another agent, or wait for it to reset.", problem: "Pick a folder first." }));
    expect(out).toContain('data-testid="ask-blocked"');
    expect(out).toContain("Codex is at its limit.");
    expect(out).toContain('data-testid="ask-problem"');
  });

  it("takes at most three agents: Add an agent shows below three, and the cap says so at three", () => {
    expect(find(props([row("claude"), row("codex")]), "ask-add")).toHaveLength(1);
    const three = props([row("claude"), row("codex"), row("claude")]);
    expect(find(three, "ask-add")).toHaveLength(0);
    expect(html(three)).toContain("That is the most at once: 3 agents a message.");
  });

  it("lets a row be removed only while two or more remain", () => {
    expect(find(props([row("claude"), row("codex")]), "ask-remove-0")).toHaveLength(0);
    expect(find(props([row("claude"), row("codex"), row("claude")]), "ask-remove-2")).toHaveLength(1);
  });

  it("hands each choice to the panel: the agent, the model, the effort, Add, Remove and Back", () => {
    const p = props([row("claude"), row("codex"), row("claude")]);
    (find(p, "ask-agent-1")[0].props.onChange as (e: unknown) => void)({ target: { value: "claude" } });
    (find(p, "ask-model-0")[0].props.onChange as (e: unknown) => void)({ target: { value: "opus" } });
    (find(p, "ask-effort-2")[0].props.onChange as (e: unknown) => void)({ target: { value: "high" } });
    (find(p, "ask-remove-1")[0].props.onClick as () => void)();
    (find(p, "ask-back")[0].props.onClick as () => void)();
    expect(p.onAgent).toHaveBeenCalledWith(1, "claude");
    expect(p.onModel).toHaveBeenCalledWith(0, "opus");
    expect(p.onEffort).toHaveBeenCalledWith(2, "high");
    expect(p.onRemove).toHaveBeenCalledWith(1);
    expect(p.onBack).toHaveBeenCalled();
  });

  it("offers no effort choice for an agent that listed none", () => {
    expect(html(props([row("claude", { efforts: [] })]))).toMatch(/data-testid="ask-effort-0"[^>]*disabled/);
  });

  it("reads in every language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      const out = html(props([row("claude"), row("codex")]));
      expect(out, lang).toContain(t("several.title"));
      expect(out, lang).toContain(t("several.lead", { max: 3 }));
    }
  });
});

describe("the words of a limit and a refusal", () => {
  it("say Limited until a time, or Limited when no reset is named, and nothing for an account that is not", () => {
    expect(limitWord(null, 1_000)).toBe("");
    expect(limitWord({ until: null }, 1_000)).toBe("Limited");
    expect(limitWord({ until: 500 }, 1_000)).toBe("Limited");
    expect(limitWord({ until: 1_000 + 60 }, 1_000)).toMatch(/^Limited until /);
  });

  it("name the agent and the rule in plain words", () => {
    expect(refusalWords({ why: "limited", agent: "codex" }, null)).toContain("is at its limit");
    expect(refusalWords({ why: "few" }, null)).toBe("Pick at least 2 agents.");
    expect(refusalWords({ why: "many" }, null)).toBe("Pick at most 3 agents.");
    expect(refusalWords({ why: "empty" }, null)).toBe("Write a message first.");
  });
});
