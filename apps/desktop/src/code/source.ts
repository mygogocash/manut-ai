// Source control (item 75): what the shell says about git, gh and glab (src-tauri/src/source_tools.rs), what a pull of a project's
// default branch did (git_pull.rs), and the asks that put a lane up for review and merge its pull request (review.rs). Each answer
// is read here before it is believed, as the lanes' answers are (laneBranch.ts): a field that is not what the shell sends reads as
// nothing, never as a guess.

/** One account a CLI is signed in to: its name, its host when it is not the usual one ("" for github.com and gitlab.com). */
export interface SourceAccount {
  name: string;
  host: string;
  active: boolean;
}

/** One program on Settings › Source control. `signedIn` is null for git, which has no sign-in. */
export interface SourceTool {
  installed: boolean;
  version: string;
  signedIn: boolean | null;
  accounts: SourceAccount[];
}

export interface SourceTools {
  git: SourceTool;
  github: SourceTool;
  gitlab: SourceTool;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const MISSING: SourceTool = { installed: false, version: "", signedIn: null, accounts: [] };

function readTool(v: unknown, cli: boolean): SourceTool {
  if (!isObj(v)) return { ...MISSING, signedIn: cli ? false : null };
  const accounts = Array.isArray(v.accounts)
    ? v.accounts.flatMap((a) => (isObj(a) && str(a.name) ? [{ name: str(a.name), host: str(a.host), active: a.active === true }] : []))
    : [];
  return {
    installed: v.installed === true,
    // only a version's digits and dots are shown
    version: /^\d+(\.\d+)+$/.test(str(v.version)) ? str(v.version) : "",
    signedIn: cli ? v.signed_in === true : null,
    accounts: cli ? accounts : [],
  };
}

/** The shell's `source_tools` answer, read field by field. */
export function readTools(v: unknown): SourceTools {
  const o = isObj(v) ? v : {};
  return { git: readTool(o.git, false), github: readTool(o.github, true), gitlab: readTool(o.gitlab, true) };
}
