// The plain-text report behind Settings › Report a problem (item 105), the pure half. It says what a person's own coding
// agent, or a maintainer, needs to start: the app's version and edition, the macOS version and chip, each coding agent's
// version and whether it is signed in (yes or no, never an account), git's version, the last problems and the switches
// that change behaviour.
//
// What it never holds, whatever it is given: an account id, an email, a shop name, chat text, a prompt or a file's
// contents. Two things make that so. The builder reads only the named fields below, so a field a caller adds is not
// copied. And every line it writes is cleaned: `maskSecrets` (the app's one masker) first, then email addresses, the
// person's home folder as `~` (and any other `/Users/<name>` or `/home/<name>`), and any long quoted stretch, which is
// where a message that quotes a prompt would put it.
import { maskSecrets } from "../lib/secrets";

export interface ReportAgent {
  /** The agent's own name (Claude Code), never the name the person gave it. */
  label: string;
  installed: boolean;
  version: string;
  /** null: this app cannot tell (only Claude Code and Codex have a sign-in it can read). */
  signedIn: boolean | null;
}

export interface ReportInput {
  app: string;
  edition: "github" | "app-store";
  macos: string;
  chip: string;
  agents: ReportAgent[];
  git: { installed: boolean; version: string };
  errors: { at: number; source: string; text: string }[];
  switches: { label: string; on: boolean }[];
  /** The person's home folder, replaced by `~` wherever it appears. */
  home: string;
}

/** How many problems the report shows. */
export const MAX_ERRORS = 20;
/** A quoted stretch longer than this is dropped: it is text someone wrote, not a cause. */
const QUOTE_MAX = 24;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` made safe to put in a report: one pass of the app's masker, then the rest. */
export function clean(text: string, home: string): string {
  let s = maskSecrets(text);
  const h = home.replace(/\/+$/, "");
  if (h.length > 1) s = s.replace(new RegExp(`${escape(h)}(?=$|[/\\s"'),:;])`, "g"), "~");
  s = s.replace(/\/(?:Users|home)\/[^/\s"'),:;]+/g, "~");
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[email]");
  s = s.replace(/"([^"\n]*)"/g, (all, inner: string) => (inner.length > QUOTE_MAX ? '"[text]"' : all));
  return s.replace(/\s+/g, " ").trim();
}

/** `2026-11-26 10:15 UTC`: the same in every time zone, so a report reads the same wherever it is opened. */
export function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const word = (v: string, home: string): string => clean(v, home).slice(0, 40) || "unknown";

/** The report, as plain text. */
export function buildReport(i: ReportInput): string {
  const home = i.home;
  const out: string[] = [];
  out.push("Manut AI problem report");
  out.push("");
  out.push(`App: Manut AI ${word(i.app, home)} (${i.edition === "app-store" ? "Mac App Store" : "GitHub"})`);
  out.push(`macOS: ${word(i.macos, home)}`);
  out.push(`Chip: ${word(i.chip, home)}`);
  out.push(`git: ${i.git.installed ? word(i.git.version, home) : "not installed"}`);
  out.push("");
  out.push("Coding agents:");
  for (const a of i.agents) {
    const state = !a.installed ? "not installed" : `${word(a.version, home)}, ${a.signedIn === null ? "sign-in not checked" : a.signedIn ? "signed in" : "not signed in"}`;
    out.push(`- ${clean(a.label, home).slice(0, 40)}: ${state}`);
  }
  if (i.agents.length === 0) out.push("- none found");
  out.push("");
  out.push("Switches:");
  for (const s of i.switches) out.push(`- ${clean(s.label, home).slice(0, 60)}: ${s.on ? "on" : "off"}`);
  out.push("");
  const errors = i.errors.slice(0, MAX_ERRORS);
  out.push(errors.length ? `Last problems (newest first, ${errors.length}):` : "Last problems: none since this run started");
  for (const e of errors) out.push(`- ${stamp(e.at)} ${clean(e.source, home).slice(0, 12)}: ${clean(e.text, home).slice(0, 200)}`);
  out.push("");
  out.push("Nothing else is included: no accounts, emails, chats, prompts or file contents.");
  return out.join("\n");
}

/** The title and body of a new issue: the first line of the report names the app, the body is the whole report. */
export function issueOf(report: string, app: string): { title: string; body: string } {
  return { title: `Problem report: Manut AI ${app}`, body: report };
}

/** The address of the repository's new-issue page with the title and body filled in. `repo` is `owner/name`, read from the
 *  updater's own address (`repoOf`), never typed here. GitHub reads long text in the address, but a very long one is refused, so
 *  the body is cut to `BODY_MAX` characters with a line saying so. */
export const BODY_MAX = 6000;
export function issueUrl(repo: string, issue: { title: string; body: string }): string {
  const body = issue.body.length > BODY_MAX ? `${issue.body.slice(0, BODY_MAX)}\n\n[cut: the rest of the report was copied, not sent]` : issue.body;
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(issue.title)}&body=${encodeURIComponent(body)}`;
}

/** `owner/name` from a GitHub address such as the updater's (`https://github.com/owner/name/releases/...`), else null. */
export function repoOf(url: string): string | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}
