// The App pages of Settings, by id and the name each shows. Kept apart from the page itself so the command palette can
// list them without loading every Settings page.
import type { Key } from "../i18n";
import type { IconName } from "../ui/icons";

/** A page, the name it shows and the icon of the set it leads with in Settings' list and the palette (item 122: every
 *  menu led by an icon; each drawing shows a thing the page is about). */
type Page = { id: string; label: Key; icon: IconName };

/** The everyday pages, which a person sees first in Settings' list (item 85h). */
export const EVERYDAY_PAGES: Page[] = [
  { id: "general", label: "set.general", icon: "gear" },
  // the chat box's microphone and voice mode: the language spoken, this Mac or Apple, the voice (VoicePage.tsx)
  { id: "voice", label: "set.voice", icon: "mic" },
  // reaching this Mac from a paired phone: the switch behind a consent sheet, off by default, pairing with the typed code,
  // the paired phones and Unpair (item 78b, RemotePage.tsx). An owner's page, not a developer's, so it is not under the hood.
  { id: "remote", label: "set.remote", icon: "smartphone" },
];

/** The developer pages, which live under one entry of Settings' list, "Under the hood" (the Voice board's words for
 *  logs, debug and trace), so an owner who is not technical never meets them unasked. Each keeps its id: a link to one
 *  (the palette, a page's own button) opens it and shows it inside its open entry. */
export const HOOD_PAGES: Page[] = [
  { id: "terminal", label: "set.terminal", icon: "terminal" },
  // every coding agent: on or off, its program, home, arguments and variables; your own agents; the accounts (item 74)
  { id: "providers", label: "set.providers", icon: "cube" },
  // computer use: the two macOS permissions, read without asking, and what the agent may look at and do (ComputerPage.tsx)
  { id: "computer", label: "set.computer", icon: "monitor" },
  // where lanes' folders are made, the remote start, the branch prefix and the clean-up (WorktreesPage.tsx)
  { id: "worktrees", label: "set.worktrees", icon: "folder" },
  // git, gh and glab with their versions and accounts, the default branch pulled when clean, how pull requests merge (item 75,
  // SourceControlPage.tsx)
  { id: "source", label: "set.source", icon: "git-branch" },
  // publishing HTML and Markdown files as public links: the one switch, off by default, and how it works (item 83,
  // ArtifactLinksPage.tsx)
  { id: "artifacts", label: "set.artifacts", icon: "link" },
  // the MCP servers and skills each coding agent has, read from its own files; changes nothing (mcp/McpSkillsPage.tsx)
  { id: "mcp", label: "set.mcp", icon: "plug" },
  // workflows run from files in ~/.manut/workflows: the switch, skipped runs kept, each workflow with Run now and its history
  // (item 77b, workflows/WorkflowsPage.tsx)
  { id: "workflows", label: "set.workflows", icon: "nodes" },
  // Practice or Connected, and signing in to the API (DeveloperPage.tsx)
  { id: "developer", label: "set.developer", icon: "code" },
  // one action gathers what is wrong, shows it, and hands it to the person's own coding agent or drafts an issue; nothing is
  // sent without an ask (item 105, report/ReportPage.tsx)
  { id: "report", label: "set.report", icon: "flag" },
];

/** Every App page, the everyday ones first: the order the palette lists them in. */
export const APP_PAGES: Page[] = [...EVERYDAY_PAGES, ...HOOD_PAGES];

/** Whether page `id` lives under "Under the hood". */
export const inHood = (id: string): boolean => HOOD_PAGES.some((p) => p.id === id);

/** The icons of the entries that are not App pages: the team's list, the shop's people and "Under the hood". */
export const LIST_ICON = { bots: "grid", people: "users", hood: "wrench" } as const satisfies Record<string, IconName>;
