// The Artifacts page's own logic, kept apart from the page so it can be tested without one (item 83): where the page stands before
// anything is sent, why Share cannot be used yet in plain words, how a link's kind and size are said, and the plan a chosen file
// becomes. What may be published, and when, is the runtime's and the ask's to decide (src/runtime/artifacts.ts, artifactAsks.ts).
import { dayText } from "../app/time";
import { t } from "../i18n";
import { kindOfFile, shareRefusal, titleOfFile, utf8Bytes, type ArtifactKind, type Publishing, type SharePlan } from "../runtime/artifacts";
import { refusal } from "../runtime/http/artifacts";

export { dayText };

/** Where the page stands, from what this Mac knows before it sends anything, then from what the runtime said:
 *  - `switched_off`: Settings › Artifacts › Allow publishing public artifact links is off, so nothing is read or sent;
 *  - `practice`: Practice keeps no links;
 *  - `signed_out`: Connected with nobody signed in, so there is no account for a link to belong to;
 *  - `reading`: the list is on its way;
 *  - `failed`: the runtime refused the list (`owner_only`, `no_shop`...) or could not read it, with its words;
 *  - `ready`: the shop's list, and whether the API publishes now. */
export type ArtifactsState =
  | { kind: "switched_off" }
  | { kind: "practice" }
  | { kind: "signed_out" }
  | { kind: "reading" }
  | { kind: "failed"; code: string; message: string }
  | { kind: "ready"; shop: string; publishing: Publishing };

/** Why Share cannot be used now, in the person's words, or null when it can. Every reason is one nothing was sent for. */
export function blockedReason(state: ArtifactsState): string | null {
  switch (state.kind) {
    case "switched_off":
      return t("art.why.switchedOff");
    case "practice":
      return t("art.why.practice");
    case "signed_out":
      return t("art.why.signedOut");
    case "reading":
      return t("art.why.reading");
    case "failed":
      return state.message;
    case "ready":
      return state.publishing === "feature_disabled" ? t("art.why.featureOff") : state.publishing === "artifact_origin_not_configured" ? t("art.why.noOrigin") : null;
  }
}

/** "HTML page" or "Markdown page". */
export const kindText = (kind: ArtifactKind): string => t(kind === "html" ? "art.kind.html" : "art.kind.markdown");

/** A page's size as a person reads it: whole bytes under a kilobyte, else kilobytes with one decimal under ten. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return t("art.size.bytes", { n: bytes });
  const kb = bytes / 1024;
  return t("art.size.kb", { n: kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb) });
}

/** "Published 25 November". */
export const madeText = (createdAt: number, nowMs: number): string => t("art.made", { date: dayText(createdAt, nowMs) });

/** A chosen file, as the ask will show it and the runtime will publish it, or the words for why it cannot be. Reading the file sends
 *  nothing. */
export async function planFromFile(file: { name: string; text(): Promise<string> }, shop: string):
  Promise<{ ok: true; plan: SharePlan } | { ok: false; message: string }> {
  const kind = kindOfFile(file.name);
  if (!kind) return { ok: false, message: t("art.err.kind") };
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, message: t("art.err.read") };
  }
  const plan: SharePlan = { shop, title: titleOfFile(file.name) || t("art.untitled"), kind, text, bytes: utf8Bytes(text) };
  const refused = shareRefusal(plan);
  return refused ? { ok: false, message: refusal(refused).message } : { ok: true, plan };
}
