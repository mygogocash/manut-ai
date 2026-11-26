// A bundle of skills (skillBundle.ts, item 84): the page keeps the API's own rules, so a path with `..`, an absolute path and a
// dot-file are refused here as there; a key in any file stops the publish and is named, never shown; scripts are marked by their
// ending, a `#!` first line or an executable bit; and what the shell answers is read field by field, held to the rules again.
import { describe, expect, it } from "vitest";
import { MAX_ARTIFACT_BYTES } from "./artifacts";
import {
  bundleBytes,
  isScript,
  readInstallAsk,
  readLinkRead,
  readSkillReads,
  secretFiles,
  skillPathRefusal,
  skillsPlanRefusal,
  skillsRefusal,
  type SkillEntry,
} from "./skillBundle";

const SKILL: SkillEntry = { name: "promptpay", files: [{ path: "SKILL.md", text: "---\nname: promptpay\n---\n" }, { path: "scripts/qr.py", text: "print(1)\n" }] };
const KEY = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describe("a bundle's rules", () => {
  it("takes plain relative paths only, as the API does", () => {
    for (const ok of ["SKILL.md", "scripts/qr.py", "a/b/c.txt"]) expect(skillPathRefusal(ok), ok).toBeNull();
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "./x", "a//b", "", "a\\b", "C:/x", "x\u2028y"]) expect(skillPathRefusal(bad), bad).toBe("bad_path");
    for (const dot of [".env", "a/.git/config"]) expect(skillPathRefusal(dot), dot).toBe("dot_file");
  });

  it("refuses a binary file, a skill with no SKILL.md, and clashing names and paths", () => {
    expect(skillsRefusal([SKILL])).toBeNull();
    expect(skillsRefusal([{ name: "x", files: [{ path: "SKILL.md", text: "x" }, { path: "logo.png", text: "\u0000PNG" }] }]))
      .toEqual({ reason: "binary_file", skill: "x", path: "logo.png" });
    expect(skillsRefusal([{ name: "x", files: [{ path: "README.md", text: "x" }] }])).toEqual({ reason: "no_skill_md", skill: "x" });
    expect(skillsRefusal([SKILL, { ...SKILL, name: "PromptPay" }])).toEqual({ reason: "duplicate_name", skill: "PromptPay" });
    expect(skillsRefusal([{ name: "..", files: SKILL.files }])).toEqual({ reason: "bad_name" });
    expect(skillsRefusal([{ name: "x", files: [...SKILL.files, { path: "../../.zshrc", text: "rm -rf ~" }] }])).toMatchObject({ reason: "bad_path" });
  });

  it("stops a publish for a key in any file, naming every such file and never the key", () => {
    const leaky: SkillEntry = { name: "deploy", files: [{ path: "SKILL.md", text: "Deploy it." }, { path: "notes.md", text: `use ${KEY} to push` }] };
    expect(secretFiles([SKILL, leaky])).toEqual([{ skill: "deploy", path: "notes.md" }]);
    const refused = skillsPlanRefusal({ title: "Mine", skills: [SKILL, leaky] });
    expect(refused).toEqual({ reason: "secret", skill: "deploy", path: "notes.md" });
    expect(JSON.stringify(refused)).not.toContain(KEY);
    expect(skillsPlanRefusal({ title: "Mine", skills: [{ name: "x", files: [{ path: "SKILL.md", text: "api_key=abc123def456" }] }] })?.reason).toBe("secret");
    expect(skillsPlanRefusal({ title: "Mine", skills: [SKILL] })).toBeNull();
    // the whole manifest counts against the pages' size
    const big: SkillEntry = { name: "big", files: [{ path: "SKILL.md", text: "a".repeat(MAX_ARTIFACT_BYTES) }] };
    expect(bundleBytes([big])).toBeGreaterThan(MAX_ARTIFACT_BYTES);
    expect(skillsPlanRefusal({ title: "Big", skills: [big] })).toEqual({ reason: "too_large" });
  });

  it("marks a script by its ending, a #! first line or its executable bit", () => {
    expect(isScript("scripts/qr.py", "print(1)")).toBe(true);
    expect(isScript("run", "#!/bin/sh\n")).toBe(true);
    expect(isScript("tool", "binary-ish text", true)).toBe(true);
    expect(isScript("SKILL.md", "---")).toBe(false);
    expect(isScript(".sh", "x")).toBe(false);
  });
});

describe("what the shell answers", () => {
  it("is read field by field, and a fetched bundle is held to the rules again", () => {
    expect(readSkillReads([{ name: "promptpay", files: [{ path: "SKILL.md", text: "x", bytes: 1, exec: false }], refused: [{ path: "a", why: "link" }], left_out: [".env"] }]))
      .toEqual([{ name: "promptpay", files: [{ path: "SKILL.md", text: "x", bytes: 1, exec: false }], refused: [{ path: "a", why: "link" }], leftOut: [".env"] }]);
    expect(readSkillReads([{ name: "../x", files: [], refused: [], left_out: [] }])).toBeNull();
    expect(readLinkRead({ read: "r1", title: "T", skills: [SKILL] })).toEqual({ read: "r1", title: "T", skills: [SKILL] });
    expect(readLinkRead({ read: "r1", title: "T", skills: [{ name: "x", files: [{ path: "SKILL.md", text: "x" }, { path: "/etc/x", text: "x" }] }] })).toBeNull();
    expect(readInstallAsk({ id: "a1", agent: "claude", folder: "~/.claude/skills", skills: [{ name: "promptpay", files: [{ path: "SKILL.md", bytes: 3 }] }] }))
      .toEqual({ id: "a1", agent: "claude", folder: "~/.claude/skills", skills: [{ name: "promptpay", files: [{ path: "SKILL.md", bytes: 3 }] }] });
    expect(readInstallAsk({ id: "a1", agent: "cursor", folder: "x", skills: [] })).toBeNull();
  });
});
