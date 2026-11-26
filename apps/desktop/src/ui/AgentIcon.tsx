// The mark of a coding agent, a provider or an editor (Claude Code, Codex, Gemini CLI, DeepSeek, Zed…), a sibling of
// ModelIcon. Since the owner's request of 26 Nov 2026 (docs/decisions.md) each one is drawn by its own published logo
// wherever Lobe Icons or Simple Icons has that product or its maker (src/ui/agentMarks.ts, generated, with each mark's
// source), and every other one (pi's forks, OmO, DSH, a person's own agent, a name the app does not know) by a monogram:
// its first letter in the app's own type on a quiet tile, so a row of agents always reads as a row of marks. A mark
// drawn in `currentColor` follows the text colour on both themes; one with colours of its own keeps them. A logo names
// its own product only: the app's own places keep the app's own icon set (src/ui/icons.tsx).
import type { CSSProperties } from "react";
import { t } from "../i18n";
import { AGENT_MARKS } from "./agentMarks";
import { MODEL_MARKS } from "./modelMarks";

export type AgentMark =
  | { kind: "svg"; id: string; title: string; viewBox: string; body: string; evenodd: boolean }
  | { kind: "letter"; id: null; title: string; letter: string };

/** Every agent, provider and editor id with a published mark, by the key agentMarks.ts names it. */
export const AGENT_IDS: string[] = Object.keys(AGENT_MARKS);

/** Other spellings people, the shell's rows and executors use for the same product (lower case). */
const ALIASES: Record<string, string> = {
  claudecode: "claude",
  "claude-code": "claude",
  "claude-agent": "claude",
  "claude-code-acp": "claude",
  "claude-agent-acp": "claude",
  "openai-codex": "codex",
  "codex-cli": "codex",
  geminicli: "gemini",
  "gemini-cli": "gemini",
  agy: "antigravity",
  "qwen-code": "qwen",
  "kimi-code": "kimi",
  "kimi-cli": "kimi",
  moonshot: "kimi",
  "grok-cli": "grok",
  xai: "grok",
  "cursor-agent": "cursor",
  githubcopilot: "copilot",
  "github-copilot": "copilot",
  "copilot-cli": "copilot",
  "open-code": "opencode",
  "hermes-agent": "hermes",
  "z-ai": "zai",
  "z.ai": "zai",
  zhipu: "zai",
  kilocode: "kilo",
  "kilo-code": "kilo",
  roocode: "roo",
  "roo-code": "roo",
  zedindustries: "zed",
};

/** The mark file names the harness registry and the shell's agent rows give (Oh My Hermes' file names), to the mark
 *  each names. A file no row of this table knows draws the monogram. */
const FILES: Record<string, string> = {
  "claudecode-color": "claude",
  claudecode: "claude",
  "claude-color": "claude",
  openai: "codex",
  codex: "codex",
  "geminicli-color": "gemini",
  "gemini-color": "gemini",
  antigravity: "antigravity",
  "antigravity-color": "antigravity",
  "qwen-color": "qwen",
  "kimi-code": "kimi",
  "kimi-color": "kimi",
  grok: "grok",
  githubcopilot: "copilot",
  cursor: "cursor",
  cline: "cline",
  opencode: "opencode",
  pi: "pi",
  "hermes-agent": "hermes",
  hermesagent: "hermes",
  "amp-color": "amp",
  goose: "goose",
  kilocode: "kilo",
  "junie-color": "junie",
  "trae-color": "trae",
  roocode: "roo",
  windsurf: "windsurf",
};

const svgMark = (key: string, title?: string): AgentMark | null => {
  const art = AGENT_MARKS[key];
  if (art) return { kind: "svg", id: key, title: title || art.title, viewBox: art.viewBox, body: art.body, evenodd: art.evenodd };
  // a provider the app already draws as a model's maker (OpenAI, Meta, Mistral, OpenRouter, Ollama): the same mark
  const model = MODEL_MARKS[key];
  return model ? { kind: "svg", id: key, title: title || model.title, viewBox: model.viewBox, body: model.body, evenodd: true } : null;
};

/** The monogram of `name`: its first letter or digit, upper case ("?" when it has none). */
export const monogram = (name: string): string => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();

const letter = (name: string): AgentMark => ({ kind: "letter", id: null, title: name || t("mark.unknown"), letter: monogram(name) });

/** The mark for an agent, provider or editor id (any case, aliases allowed): its own logo when one is published, else
 *  the monogram of `title` (its name as the app shows it) or of the id. */
export function agentIcon(id: string | null | undefined, title?: string): AgentMark {
  const key = (id ?? "").trim().toLowerCase();
  const mark = key ? svgMark(ALIASES[key] ?? key, title) : null;
  if (mark) return mark;
  return letter((title ?? "").trim() || (id ?? "").trim());
}

/** The mark a file name of the registry or a shell row names (`geminicli-color.svg`), titled `title`; the monogram of
 *  `title` when the file names no published mark. */
export function fileMark(file: string, title: string): AgentMark {
  const stem = file.trim().toLowerCase().replace(/\.[a-z]+$/, "");
  return (FILES[stem] ? svgMark(FILES[stem]) : null) ?? letter(title);
}

let drawn = 0;

/** A drawing's ids made its own once it is on the page: a mark with a gradient or a mask is first written with ids named
 *  after the mark (`ag-gemini-0`), and each copy of it then takes a number of its own, so a copy hidden in a closed menu
 *  never takes another copy's gradient with it. A ref, not a hook, so the mark draws anywhere a function is called. */
export const ownIds = (body: string) => (el: { dataset: DOMStringMap; innerHTML: string } | null) => {
  if (!el || el.dataset.u) return;
  el.dataset.u = String(++drawn);
  el.innerHTML = body.replace(/%u/g, `ag${drawn}`);
};

/** The size of a monogram's letter in a tile of `size`: about two thirds of it, as a capital stands in the set's box. */
export const monoFont = (size: number) => Math.round(size * 0.625);

export function AgentIcon({
  id,
  file,
  title,
  size = 16,
  style,
  className,
}: {
  id: string | null | undefined;
  /** Draw the mark this file of the registry or a shell row names instead ([`fileMark`], titled by `title` or `id`). */
  file?: string;
  /** The name the app shows beside it, which a monogram takes its letter from. */
  title?: string;
  size?: number;
  style?: CSSProperties;
  className?: string;
}) {
  const mark = file ? fileMark(file, title ?? id ?? "") : agentIcon(id, title);
  const cls = `agent-ic${className ? ` ${className}` : ""}`;
  if (mark.kind === "letter") {
    // the letter is drawn by the stylesheet from data-letter (ui.css), so it is never part of the row's words
    return (
      <span
        className={`${cls} agent-mono`}
        data-agent="letter"
        data-letter={mark.letter}
        aria-hidden="true"
        style={{ width: size, height: size, fontSize: monoFont(size), borderRadius: Math.max(3, Math.round(size / 4)), ...style }}
      />
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      fill="currentColor"
      fillRule={mark.evenodd ? "evenodd" : undefined}
      aria-hidden="true"
      focusable="false"
      className={cls}
      data-agent={mark.id}
      style={style}
      ref={mark.body.includes("%u") ? ownIds(mark.body) : undefined}
      // static, generated markup from agentMarks.ts and modelMarks.ts (no user input)
      dangerouslySetInnerHTML={{ __html: mark.body.replace(/%u/g, `ag-${mark.id}`) }}
    />
  );
}
