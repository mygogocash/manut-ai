import { describe, expect, it } from "vitest";
import { acceptTitle, chatMaterial, titleRequest, wantsTitle, whyKey } from "./titleWords";
import { pickTitle } from "./titles";
import { termMenuItems } from "./SessionsSection";
import { TITLE_MODEL_DEFAULTS, type TitleModel } from "../lib/titleModel";

const on: TitleModel = { ...TITLE_MODEL_DEFAULTS, on: true, model: "haiku", effort: "low" };

describe("a title written by a model (item 96)", () => {
  it("needs the switch, an agent that can, and a chat the person has not named", () => {
    const rec = { agent: "claude", view: "chat" };
    expect(wantsTitle(rec, TITLE_MODEL_DEFAULTS)).toBe(false);
    expect(wantsTitle(rec, on)).toBe(true);
    expect(wantsTitle({ ...rec, agent: "codex" }, on)).toBe(false);
    expect(wantsTitle({ ...rec, view: "terminal" }, on)).toBe(false);
    expect(wantsTitle({ ...rec, title: "My name" }, on, true)).toBe(false);
    // written once on its own; again only when asked
    expect(wantsTitle({ ...rec, modelTitle: "Done" }, on)).toBe(false);
    expect(wantsTitle({ ...rec, modelTitle: "Done" }, on, true)).toBe(true);
  });

  it("is given the first message and the first answer, masked, and nothing before both exist", () => {
    expect(chatMaterial([{ role: "user", text: "hi" }])).toBe("");
    const m = chatMaterial([
      { role: "user", text: "Fix login with ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      { role: "assistant", text: "Done." },
      { role: "user", text: "later" },
    ]);
    expect(m).toContain("Fix login");
    expect(m).toContain("Done.");
    expect(m).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(m).not.toContain("later");
    expect(chatMaterial([{ role: "user", text: "x".repeat(9000) }, { role: "assistant", text: "y" }]).length).toBeLessThan(2700);
  });

  it("asks with the chosen model and effort", () => {
    expect(titleRequest("claude", on, "k1", "m")).toEqual({ agent: "claude", model: "haiku", effort: "low", purpose: "title", key: "k1", material: "m" });
  });

  it("never beats a name the person gave, even one given while it ran", () => {
    expect(acceptTitle({}, { title: "  Add a\nlogin page " })).toEqual({ modelTitle: "Add a login page" });
    expect(acceptTitle({ title: "Mine" }, { title: "Theirs" })).toBeNull();
    expect(acceptTitle({}, { title: "  " })).toBeNull();
    expect(acceptTitle(undefined, { title: "x" })).toBeNull();
    expect(pickTitle({ title: "Mine", modelTitle: "Model", agentTitle: "Agent" }, "f")).toEqual({ title: "Mine", source: "person" });
    expect(pickTitle({ modelTitle: "Model", agentTitle: "Agent", promptTitle: "P" }, "f")).toEqual({ title: "Model", source: "model" });
    expect(pickTitle({ agentTitle: "Agent" }, "f").source).toBe("agent");
  });

  it("says why in the page's words for each code, and other for the rest", () => {
    for (const c of ["off", "busy", "too_many", "timeout", "cancelled", "empty", "unsupported"]) expect(whyKey(new Error(c))).toBe(c);
    expect(whyKey(new Error("Not signed in"))).toBe("other");
    expect(whyKey(undefined)).toBe("other");
  });

  it("offers Write the title again after Rename only when it can", () => {
    expect(termMenuItems({ cwd: "", linkId: undefined }, undefined, true)).toEqual(["rename", "title", "here", "close"]);
    expect(termMenuItems({ cwd: "", linkId: undefined })).toEqual(["rename", "here", "close"]);
  });
});
