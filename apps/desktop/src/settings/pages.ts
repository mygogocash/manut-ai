// The App pages of Settings: one entry each, with its id, the name it shows, the icon it leads with, where it sits and
// the component that draws it (item 128). Adding a page is one entry here and the import of its component; Settings'
// list, its body (Settings.slot.tsx) and the command palette all read this list, so neither needs a line of its own.
// Bots, a bot's page, People and General's Delete account are not App pages and stay in Settings.slot.tsx.
//
// Node cannot load the components (their stylesheets), so the Playwright helpers read the hood's ids from this file's
// text (e2e/start.ts): keep each entry's `id` and `where` written as plain strings.
import { createElement, type ComponentType } from "react";
import type { Key } from "../i18n";
import type { IconName } from "../ui/icons";
import { TerminalPage } from "./terminal/TerminalPage";
import { ProvidersPage } from "./providers/ProvidersPage";
import { DeveloperPage } from "./DeveloperPage";
import { ReportPage } from "../report/ReportPage";
import { WorktreesPage } from "./WorktreesPage";
import { SourceControlPage } from "./SourceControlPage";
import { ArtifactLinksPage } from "./ArtifactLinksPage";
import { RemotePage } from "./RemotePage";
import { VoicePage } from "./VoicePage";
import { ComputerPage } from "./ComputerPage";
import { McpSkillsPage } from "./mcp/McpSkillsPage";
import { WorkflowsPage } from "../workflows/WorkflowsPage";

/** What a page's component is given: the page as it was asked for, before an old id was turned into its new page. */
export type PageViewProps = { page: string };

/** A page, the name it shows, the icon of the set it leads with in Settings' list and the palette (item 122: every menu
 *  led by an icon; each drawing shows a thing the page is about), the part of the list it sits in, and what draws it.
 *  Everyday pages are the ones a person sees first in Settings' list (item 85h); the hood's live under one entry,
 *  "Under the hood" (the Voice board's words for logs, debug and trace), so an owner who is not technical never meets
 *  them unasked. A page with no `view` is General, drawn by Settings.slot.tsx itself. */
export type Page = { id: string; label: Key; icon: IconName; where: "everyday" | "hood"; view?: ComponentType<PageViewProps> };

/** Providers opens at its accounts when asked for `accounts`, the id of the page it took in with item 74. */
const ProvidersView = ({ page }: PageViewProps) => createElement(ProvidersPage, { focus: page === "accounts" ? "accounts" : undefined });

/** Every App page, in the order Settings' list shows each part's pages. */
export const PAGES: Page[] = [
  // drawn by Settings.slot.tsx itself (GeneralPage), which is also what an id it does not know shows
  { id: "general", label: "set.general", icon: "gear", where: "everyday" },
  // the chat box's microphone and voice mode: the language spoken, this Mac or Apple, the voice (VoicePage.tsx)
  { id: "voice", label: "set.voice", icon: "mic", where: "everyday", view: VoicePage },
  // reaching this Mac from a paired phone: the switch behind a consent sheet, off by default, pairing with the typed code,
  // the paired phones and Unpair (item 78b, RemotePage.tsx). An owner's page, not a developer's, so it is not under the hood.
  { id: "remote", label: "set.remote", icon: "smartphone", where: "everyday", view: RemotePage },
  { id: "terminal", label: "set.terminal", icon: "terminal", where: "hood", view: TerminalPage },
  // every coding agent: on or off, its program, home, arguments and variables; your own agents; the accounts (item 74)
  { id: "providers", label: "set.providers", icon: "cube", where: "hood", view: ProvidersView },
  // computer use: the two macOS permissions, read without asking, and what the agent may look at and do (ComputerPage.tsx)
  { id: "computer", label: "set.computer", icon: "monitor", where: "hood", view: ComputerPage },
  // where lanes' folders are made, the remote start, the branch prefix and the clean-up (WorktreesPage.tsx)
  { id: "worktrees", label: "set.worktrees", icon: "folder", where: "hood", view: WorktreesPage },
  // git, gh and glab with their versions and accounts, the default branch pulled when clean, how pull requests merge (item 75,
  // SourceControlPage.tsx)
  { id: "source", label: "set.source", icon: "git-branch", where: "hood", view: SourceControlPage },
  // publishing HTML and Markdown files as public links: the one switch, off by default, and how it works (item 83,
  // ArtifactLinksPage.tsx)
  { id: "artifacts", label: "set.artifacts", icon: "link", where: "hood", view: ArtifactLinksPage },
  // the MCP servers and skills each coding agent has, read from its own files; changes nothing (mcp/McpSkillsPage.tsx)
  { id: "mcp", label: "set.mcp", icon: "plug", where: "hood", view: McpSkillsPage },
  // workflows run from files in ~/.manut/workflows: the switch, skipped runs kept, each workflow with Run now and its history
  // (item 77b, workflows/WorkflowsPage.tsx)
  { id: "workflows", label: "set.workflows", icon: "nodes", where: "hood", view: WorkflowsPage },
  // Practice or Connected, and signing in to the API (DeveloperPage.tsx)
  { id: "developer", label: "set.developer", icon: "code", where: "hood", view: DeveloperPage },
  // one action gathers what is wrong, shows it, and hands it to the person's own coding agent or drafts an issue; nothing is
  // sent without an ask (item 105, report/ReportPage.tsx)
  { id: "report", label: "set.report", icon: "flag", where: "hood", view: ReportPage },
];

/** The everyday pages, which a person sees first in Settings' list (item 85h). */
export const EVERYDAY_PAGES: Page[] = PAGES.filter((p) => p.where === "everyday");

/** The developer pages, under "Under the hood". Each keeps its id: a link to one (the palette, a page's own button)
 *  opens it and shows it inside its open entry. */
export const HOOD_PAGES: Page[] = PAGES.filter((p) => p.where === "hood");

/** Every App page, the everyday ones first: the order the palette lists them in. */
export const APP_PAGES: Page[] = [...EVERYDAY_PAGES, ...HOOD_PAGES];

/** Whether page `id` lives under "Under the hood". */
export const inHood = (id: string): boolean => HOOD_PAGES.some((p) => p.id === id);

/** The icons of the entries that are not App pages: the team's list, the shop's people and "Under the hood". */
export const LIST_ICON = { bots: "grid", people: "users", hood: "wrench" } as const satisfies Record<string, IconName>;
