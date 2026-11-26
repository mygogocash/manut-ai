// A bundle of skills shared by a link (item 84; docs/pilot-api.md, "Skill links"): one or more skill folders, each a name and its
// text files. A skill tells a coding agent what to do and its folder can hold scripts, so this is the most careful sharing in the
// app. The rules here are the API's own (apps/api/src/artifact-store.ts) and the shell's (src-tauri/src/skill_links.rs), kept
// here so nothing the API would refuse is ever asked about, and so the page can say which file stops a bundle before anything is
// sent:
// - a name is one plain folder name, a path is plain and relative (no `..`, no absolute path, no dot-file), a file is text;
// - the whole manifest, as stored, is at most the pages' 128 KiB;
// - a file in which the app's one key masker (src/lib/secrets.ts) finds a key cannot be published at all, and the page names the
//   file and says to take the key out, never showing it;
// - a skill with something a coding agent would act on by itself, without its prompt (`fileActsAlone`, below), is neither
//   published nor installed, and the page names its file and setting (item 113).
import { maskSecrets } from "../lib/secrets";
import { MAX_ARTIFACT_BYTES, utf8Bytes } from "./artifacts";

export const MAX_SKILLS = 20;
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_PATH = 200;
export const SKILL_FILE = "SKILL.md";

export interface SkillFile {
  path: string;
  text: string;
}

export interface SkillEntry {
  name: string;
  files: SkillFile[];
}

/** Why a bundle cannot be published or installed, with the skill and file it is about when there is one. */
export interface BundleRefusal {
  reason: string;
  skill?: string;
  path?: string;
  /** for `acts_alone`: what in the file an agent would act on by itself (`field`, `command`, `unreadable`) */
  why?: ActsAlone["why"];
  /** for `acts_alone` by a setting: the setting's name */
  field?: string;
}

/** A skill's name, which is the one folder it is installed as. */
export function isSkillName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && !value.includes("..");
}

/** Why `path` is not a plain relative path inside a skill (`dot_file` for a dot-file or dot-folder, `bad_path` otherwise), or null. */
export function skillPathRefusal(path: unknown): "bad_path" | "dot_file" | null {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_SKILL_PATH) return "bad_path";
  if (/[\\:\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path) || path.startsWith("/")) return "bad_path";
  const steps = path.split("/");
  if (steps.some((step) => step === "" || step === "." || step === "..")) return "bad_path";
  if (steps.some((step) => step.startsWith("."))) return "dot_file";
  return null;
}

const BINARY = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Why `skills` cannot be a bundle, as the API says it, or null. */
export function skillsRefusal(skills: unknown): BundleRefusal | null {
  if (!Array.isArray(skills) || skills.length === 0) return { reason: "no_skills" };
  if (skills.length > MAX_SKILLS) return { reason: "too_many_skills" };
  const names = new Set<string>();
  let count = 0;
  for (const skill of skills as SkillEntry[]) {
    if (!skill || typeof skill !== "object" || !Array.isArray(skill.files)) return { reason: "invalid_skills" };
    if (!isSkillName(skill.name)) return { reason: "bad_name" };
    if (names.has(skill.name.toLowerCase())) return { reason: "duplicate_name", skill: skill.name };
    names.add(skill.name.toLowerCase());
    count += skill.files.length;
    if (count > MAX_SKILL_FILES) return { reason: "too_many_files" };
    const paths = new Set<string>();
    for (const file of skill.files) {
      if (!file || typeof file.text !== "string") return { reason: "invalid_skills", skill: skill.name };
      const bad = skillPathRefusal(file.path);
      if (bad) return { reason: bad, skill: skill.name, path: String(file.path) };
      if (paths.has(file.path.toLowerCase())) return { reason: "duplicate_path", skill: skill.name, path: file.path };
      paths.add(file.path.toLowerCase());
      if (BINARY.test(file.text)) return { reason: "binary_file", skill: skill.name, path: file.path };
    }
    for (const path of paths) {
      const steps = path.split("/");
      for (let i = 1; i < steps.length; i++) {
        if (paths.has(steps.slice(0, i).join("/"))) return { reason: "duplicate_path", skill: skill.name, path: steps.slice(0, i).join("/") };
      }
    }
    if (!skill.files.some((file) => file.path === SKILL_FILE)) return { reason: "no_skill_md", skill: skill.name };
  }
  return null;
}

/** The manifest as the API stores it and counts it against the cap. */
export const skillsText = (skills: readonly SkillEntry[]): string =>
  JSON.stringify({ skills: skills.map((s) => ({ name: s.name, files: s.files.map((f) => ({ path: f.path, text: f.text })) })) });

