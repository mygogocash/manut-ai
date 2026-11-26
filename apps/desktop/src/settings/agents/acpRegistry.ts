// Settings › Providers › From the ACP registry (item 101c): the Agent Client Protocol's agent registry as the shell sends
// it (src-tauri/src/acp_registry.rs), and what the page does with it: search, order, each row's mark and words. The shell
// reads a pinned copy compiled into it and fetches nothing; it decides which entries are offered and why the others are
// not. Add… opens the same confirm card as the Add agent form, and Add on it is the same one call that writes
// (customConfirm). The mock host serves `mockAcpRegistry.json`, the shell's list for an Apple silicon Mac, which a Rust
// test holds equal to what the shell computes.
import { lang, locale, t } from "../../i18n";
import { programBase, whyText } from "../../sessions/custom";

/** Where an entry stands (acp_registry.rs `State`). */
export type RegistryState = "offered" | "there" | "yours" | "quarantine" | "platform" | "env" | "start" | "bin" | "refused";
/** How an offered entry is installed by the person: an npm package, a uv tool, or an archive they download. */
export type RegistryVia = "npx" | "uvx" | "binary" | "";

/** One registry entry as listed (acp_registry.rs `Offer`). */
export interface RegistryOffer {
  id: string;
  name: string;
  version: string;
  description: string;
  authors: string[];
  license: string;
  website: string;
  repository: string;
  state: RegistryState;
  /** there / yours: the agent's name; quarantine: the registry's reason; env: the variables; start: the arguments;
   *  refused: the custom-agent check's code */
  note: string;
  label: string;
  program: string;
  args: string[];
  install: string;
  via: RegistryVia;
  archive: string;
  sha256: string;
}

/** Where the pinned copy came from (acp_registry.rs `PinInfo`). */
export interface RegistryPin {
  source: string;
  tag: string;
  commit: string;
  published: string;
  sha256: string;
}

export interface RegistryList {
  pin: RegistryPin;
  skipped: number;
  agents: RegistryOffer[];
}

/** What the confirm card says of an entry from the registry (acp_registry.rs `Source`). */
export interface RegistrySource {
  id: string;
  name: string;
  version: string;
  via: RegistryVia;
  install: string;
  archive: string;
  sha256: string;
  website: string;
  repository: string;
  license: string;
  tag: string;
}

/** The longest search the box takes. */
export const SEARCH_MAX = 120;

/** How well `o` matches `query`, lower is better, `undefined` for no match. Lifted from T3 Code (MIT, pingdotgg/t3code at
 *  ae945dd, `searchRank` in packages/provider-acp-registry/src/server/AcpRegistrySupport.ts): the id or name whole,
 *  then as a prefix, then every word as the start of a word of either, then inside either, then the authors, then the
 *  description too. */
export function searchRank(o: Pick<RegistryOffer, "id" | "name" | "authors" | "description">, query: string): number | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return 100;
  const id = o.id.toLowerCase();
  const name = o.name.toLowerCase();
  const authors = o.authors.join(" ").toLowerCase();
  const description = o.description.toLowerCase();
  const terms = normalized.split(/\s+/u);
  if (id === normalized || name === normalized) return 0;
  if (id.startsWith(normalized) || name.startsWith(normalized)) return 10;
  const identityTokens = `${id} ${name}`.split(/[^a-z0-9]+/u).filter(Boolean);
  if (terms.every((term) => identityTokens.some((token) => token.startsWith(term)))) return 20;
  if (terms.every((term) => id.includes(term) || name.includes(term))) return 30;
  if (terms.every((term) => authors.includes(term))) return 40;
  if (terms.every((term) => `${id} ${name} ${authors} ${description}`.includes(term))) return 50;
  return undefined;
}

/** The rows the list shows for `query`: the ones that match, best match first, then the ones that can be added before
 *  the rest, then by name. */
export function registryRows(agents: RegistryOffer[], query: string): RegistryOffer[] {
  const q = query.slice(0, SEARCH_MAX);
  return agents
    .map((o) => ({ o, rank: searchRank(o, q) }))
    .filter((r): r is { o: RegistryOffer; rank: number } => r.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || Number(b.o.state === "offered") - Number(a.o.state === "offered") || a.o.name.localeCompare(b.o.name, "en", { sensitivity: "base" }))
    .map((r) => r.o);
}

/** Registry ids that name a product whose mark item 122 draws under another key. A wrapper by someone else that runs a
 *  product keeps that product's mark (Amp's), as its row names it; anything else draws its monogram. */
const MARK_OF: Record<string, string> = {
  "claude-acp": "claude",
  "codex-acp": "codex",
  "antigravity-acp": "antigravity",
  "github-copilot-cli": "copilot",
  "pi-acp": "pi",
  "grok-build": "grok",
  "opencode-v2": "opencode",
  "amp-acp": "amp",
  "mistral-vibe": "mistral",
};

/** The key AgentIcon draws registry entry `id` by (its own logo where one is published, else its monogram). */
export function registryMark(id: string): string {
  return MARK_OF[id] ?? id;
}

/** Why a row has no Add…, in words. */
export function stateText(o: RegistryOffer): string {
  switch (o.state) {
    case "offered":
      return "";
    case "there":
      return t("acpreg.there", { name: o.note });
    case "yours":
      return t("acpreg.yours", { name: o.note });
    case "quarantine":
      return t("acpreg.quarantine", { why: o.note });
    case "platform":
      return t("acpreg.platform");
    case "env":
      return t("acpreg.env", { names: o.note });
    case "start":
      return t("acpreg.start");
    case "bin":
      return t("acpreg.bin");
    case "refused":
      // a shell or an interpreter named by the registry, not by a bot; every other code says what the form's would
      return o.note === "interp" ? t("acpreg.interp") : whyText(`why:${o.note}`);
  }
}

/** A refusal of the card, in words: the custom-agent checks' codes as the form says them, and the registry's own. */
export function registryError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e ?? "");
  if (text === "why:registry") return t("acpreg.gone");
  if (text === "why:interp") return t("acpreg.interp");
  return whyText(e);
}

/** The foot of the list: the pinned release and its date, said once. */
export function pinnedText(pin: RegistryPin): string {
  const d = new Date(pin.published);
  const date = Number.isNaN(d.getTime()) ? pin.published : d.toLocaleDateString(lang() === "en" ? "en-GB" : locale(), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return t("acpreg.pinned", { tag: pin.tag, date });
}

/** The list beside the person's own agents (the mock host's part of acp_registry.rs `offer`): an entry that is not
 *  already among manut's agents and whose program one of theirs runs is theirs. */
export function withMine(list: RegistryList, mine: { label: string; program: string }[]): RegistryList {
  const agents = list.agents.map((o) => {
    if (o.state === "there" || !o.program) return o;
    const own = mine.find((c) => programBase(c.program) === programBase(o.program));
    return own ? { ...o, state: "yours" as const, note: own.label } : o;
  });
  return { ...list, agents };
}
