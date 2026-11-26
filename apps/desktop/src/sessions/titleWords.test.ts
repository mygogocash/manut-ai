import { describe, expect, it } from "vitest";
import { acceptTitle, chatMaterial, holdsKeys, pullMaterial, titleRequest, wantsTitle, whyKey } from "./titleWords";
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

  it("gives a pull request's words the commit lines, the file names and a few lines of each change, masked and cut", () => {
    const file = (path: string, lines: string[]) => ({ path, kind: "update", added: lines.length, removed: 0, lines });
    const m = pullMaterial(["Add a login page"], [file("src/login.ts", ["@@ -1 +1,2 @@", "+const page = 1;", '+const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";'])]);
    expect(m).toContain("- Add a login page");
    expect(m).toContain("update src/login.ts (+3 -0)");
    expect(m).toContain("+const page = 1;");
    expect(m).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    // at most twenty lines of a file, and the whole at most 6,000 characters
    const long = pullMaterial([], [file("a.ts", Array.from({ length: 50 }, (_, i) => `+line ${i}`))]);
    expect(long).toContain("+line 19");
    expect(long).not.toContain("+line 20");
    expect(pullMaterial([], Array.from({ length: 40 }, (_, i) => file(`f${i}.ts`, Array.from({ length: 20 }, () => "+" + "x".repeat(200))))).length).toBeLessThanOrEqual(6000);
  });

  it("sends the name of a file that holds keys and none of its lines", () => {
    const line = "+the shop door code is plain-words-no-masker-knows";
    for (const path of [".env", "apps/api/.env.production", ".npmrc", "deploy/id_ed25519", "certs/server.pem", "ios/release.keystore", "config/secrets.yaml", "aws/credentials"]) {
      expect(holdsKeys(path), path).toBe(true);
      const m = pullMaterial([], [{ path, kind: "add", added: 1, removed: 0, lines: [line] }]);
      expect(m, path).toContain(`add ${path} (+1 -0)`);
      expect(m, path).not.toContain("plain-words-no-masker-knows");
    }
    for (const path of ["src/environment.ts", "docs/keys.md", "src/env/index.ts", "README.md"]) expect(holdsKeys(path), path).toBe(false);
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
    expect(termMenuItems({ cwd: "", linkId: undefined }, undefined, true)).toEqual(["rename", "retitle", "here", "close"]);
    expect(termMenuItems({ cwd: "", linkId: undefined })).toEqual(["rename", "here", "close"]);
  });
});