/** A bundle's size as stored, in UTF-8 bytes. */
export const bundleBytes = (skills: readonly SkillEntry[]): number => utf8Bytes(skillsText(skills));

/** The files in which the key masker finds a key: any one of them stops the publish. Only the skill and the path come back, never
 *  the key. */
export function secretFiles(skills: readonly SkillEntry[]): { skill: string; path: string }[] {
  return skills.flatMap((s) => s.files.filter((f) => maskSecrets(f.text) !== f.text).map((f) => ({ skill: s.name, path: f.path })));
}

// ---- what a coding agent would act on by itself (item 113) -----------------------------------------------------------------
//
// A skill is instructions, and every step an agent takes from them asks as usual. Some of what a skill's files can hold is acted on
// by the agent itself, before or without that prompt, so Kit's dial never sees it. Claude Code's own documentation
// (code.claude.com/docs/en/skills, read 26 Nov 2026) names these: `allowed-tools` (tools used without asking), `hooks` (commands
// registered for the rest of the session), a command run while the skill loads (`!` then a backtick, or a fence opened with
// "```!"), and settings that start a subagent, change the model or the effort. Codex reads `agents/openai.yaml` beside a skill,
// whose `dependencies` declare tools such as an MCP server at an address. None of that is installed from a link, and none is
// published, since no one could install it. The rule is an allow-list: a setting is taken only when it is named below as one that
// describes the skill or only narrows when it is used; anything else, and any top this cannot read as plain settings, is refused by
// name. src-tauri/src/skill_links.rs keeps the same rule, and skillActs.cases.json is the table both run.

/** The settings at the top of a skill's markdown that only describe it or narrow when it is used. Claude Code's documentation:
 *  `name`, `description` and `when_to_use` are text; `argument-hint` is shown while typing; `disable-model-invocation` and
 *  `user-invocable` only take a way of starting the skill away; `license`, `compatibility` and `metadata` are not acted on. */
export const HARMLESS_FIELDS: ReadonlySet<string> = new Set([
  "name", "description", "when_to_use", "argument-hint", "disable-model-invocation", "user-invocable", "license", "compatibility", "metadata",
]);

/** The settings of a Codex `agents/openai.yaml` that only change how the skill is shown. `policy` and `dependencies` are not. */
export const HARMLESS_AGENT_FIELDS: ReadonlySet<string> = new Set(["interface"]);

/** Why a file of a skill would be acted on by an agent by itself: a setting not on the harmless list (`field`, named), a command
 *  run when the skill loads (`command`), or a top that cannot be read as plain settings (`unreadable`). */
export interface ActsAlone {
  why: "field" | "command" | "unreadable";
  field?: string;
}

const MARKDOWN = /\.(md|markdown|mdx)$/i;
const AGENT_YAML = /(^|\/)agents\/[^/]+\.ya?ml$/i;
/** Every line break a YAML or JavaScript reader may take as one, so a setting hidden behind a rarer break is still read. */
const BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;
/** Blank: JavaScript's `\s` and NEL, the same set as Rust's `char::is_whitespace` and the BOM. */
const BLANK = /^[\s\u0085]*$/;
/** Space within a line: blank, but no line break. */
const SPACE = "[\\t \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\ufeff]";
/** `!` then a backtick, with only space between: Claude Code's command run as a skill loads. Taken anywhere in the text, though
 *  Claude Code itself runs it only at a line's start or after a space, since a reading that is wider only refuses more. */
const BANG_TICK = new RegExp(`!${SPACE}*\``);
/** A fence of three or more backticks or tildes whose word starts with `!`: the many-line form of the same. */
const BANG_FENCE = new RegExp(`(\`{3,}|~{3,})${SPACE}*!`);
/** One plain setting at the top: a name of letters, digits, `_` and `-`, then a colon and a space or the line's end. */
const SETTING = /^([A-Za-z][A-Za-z0-9_-]{0,63})[ \t]*:(?:[ \t]|$)/;

/** The settings of `lines` from `from`, each held to `allowed`, until a line that is exactly `---` (when `fenced`) or the end
 *  (when not). A line this cannot read as a plain setting, a comment, a blank or an indented part of the setting above is
 *  `unreadable`, and so is a fenced top that never closes. */
function settingsRefusal(lines: readonly string[], from: number, fenced: boolean, allowed: ReadonlySet<string>): ActsAlone | null {
  let named = false;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (fenced && line === "---") return null;
    if (BLANK.test(line)) continue;
    if (line.startsWith("---") || line.startsWith("...")) return { why: "unreadable" };
    if (line.startsWith(" ")) {
      if (!named) return { why: "unreadable" };
      continue;
    }
    if (line.startsWith("#")) continue;
    const m = SETTING.exec(line);
    if (!m) return { why: "unreadable" };
    if (!allowed.has(m[1]!)) return { why: "field", field: m[1]! };
    named = true;
  }
  return fenced ? { why: "unreadable" } : null;
}

