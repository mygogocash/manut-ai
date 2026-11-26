// What the Artifacts page asks of a runtime about the shop's artifact links (item 83; docs/pilot-api.md, "Artifact links"): the
// links the owner made, a page published as a link anyone with it can open, and a link removed. Like the memory, routine and People
// ops, the shapes live here beside the runtime, and `OpMap` in lib/protocol.ts extends them, so a runtime that does not answer one
// does not compile.
//
// A link is public, so neither change takes what to publish or remove from its caller. `artifacts.publish` and `artifacts.remove`
// take only the id of an ask the person settled through approval-core (artifactAsks.ts), and the runtime reads what to do from that
// ask: exactly the title, the kind and the text the person was shown, and once. There is no op that publishes or removes anything
// else, so the page, an agent or anything else in this app has one way to a public link: the ask.
//
// The limits are the API's (apps/api/src/artifact-store.ts), checked here first so nothing the API would refuse is ever sent, and
// so the ask never shows a page that could not be published.

/** What a link can be: an HTML or Markdown page, or a bundle of skills (item 84, src/runtime/skillBundle.ts). */
export const ARTIFACT_KINDS = ["html", "markdown", "skills"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
/** The two kinds of page a file can be shared as. */
export const PAGE_KINDS = ["html", "markdown"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** The most text one page holds, in UTF-8 bytes (`MAX_ARTIFACT_BYTES` in the API). */
export const MAX_ARTIFACT_BYTES = 128 * 1024;
/** The largest body the shell's request command sends (src-tauri/src/api_link.rs). */
export const MAX_REQUEST_BYTES = 256 * 1024;
/** The longest title (`MAX_TITLE` in the API), in characters as JavaScript counts them. */
export const MAX_TITLE = 120;
/** The most links one shop holds (`MAX_ARTIFACTS` in the API). */
export const MAX_ARTIFACTS = 50;

/** Whether publishing is open now, as the API says it: on, switched off by the operator, or with no web address for links yet. */
export type Publishing = "on" | "feature_disabled" | "artifact_origin_not_configured";

/** One of the shop's links. `url` is the public link; null while the API has no web address for links. */
export interface ArtifactLink {
  id: string;
  title: string;
  kind: ArtifactKind;
  /** the page's size in UTF-8 bytes */
  bytes: number;
  /** when it was published, in seconds */
  createdAt: number;
  url: string | null;
}

/** What one ask to publish shows, and all that is published when it is settled with a yes. */
export interface SharePlan {
  /** the shop it is published for, as `artifacts.list` named it */
  shop: string;
  title: string;
  kind: PageKind;
  text: string;
  /** the text's size in UTF-8 bytes */
  bytes: number;
}

/** What one ask to remove a link shows, and the link it removes when it is settled with a yes. */
export interface RemovePlan {
  shop: string;
  id: string;
  title: string;
  url: string | null;
}

export interface ArtifactOps {
  /** The links of the shop the switcher shows, newest first, the shop they were read for, and whether publishing is open now. Refused
   *  `owner_only` for a shop the person only helps at, and `no_shop` while they are in none. */
  "artifacts.list": {
    params: Record<string, never>;
    /** `skillPublishing`: whether bundles of skills can be published now (item 84); `origin`: the links' own web address, which a
     *  link to install skills from must be on, or null while there is none. */
    result: { shop: string; publishing: Publishing; skillPublishing: Publishing; origin: string | null; links: ArtifactLink[] };
  };
  /** Publishes the page ask `ask` showed, once that ask was settled with a yes (artifactAsks.ts). Refused `not_settled` for any other
   *  ask, and for one already used. */
  "artifacts.publish": { params: { ask: string }; result: { link: ArtifactLink } };
  /** Publishes the bundle of skills ask `ask` showed (item 84), once it was settled with a yes after every file was looked at.
   *  Refused `skills_off` while Settings › Artifacts › Allow sharing skills by link is off, and `not_settled` for any other ask. */
  "artifacts.publishSkills": { params: { ask: string }; result: { link: ArtifactLink } };
  /** Removes the link ask `ask` named, once that ask was settled with a yes. */
  "artifacts.remove": { params: { ask: string }; result: { id: string } };
}

/** The kind of page a file name says, or null for a file that is neither HTML nor Markdown. */
export function kindOfFile(name: string): PageKind | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1]?.toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  return null;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A title for a page from its file's name: the name without its extension, on one line, cut to `MAX_TITLE`. */
export function titleOfFile(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/\.[A-Za-z0-9]+$/, "");
  return base.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE).trim();
}

/** Whether the API would take `title` as one: 1 to `MAX_TITLE` characters once trimmed, with no control or line-separator character. */
export function titleOk(title: unknown): title is string {
  if (typeof title !== "string") return false;
  const trimmed = title.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_TITLE && !new RegExp(CONTROL.source).test(trimmed);
}

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** What a publish sends, exactly: the fields the API reads and nothing else. */
export const shareBody = (plan: Pick<SharePlan, "title" | "kind" | "text">) => ({ title: plan.title.trim(), kind: plan.kind, text: plan.text });

/** Why the API would refuse to publish this page, by its code, or null when it would take it: a title it can show, a kind it knows,
 *  text that is there and not over `MAX_ARTIFACT_BYTES`, and a body the shell can send. */
export function shareRefusal(plan: Pick<SharePlan, "title" | "kind" | "text">): "invalid_title" | "invalid_kind" | "invalid_text" | "too_large" | null {
  if (!titleOk(plan.title)) return "invalid_title";
  if (!(PAGE_KINDS as readonly string[]).includes(plan.kind)) return "invalid_kind";
  if (typeof plan.text !== "string" || plan.text.length === 0) return "invalid_text";
  if (utf8Bytes(plan.text) > MAX_ARTIFACT_BYTES || utf8Bytes(JSON.stringify(shareBody(plan))) > MAX_REQUEST_BYTES) return "too_large";
  return null;
}
