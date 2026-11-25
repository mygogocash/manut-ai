// The chat box's own parts (item 80), drawn with react-dom/server from props as the + menu's tests draw theirs: what
// Add context puts in a message (context.ts), the approval menu's levels for Buddy and for Kit, and the model button.
// How they behave in a browser is e2e/chat-box.spec.ts's; what the runtime and the shell take is buddy.test.ts's and
// buddy_chat.rs's.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KIT_LEVELS } from "@manut/member-grants";
import { setLang, t } from "../../i18n";
import type { AgentBox } from "../../lib/protocol";
import { modesOf } from "../../sessions/controls";
import { BUDDY_MODES } from "../../runtime/mock/buddy";
import { addAt, folderLabel, matchMembers, mentionAt, putMention, withAction, withFolders } from "./context";
import { ApprovalRows, DialRows } from "./ApprovalMenu";
import { ModelMenu } from "./ModelMenu";
import { boxLabel, boxOn, teammates } from "./AgentBox";

afterEach(() => setLang("en"));

const TEAM = [
  { name: "nam", label: "Nam" },
  { name: "pim", label: "Pim" },
  { name: "kit", label: "Kit" },
];

describe("Add context: a mention, an action, a folder", () => {
  it("opens the @ menu only at a word's start, so an address or a path opens nothing", () => {
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("ask @na", 7)).toEqual({ start: 4, query: "na" });
    expect(mentionAt("mail a@b.com", 8)).toBeNull();
    expect(mentionAt("see ~/x@y", 9)).toBeNull();
    expect(mentionAt("@nam hello", 10)).toBeNull();
  });

  it("matches a teammate by the start of a name first, then anywhere in it, and puts the name a mention is written with", () => {
    expect(matchMembers(TEAM, "")).toEqual(TEAM);
    expect(matchMembers(TEAM, "p").map((m) => m.name)).toEqual(["pim"]);
    expect(matchMembers(TEAM, "i").map((m) => m.name)).toEqual(["pim", "kit"]);
    expect(putMention("ask @na about it", 4, 7, TEAM[0])).toEqual({ text: "ask @nam about it", caret: 9 });
    // the + menu's Mention row: an @ at the caret, after a space when a word ends there
    expect(addAt("", 0)).toEqual({ text: "@", caret: 1 });
    expect(addAt("ask", 3)).toEqual({ text: "ask @", caret: 5 });
    expect(addAt("ask ", 4)).toEqual({ text: "ask @", caret: 5 });
  });

  it("puts an action picked from the + in front of what was typed", () => {
    expect(withAction("  the login page", { name: "review", description: "", hint: "", kind: "command", prefix: "/" })).toBe("/review the login page");
  });

  it("names a folder on a line of its own under the text, in the person's language, and never copies it", () => {
    expect(withFolders("what sells best?", [])).toBe("what sells best?");
    expect(withFolders(" what sells best? ", ["/Users/fon/Shop"])).toBe("what sells best?\n\nFolder: /Users/fon/Shop");
    expect(withFolders("", ["/a", "/b"])).toBe("Folder: /a\nFolder: /b");
    setLang("ja");
    expect(withFolders("見て", ["/Users/fon/Shop"])).toBe(`見て\n\n${t("box.folderLine", { path: "/Users/fon/Shop" })}`);
    expect(folderLabel("/Users/fon/Shop/")).toBe("Shop");
    expect(folderLabel("C:\\Users\\fon\\Shop")).toBe("Shop");
  });

  it("offers every teammate but the one whose chat it is", () => {
    const bots = ["buddy", "nam", "pim"].map((name) => ({ name, display_name: name[0].toUpperCase() + name.slice(1), is_default: name === "buddy", model: "", provider: "", description: "", status: "online" as const, running: false }));
    expect(teammates(bots, "buddy")).toEqual([
      { name: "nam", label: "Nam" },
      { name: "pim", label: "Pim" },
    ]);
  });
});