/** What in file `path` of a skill an agent would act on by itself, or null: the settings at the top of any markdown file and any
 *  command run as it loads, and the settings of a Codex `agents/*.yaml`. Every other file is text the agent may read or a script
 *  it may ask to run, and each such step asks as usual. */
export function fileActsAlone(path: string, text: string): ActsAlone | null {
  const markdown = MARKDOWN.test(path);
  const agentYaml = AGENT_YAML.test(path);
  if (!markdown && !agentYaml) return null;
  const lines = text.replace(/^\ufeff+/, "").split(BREAK);
  const first = lines.findIndex((l) => !BLANK.test(l));
  if (agentYaml) {
    if (first < 0) return null;
    const top = lines[first]!;
    if (top.startsWith("---") && top !== "---") return { why: "unreadable" };
    return settingsRefusal(lines, top === "---" ? first + 1 : first, false, HARMLESS_AGENT_FIELDS);
  }
  if (first >= 0) {
    const top = lines[first]!.replace(/^[\s\u0085]+/, "");
    if (top.startsWith("---")) {
      if (top !== "---") return { why: "unreadable" };
      const refused = settingsRefusal(lines, first + 1, true, HARMLESS_FIELDS);
      if (refused) return refused;
    }
  }
  return BANG_TICK.test(text) || BANG_FENCE.test(text) ? { why: "command" } : null;
}

/** The first file of `skill`, in its order, that an agent would act on by itself, with why. */
export function skillActsAlone(skill: SkillEntry): ({ path: string } & ActsAlone) | null {
  for (const f of skill.files) {
    const acts = fileActsAlone(f.path, f.text);
    if (acts) return { path: f.path, ...acts };
  }
  return null;
}

/** Every skill of `skills` an agent would act on by itself, each with its first such file: any one stops a publish, and none is
 *  installed. */
export function actsAloneSkills(skills: readonly SkillEntry[]): ({ skill: string; path: string } & ActsAlone)[] {
  return skills.flatMap((s) => {
    const acts = skillActsAlone(s);
    return acts ? [{ skill: s.name, ...acts }] : [];
  });
}

/** File endings that are programs or scripts a computer can run. */
const SCRIPT_ENDINGS = new Set([
  "sh", "bash", "zsh", "fish", "ksh", "csh", "command", "py", "pyw", "rb", "pl", "pm", "php", "js", "mjs", "cjs", "ts", "mts", "cts",
  "jsx", "tsx", "ps1", "psm1", "bat", "cmd", "vbs", "applescript", "scpt", "swift", "go", "rs", "lua", "r", "jl", "tcl", "awk",
  "exe", "app", "jar", "wasm", "dll", "so", "dylib", "bin", "run", "deb", "pkg", "dmg", "msi",
]);

/** Whether a file is a script or a program the agent may ask to run: in a `scripts` or `bin` folder (in any letter case, as a
 *  Mac's disk finds it), by its ending, a `#!` first line, or its executable bit. */
export function isScript(path: string, text: string, exec = false): boolean {
  if (exec || text.startsWith("#!")) return true;
  const steps = path.split("/");
  if (steps.slice(0, -1).some((s) => s.toLowerCase() === "scripts" || s.toLowerCase() === "bin")) return true;
  const name = steps.pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && SCRIPT_ENDINGS.has(name.slice(dot + 1).toLowerCase());
}

/** What one bundle publish shows, and all that is published when its ask is settled with a yes (src/runtime/artifactAsks.ts). */
export interface SkillsPlan {
  /** the shop it is published for, as `artifacts.list` named it */
  shop: string;
  title: string;
  skills: SkillEntry[];
  /** the manifest's size in UTF-8 bytes */
  bytes: number;
  /** each file that is a script or a program, as `skill/path` */
  scripts: string[];
}

/** What a bundle publish sends, exactly. */
export const skillsBody = (plan: Pick<SkillsPlan, "title" | "skills">) => ({
  title: plan.title.trim(),
  kind: "skills" as const,
  skills: plan.skills.map((s) => ({ name: s.name, files: s.files.map((f) => ({ path: f.path, text: f.text })) })),
});

