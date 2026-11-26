// A bundle of skills (skillBundle.ts, item 84): the page keeps the API's own rules, so a path with `..`, an absolute path and a
// dot-file are refused here as there; a key in any file stops the publish and is named, never shown; scripts are marked by their
// ending, a `#!` first line or an executable bit; and what the shell answers is read field by field, held to the rules again.
import { describe, expect, it } from "vitest";
import { MAX_ARTIFACT_BYTES } from "./artifacts";
import {
  bundleBytes,
  fileActsAlone,
  isInstructions,
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
import actsTable from "./skillActs.cases.json";

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
    // the forms the masker learned in item 113 stop a publish too: a key block, a header, a YAML password, a quoted key
    for (const text of [`-----BEGIN RSA PRIVATE KEY-----\n${"X".repeat(24)}\n-----END RSA PRIVATE KEY-----`, "Authorization: Bearer abc123def456",
      "db:\n  password: hunter2\n", 'export API_KEY="abc def"', "postgres://u:hunter2@db.test/x"]) {
      expect(secretFiles([{ name: "x", files: [{ path: "SKILL.md", text: "Plain." }, { path: "ref.md", text }] }]), text).toEqual([{ skill: "x", path: "ref.md" }]);
    }
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
    // anything in a scripts or bin folder is one the agent may ask to run, in any letter case
    for (const p of ["scripts/qr", "Scripts/notes.txt", "tools/bin/run", "a/SCRIPTS/b/c"]) expect(isScript(p, "plain"), p).toBe(true);
    for (const p of ["scripts", "references/scripts.md", "binary/notes.txt"]) expect(isScript(p, "plain"), p).toBe(false);
  });

  it("marks the top SKILL.md as the instructions the agent follows", () => {
    expect(isInstructions("SKILL.md")).toBe(true);
    for (const p of ["sub/SKILL.md", "README.md", "skill.md"]) expect(isInstructions(p), p).toBe(false);
  });
});

/** A one-file case of skillActs.cases.json as a skill: the file, beside a plain SKILL.md when it is not SKILL.md itself. */
const caseSkill = (path: string, text: string): SkillEntry => ({
  name: "x",
  files: path === "SKILL.md" ? [{ path, text }] : [{ path: "SKILL.md", text: "Plain instructions." }, { path, text }],
});

describe("a skill that a coding agent would act on by itself", () => {
  it("stops a publish for every row of the shared table (skillActs.cases.json, also run by skill_links.rs), naming the file and the field", () => {
    expect(actsTable.cases.length).toBeGreaterThan(60);
    for (const [path, text, why, field] of actsTable.cases) {
      const want = why === "" ? null : { reason: "acts_alone", skill: "x", path, why, ...(why === "field" ? { field } : {}) };
      expect(skillsPlanRefusal({ title: "t", skills: [caseSkill(path, text)] }), JSON.stringify([path, text])).toEqual(want);
      expect(fileActsAlone(path, text), JSON.stringify([path, text])).toEqual(why === "" ? null : { why, ...(why === "field" ? { field } : {}) });
    }
  });

  it("takes only the harmless settings: a skill with no settings, or name and description alone, installs", () => {
    expect(fileActsAlone("SKILL.md", "")).toBeNull();
    expect(fileActsAlone("SKILL.md", "---\nname: a\ndescription: b\n---\n")).toBeNull();
    // a setting not on the list is refused by name, even one that sounds harmless: what is not known is not taken
    expect(fileActsAlone("SKILL.md", "---\nname: a\nauthor: Mali\n---\n")).toEqual({ why: "field", field: "author" });
    // the same settings in a file no agent reads as a skill are text
    expect(fileActsAlone("data/config.json", "{\"allowed-tools\": \"Bash\"}")).toBeNull();
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
