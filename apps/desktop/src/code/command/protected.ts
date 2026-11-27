// The files a change to which always asks: the folders, files and names that make a program run later or change what an agent may do.
// Its own file so the list is read in one place and a reviewer of the safety rule need open nothing else.
import { parts, resolve, within } from "./paths";
import { type Where } from "./types";

/** Folders whose files make a program run later or change what an agent may do: git's own; the agents' settings,
 *  instructions, skills, commands and plugins (for every agent the app starts, `src-tauri/src/agent_chat.rs`,
 *  `acp_agents.rs`, `lane_config.rs`); hooks a tool on the person's side runs (husky, a hooks folder, CI, an editor's
 *  tasks, a dev container); and the package managers' and cargo's own settings, which name what runs every script. */
const GUARDED_DIRS = new Set([
  ".git", ".claude", ".codex", ".agents", ".agent", ".cursor", ".gemini", ".qwen", ".kimi", ".opencode", ".pi", ".omp", ".clinerules",
  ".cline", ".copilot", ".github", ".husky", ".githooks", ".vscode", ".idea", ".devcontainer", ".zed", ".helix", ".fleet", ".yarn",
  ".circleci", ".buildkite", ".gitlab", ".mise", ".cargo",
]);

/** Files of the same kinds, in any folder, and package.json, Makefile and the like, whose scripts a check and Preview's
 *  Start run by a name that says nothing of what they do. */
const GUARDED_FILES = new Set([
  ".mcp.json", "claude.md", "claude.local.md", "agents.md", "agents.override.md", "gemini.md", "qwen.md", ".cursorrules", "opencode.json",
  "opencode.jsonc", ".envrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".yarnrc.yaml", "pnpm-workspace.yaml", "bunfig.toml", ".bunfig.toml",
  "package.json", ".gitmodules", ".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml",
  "lefthook-local.yml", "lefthook-local.yaml", ".simple-git-hooks.json", ".simple-git-hooks.js", ".simple-git-hooks.cjs",
  "simple-git-hooks.json", ".gitlab-ci.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "jenkinsfile", "makefile",
  "gnumakefile", "justfile", ".justfile", "taskfile.yml", "taskfile.yaml", "taskfile.dist.yml", "taskfile.dist.yaml", "mise.toml",
  ".mise.toml", "mise.local.toml", ".mise.local.toml", "composer.json", "deno.json", "deno.jsonc", "project.json", "nx.json", "turbo.json",
  ".nvim.lua", ".nvimrc", ".exrc",
]);

const GUARDED_NAMES = [/^\.pnpmfile\./, /^\.lintstagedrc/, /^lint-staged\.config\./, /\.code-workspace$/, /^\.?mise\..+\.toml$/];

/** Whether `root` is a lane's own working folder in the app's folder: exactly two names below `.manut/lanes`
 *  (`~/.manut/lanes/<project>/<words>`, src-tauri/src/lane.rs). */
const laneFolder = (root: string) => {
  const r = parts(root).list.map(fold);
  const k = r.lastIndexOf(".manut");
  return k >= 0 && r[k + 1] === "lanes" && r.length === k + 4;
};

/** Whether `path` is in the app's own storage, which holds what the app runs and trusts later: its workflows, the lanes'
 *  records, the accounts, the providers' settings, the terminals' history, and the web view's own data and caches. All of
 *  `.manut` is, but for the folder the session itself works in when that is a lane's own: every other lane's folder, and
 *  everything above the lane, is the app's. A name in another letter case is never the session's own folder. */
function appOwn(path: string, root: string): boolean {
  const full = parts(path).list.map(fold);
  for (let i = 0; i + 2 < full.length; i++) if (full[i] === "library" && (full[i + 1] === "webkit" || full[i + 1] === "caches") && full[i + 2] === "xyz.manut.desktop") return true;
  if (!full.includes(".manut")) return false;
  return !(laneFolder(root) && within(path, root));
}

/** A file name as a disk that ignores letter case compares it (macOS's, by default): upper case and back folds the
 *  Kelvin sign and the long s as that disk does. A Windows disk also drops dots and spaces at a name's end and reads
 *  `name::$DATA` as the file itself. */
const fold = (part: string) => part.normalize("NFC").toUpperCase().toLowerCase().replace(/:.*$/, "").replace(/[. ]+$/, "");

/** Whether a change to `written` is one the dial never lets go alone: a path into one of the folders above or to one of
 *  the files, compared after `.` and `..` are taken out and by name whatever its letter case, from the project's folder
 *  (a project kept inside a folder of that name is not one). A Windows short name (`PACKAG~1.JSO`) may be any of them. */
export function guardedPath(written: string, where: Pick<Where, "cwd" | "root" | "home">): boolean {
  const abs = resolve(written, where.cwd, where.home);
  if (appOwn(abs ?? written, where.root)) return true;
  const p = parts(abs ?? written);
  const r = parts(where.root);
  const inside = abs !== null && within(abs, where.root);
  const list = (inside ? p.list.slice(r.list.length) : p.list).map(fold);
  if (list.some((x) => GUARDED_DIRS.has(x) || /~[0-9]/.test(x))) return true;
  const name = list[list.length - 1] ?? "";
  return GUARDED_FILES.has(name) || GUARDED_NAMES.some((re) => re.test(name));
}
