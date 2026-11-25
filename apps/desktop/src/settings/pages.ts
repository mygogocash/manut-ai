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
  // the MCP servers and skills each coding agent has, read from its own files; changes nothing (mcp/McpSkillsPage.tsx)
  { id: "mcp", label: "set.mcp" },
  // Practice or Connected, and signing in to the API (DeveloperPage.tsx)
  { id: "developer", label: "set.developer" },
];