/** Why a bundle may not be published, by its code, or null: the API's own rules, a key in any file (`secret`), or over the cap. */
export function skillsPlanRefusal(plan: Pick<SkillsPlan, "title" | "skills">): BundleRefusal | null {
  const refused = skillsRefusal(plan.skills);
  if (refused) return refused;
  const secret = secretFiles(plan.skills)[0];
  if (secret) return { reason: "secret", ...secret };
  // Shared, it could only be refused at every install, so it is not published either.
  const acts = actsAloneSkills(plan.skills)[0];
  if (acts) return { reason: "acts_alone", ...acts };
  if (bundleBytes(plan.skills) > MAX_ARTIFACT_BYTES) return { reason: "too_large" };
  return null;
}

/** Whether a file is the skill's own instructions, which the agent follows: its top `SKILL.md`. */
export const isInstructions = (path: string): boolean => path === SKILL_FILE;

/** Every file of a bundle as `skill/path`, the key each review mark is kept under. */
export const fileKeys = (skills: readonly SkillEntry[]): string[] => skills.flatMap((s) => s.files.map((f) => `${s.name}/${f.path}`));

// ---- what the shell answers (src-tauri/src/skill_links.rs), read field by field -------------------------------------------

/** One of the person's own skill folders as the shell read it: its files with their size and executable bit, the files that stop
 *  it being published (`why`: `link`, `binary`, `too_large`, `special`, `bad_path`, `too_many`, `too_deep`, `unreadable`), and the
 *  dot-files left out. */
export interface ReadSkill {
  name: string;
  files: { path: string; text: string; bytes: number; exec: boolean }[];
  refused: { path: string; why: string }[];
  leftOut: string[];
}

/** A bundle the shell fetched from a link and keeps under `read`, which an install names. */
export interface LinkRead {
  read: string;
  title: string;
  skills: SkillEntry[];
}

/** The shell's ask to install skills: for `agent`, into `folder`, each skill as a new folder. */
export interface InstallAsk {
  id: string;
  agent: "claude" | "codex";
  folder: string;
  skills: { name: string; files: { path: string; bytes: number }[] }[];
}

/** What a settled install did. */
export interface InstallDone {
  outcome: "declined" | "installed" | "failed";
  installed: string[];
  failed?: string;
  why?: string;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `skill_bundle_read`'s answer; a skill this build cannot read whole makes the answer unreadable (null). */
export function readSkillReads(raw: unknown): ReadSkill[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ReadSkill[] = [];
  for (const r of raw) {
    if (!obj(r) || !isSkillName(r.name)) return null;
    const files = arr(r.files).map((f) => (obj(f) && str(f.path) && str(f.text) ? { path: f.path, text: f.text, bytes: Number(f.bytes) || 0, exec: f.exec === true } : null));
    const refused = arr(r.refused).map((f) => (obj(f) && str(f.path) && str(f.why) ? { path: f.path, why: f.why } : null));
    if (files.includes(null) || refused.includes(null)) return null;
    out.push({ name: r.name, files: files as ReadSkill["files"], refused: refused as ReadSkill["refused"], leftOut: arr(r.left_out).filter(str) });
  }
  return out;
}

/** `skill_link_read`'s answer, held to the bundle rules once more, or null. */
export function readLinkRead(raw: unknown): LinkRead | null {
  if (!obj(raw) || !str(raw.read) || !str(raw.title) || skillsRefusal(raw.skills) !== null) return null;
  return { read: raw.read, title: raw.title, skills: (raw.skills as SkillEntry[]).map((s) => ({ name: s.name, files: s.files.map((f) => ({ path: f.path, text: f.text })) })) };
}

/** `skill_install_ask`'s answer, or null. */
export function readInstallAsk(raw: unknown): InstallAsk | null {
  if (!obj(raw) || !str(raw.id) || !str(raw.folder) || (raw.agent !== "claude" && raw.agent !== "codex")) return null;
  const skills = arr(raw.skills).map((s) =>
    obj(s) && isSkillName(s.name) ? { name: s.name, files: arr(s.files).flatMap((f) => (obj(f) && str(f.path) ? [{ path: f.path, bytes: Number(f.bytes) || 0 }] : [])) } : null,
  );
  if (skills.length === 0 || skills.includes(null)) return null;
  return { id: raw.id, agent: raw.agent, folder: raw.folder, skills: skills as InstallAsk["skills"] };
}

/** `skill_install_settle`'s answer, or null. */
export function readInstallDone(raw: unknown): InstallDone | null {
  if (!obj(raw) || (raw.outcome !== "declined" && raw.outcome !== "installed" && raw.outcome !== "failed")) return null;
  return { outcome: raw.outcome, installed: arr(raw.installed).filter(str), ...(str(raw.failed) ? { failed: raw.failed } : {}), ...(str(raw.why) ? { why: raw.why } : {}) };
}
