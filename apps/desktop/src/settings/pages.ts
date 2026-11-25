// The App pages of Settings, by id and the name each shows. Kept apart from the page itself so the command palette can
// list them without loading every Settings page.
import type { Key } from "../i18n";

export const APP_PAGES: { id: string; label: Key }[] = [
  { id: "general", label: "set.general" },
  // the chat box's microphone and voice mode: the language spoken, this Mac or Apple, the voice (VoicePage.tsx)
  { id: "voice", label: "set.voice" },
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
  // reaching this Mac from a paired phone: the switch behind a consent sheet, off by default, pairing with the typed code,
  // the paired phones and Unpair (item 78b, RemotePage.tsx)
  { id: "remote", label: "set.remote" },
  // the MCP servers and skills each coding agent has, read from its own files; changes nothing (mcp/McpSkillsPage.tsx)
  { id: "mcp", label: "set.mcp" },
  // workflows run from files in ~/.manut/workflows: the switch, skipped runs kept, each workflow with Run now and its history
  // (item 77b, workflows/WorkflowsPage.tsx)
  { id: "workflows", label: "set.workflows" },
  // Practice or Connected, and signing in to the API (DeveloperPage.tsx)
  { id: "developer", label: "set.developer" },
];
