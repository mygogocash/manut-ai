/// Chooses the command that starts a JavaScript project's preview
/// (docs/code-editor.md, "Left for later").
///
/// Text in, value out: this reads no file, runs nothing and never throws. The
/// answer is a list of words, never one string for a shell, so nothing in the
/// project's text can be read as shell syntax by the caller.

export type Manager = "pnpm" | "yarn" | "bun" | "npm";

export interface PreviewInput {
  /// The text of the project's `package.json`, or null when it has none.
  packageJson: string | null;
  /// The names of the files at the project's root.
  files: readonly string[];
}

export type NoneWhy = "no_package_json" | "unreadable" | "no_script" | "refused";

export type PreviewCommand =
  | { argv: [Manager, "run", string]; manager: Manager; script: string }
  | { none: NoneWhy };

/// In the order they are tried.
const SCRIPTS = ["dev", "start", "preview", "serve"] as const;

/// First match wins.
const LOCKFILES: ReadonlyArray<readonly [string, Manager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
];

const MANAGERS: readonly string[] = ["pnpm", "yarn", "bun", "npm"];

/// A script that publishes would make the preview deploy something. The
/// check is on the script's text, so a script that calls another script by
/// name (`npm run deploy`) is caught by the word in it.
function publishes(text: string): boolean {
  const t = text.toLowerCase();
  if (/deploy|publish|release|gh-pages/.test(t)) return true;
  if (/\bvercel\b/.test(t) && /--prod\b/.test(t)) return true;
  if (/\bnetlify\b/.test(t) && /--prod\b/.test(t)) return true;
  return false;
}

function managerOf(pkg: Record<string, unknown>, files: readonly string[]): Manager {
  // The field wins over the lockfile. A manager this does not run (deno, an
  // empty or odd value) is ignored so the lockfile decides.
  const field = pkg["packageManager"];
  if (typeof field === "string") {
    const name = field.split("@")[0]?.trim().toLowerCase() ?? "";
    if (MANAGERS.includes(name)) return name as Manager;
  }
  const have = new Set(files);
  for (const [file, manager] of LOCKFILES) if (have.has(file)) return manager;
  return "npm";
}

export function previewCommand(input: PreviewInput): PreviewCommand {
  if (input.packageJson === null || input.packageJson === undefined) return { none: "no_package_json" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.packageJson);
  } catch {
    return { none: "unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { none: "unreadable" };
  const pkg = parsed as Record<string, unknown>;

  const scripts = pkg["scripts"];
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return { none: "no_script" };
  const table = scripts as Record<string, unknown>;

  let found = false;
  for (const name of SCRIPTS) {
    if (!Object.hasOwn(table, name)) continue;
    const text = table[name];
    if (typeof text !== "string" || text.trim() === "") continue;
    found = true;
    if (publishes(text)) continue;
    const manager = managerOf(pkg, input.files);
    return { argv: [manager, "run", name], manager, script: name };
  }
  return { none: found ? "refused" : "no_script" };
}
