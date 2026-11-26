// The App pages of Settings, by id and the name each shows. Kept apart from the page itself so the command palette can
// list them without loading every Settings page.
import type { Key } from "../i18n";

type Page = { id: string; label: Key };

/** The everyday pages, which a person sees first in Settings' list (item 85h). */
export const EVERYDAY_PAGES: Page[] = [
  { id: "general", label: "set.general" },
  // the chat box's microphone and voice mode: the language spoken, this Mac or Apple, the voice (VoicePage.tsx)
  { id: "voice", label: "set.voice" },
  // reaching this Mac from a paired phone: the switch behind a consent sheet, off by default, pairing with the typed code,
  // the paired phones and Unpair (item 78b, RemotePage.tsx). An owner's page, not a developer's, so it is not under the hood.
  { id: "remote", label: "set.remote" },
];

/** The developer pages, which live under one entry of Settings' list, "Under the hood" (the Voice board's words for
 *  logs, debug and trace), so an owner who is not technical never meets them unasked. Each keeps its id: a link to one
 *  (the palette, a page's own button) opens it and shows it inside its open entry. */
export const HOOD_PAGES: Page[] = [
  { id: "terminal", label: "set.terminal" },
  // every coding agent: on or off, its program, home, arguments and variables; your own agents; the accounts (item 74)
  { id: "providers", label: "set.providers" },
  // computer use: the two macOS permissions, read without asking, and what the agent may look at and do (ComputerPage.tsx)
  { id: "computer", label: "set.computer" },
  // where lanes' folders are made, the remote start, the branch prefix and the clean-up (WorktreesPage.tsx)
  { id: "worktrees", label: "set.worktrees" },
  // git, gh and glab with their versions and accounts, the default branch pulled when clean, how pull requests merge (item 75,
  // SourceControlPage.tsx)
  { id: "source", label: "set.source" },
  // publishing HTML and Markdown files as public links: the one switch, off by default, and how it works (item 83,
  // ArtifactLinksPage.tsx)
  { id: "artifacts", label: "set.artifacts" },
  // the MCP servers and skills each coding agent has, read from its own files; changes nothing (mcp/McpSkillsPage.tsx)
  { id: "mcp", label: "set.mcp" },
  // workflows run from files in ~/.manut/workflows: the switch, skipped runs kept, each workflow with Run now and its history
  // (item 77b, workflows/WorkflowsPage.tsx)
  { id: "workflows", label: "set.workflows" },
  // Practice or Connected, and signing in to the API (DeveloperPage.tsx)
  { id: "developer", label: "set.developer" },
];

/** Every App page, the everyday ones first: the order the palette lists them in. */
export const APP_PAGES: Page[] = [...EVERYDAY_PAGES, ...HOOD_PAGES];

/** Whether page `id` lives under "Under the hood". */
export const inHood = (id: string): boolean => HOOD_PAGES.some((p) => p.id === id);