describe("the approval menu", () => {
  const rows = (html: string, id: string) => [...html.matchAll(new RegExp(`data-testid="${id}-opt" data-mode="([^"]+)"`, "g"))].map((m) => m[1]);

  it("offers Buddy asking first and planning first only, in plain words, and never a level that skips asking", () => {
    expect(BUDDY_MODES).toEqual(["default", "plan"]);
    const html = renderToString(
      createElement(ApprovalRows, { modes: BUDDY_MODES, current: "default", live: true, onPick: vi.fn(), hint: (m: string) => t(m === "plan" ? "box.hint.plan" : "box.hint.ask"), foot: t("box.buddyFoot", { agent: "Claude Code" }), testId: "box-approval" }),
    );
    expect(rows(html, "box-approval")).toEqual(["default", "plan"]);
    for (const words of ["Ask", "Plan", "Asks you before it changes, sends or runs anything", "changes nothing until you say yes", "except for what your own Claude Code settings already allow"]) expect(html).toContain(words);
    expect(html).not.toMatch(/acceptEdits|Accept edits|bypass|skip|danger|dontAsk/i);
  });

  it("offers Kit the agent's own presets, then the dial for the project, where going live asks at every level", () => {
    const html = renderToString(
      createElement(ApprovalRows, {
        modes: modesOf("claude"),
        current: "default",
        live: true,
        onPick: vi.fn(),
        testId: "session-mode",
        extra: createElement(DialRows<(typeof KIT_LEVELS)[number]>, {
          title: `${t("kit.dial")} · shop`,
          levels: KIT_LEVELS,
          level: "edits_alone",
          label: (l) => t(`kit.level.${l}`),
          line: t("kit.line.edits_alone"),
          note: t("kit.live"),
          onLevel: vi.fn(),
          testId: "kit-box-level",
        }),
      }),
    );
    expect(rows(html, "session-mode")).toEqual(["default", "plan", "acceptEdits"]);
    for (const l of KIT_LEVELS) expect(html).toContain(`data-testid="kit-box-level-${l}"`);
    expect(html).toMatch(/data-testid="kit-box-level-edits_alone"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-testid="kit-box-level-edits_alone"/);
    for (const words of ["How much Kit does alone · shop", "Kit edits files alone.", "Going live always asks, at every level."]) expect(html).toContain(words);
    expect(html).not.toMatch(/bypass|danger|skip/i);
  });
});

describe("the model button", () => {
  const box: AgentBox = {
    agent: "claude",
    label: "Claude Code",
    models: [
      { id: "default", label: "Default (recommended)" },
      { id: "opus", label: "Opus" },
    ],
    model: "",
    running: "",
    efforts: ["low", "high"],
    effort: "high",
    approvals: ["default", "plan"],
    approval: "default",
  };

  it("names a model the chat picked, else what the agent runs, else the agent", () => {
    expect(boxLabel(box)).toBe("Claude Code");
    expect(boxLabel({ ...box, running: "Fable 5.2" })).toBe("Fable 5.2");
    expect(boxLabel({ ...box, running: "Fable 5.2", model: "opus" })).toBe("Opus");
    expect(boxLabel({ ...box, running: "Fable 5.2", model: "default" })).toBe("Fable 5.2");
    // the agent's own default row is on until the chat picks another
    expect(boxOn(box)).toBe("default");
    expect(boxOn({ ...box, model: "opus" })).toBe("opus");
    expect(boxOn({ ...box, models: [{ id: "opus", label: "Opus" }] })).toBe("");
  });

  it("shows the model and its effort beside it, quietly, in the box", () => {
    const html = renderToString(
      createElement(ModelMenu, { label: "Opus", mark: { model: "Opus", provider: "claude" }, live: true, options: box.models, isOn: () => false, onPick: async () => {}, canPick: true, efforts: box.efforts, effort: "high", onEffort: vi.fn(), empty: "", foot: "" }),
    );
    expect(html).toContain('data-testid="model-pill"');
    expect(html).toMatch(/data-testid="model-label"[^>]*>Opus</);
    expect(html).toMatch(/data-testid="reasoning-label"[^>]*>high</);
    expect(html).toContain("bx-pick");
    // no effort shown when the agent offers none
    expect(renderToString(createElement(ModelMenu, { label: "Claude Code", mark: { model: "", provider: "claude" }, live: false, options: [], isOn: () => false, onPick: async () => {}, canPick: false, efforts: [], effort: "", onEffort: vi.fn(), empty: "", foot: "" }))).not.toContain("reasoning-label");
  });
});
