// A chat's title written by the person's chosen model (item 96, Settings › General › Titles and words, lib/titleModel.ts).
//
// The rules, all of them here so a test can pin each one:
// - Only when the person turned it on, and only for an agent that can (Claude Code): `titlesFor`.
// - Only a chat that has had a first answer, from its first message and that answer, masked (`chatMaterial`).
// - What comes back is a proposal (`SessionRec.modelTitle`). It ranks below a name the person gave (`pickTitle`), and a result that
//   arrives after the person renamed the chat is dropped (`acceptTitle`), so it never beats a person's own.
// - It writes the title once per chat on its own; "Write the title again" asks for another, and only for a chat the person has not
//   named.
import { maskSecrets } from "../lib/secrets";
import { titlesFor, type TitleModel } from "../lib/titleModel";
import type { TitleRequest, TitleWords } from "./host";

/** The most characters of one message that go into the material (the shell cuts the whole again). */
export const MESSAGE_MAX = 2_500;

type Msg = { role: "user" | "assistant"; text: string };
type Rec = { agent: string; view?: string; title?: string; modelTitle?: string };

/** The chat's first message and first answer, masked, as the material of a title run; "" until both exist. */
export function chatMaterial(messages: readonly Msg[]): string {
  const user = messages.find((m) => m.role === "user" && m.text.trim());
  const answer = user ? messages.slice(messages.indexOf(user) + 1).find((m) => m.role === "assistant" && m.text.trim()) : undefined;
  if (!user || !answer) return "";
  const cut = (s: string) => maskSecrets(s.trim()).slice(0, MESSAGE_MAX);
  return `First message:\n${cut(user.text)}\n\nFirst answer:\n${cut(answer.text)}`;
}

/** Whether a title should be written for `rec` now. `again` is the person's own ask: it replaces an earlier written title, but
 *  never runs for a chat the person named. */
export function wantsTitle(rec: Rec | undefined, settings: TitleModel, again = false): boolean {
  if (!rec || rec.view === "terminal") return false;
  if (!titlesFor(rec.agent, settings)) return false;
  if (rec.title?.trim()) return false;
  return again || !rec.modelTitle;
}

/** A file whose name says it holds keys or a login (`.env`, a private key, a keystore, an `.npmrc`): its name and counts go into the
 *  material and none of its lines do, since masking knows a key by its shape and a file like these may hold one of any shape. */
export const holdsKeys = (path: string): boolean =>
  /(^|[\\/])(\.env(\.[^\\/]*)?|\.envrc|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|[^\\/]*\.(pem|key|p12|pfx|jks|keystore|kdbx)|[^\\/]*(secret|credential)[^\\/]*)$/i.test(path);

/** The material of a pull request's words: the lane's commit subjects, then each changed file and the first lines of its diff, masked
 *  and cut (the shell cuts the whole again). A file that holds keys by its name gives its name alone. */
export function pullMaterial(commits: readonly string[], files: readonly { path: string; kind: string; added: number; removed: number; lines: readonly string[] }[]): string {
  const out: string[] = [];
  if (commits.length) out.push("Commits:", ...commits.slice(0, 20).map((c) => `- ${c}`), "");
  out.push("Files:");
  let room = 4_000;
  for (const f of files.slice(0, 40)) {
    out.push(`${f.kind} ${f.path} (+${f.added} -${f.removed})`);
    for (const l of holdsKeys(f.path) ? [] : f.lines.slice(0, 20)) {
      if (room <= 0) break;
      out.push(l);
      room -= l.length;
    }
  }
  return maskSecrets(out.join("\n")).slice(0, 6_000);
}

/** The request for chat `key` (the session's chat key). */
export const titleRequest = (agent: string, settings: TitleModel, key: string, material: string): TitleRequest => ({
  agent,
  model: settings.model,
  effort: settings.effort,
  purpose: "title",
  key,
  material,
});

/** The patch a result makes, or null: nothing when the words are empty or the person named the chat while it ran. */
export function acceptTitle(rec: Pick<Rec, "title"> | undefined, words: Pick<TitleWords, "title"> | null): { modelTitle: string } | null {
  const t = (words?.title ?? "").replace(/\s+/g, " ").trim();
  if (!rec || rec.title?.trim() || !t) return null;
  return { modelTitle: t };
}

/** A code the shell or the host rejected with, as the key of its words (`titles.why.<code>`), `other` for any other line. */
export function whyKey(e: unknown): "off" | "busy" | "too_many" | "timeout" | "cancelled" | "empty" | "unsupported" | "other" {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const known = ["off", "busy", "too_many", "timeout", "cancelled", "empty", "unsupported"] as const;
  return known.find((k) => k === m) ?? "other";
}
