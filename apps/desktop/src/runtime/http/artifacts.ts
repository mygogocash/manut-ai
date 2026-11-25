// Artifact links on the connected runtime (docs/pilot-api.md, "Artifact links"): the shop's links, read with its owner's session, a
// page published as a link and a link removed, each only after its ask settled with a yes (src/runtime/artifactAsks.ts).
//
// Rules this module keeps:
// - While Settings › Artifacts › Allow publishing public artifact links is off, nothing here is sent, a read included: every op is
//   refused `switched_off` first.
// - A publish or a removal takes only an ask's id. What it sends is that ask's own detail, which approval-core settled with a yes, so
//   it is exactly what the person was shown, and the ask is used once whatever the answer: a publish that got no answer is never
//   sent again from here (the API may have it; the page's next read of the list says).
// - The list is of the shop the switcher shows, read with its own session; a change goes to the shop its ask names, with that
//   shop's session. Only the owner reads or changes links: a shop the person helps at is refused `owner_only` with nothing sent,
//   and a person in no shop `no_shop`.
// - What the API would refuse is refused here first by the same rules (src/runtime/artifacts.ts), and a publish is sent as exactly
//   `{ title, kind, text }`, a removal as `{ id }`: never a shop, a tenant or a role.
// - What the API answers is read field by field. A link this build cannot read whole makes the list unreadable, rather than leave
//   it out. Nothing the person published is kept here: the page holds the list, and no text, title or link reaches the saved read
//   of the shop, an event or a log.
import { t } from "../../i18n";
import { artifactSettings } from "../../lib/artifactLinks";
import { takeSettled } from "../artifactAsks";
import {
  ARTIFACT_KINDS,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS,
  shareBody,
  shareRefusal,
  type ArtifactLink,
  type ArtifactOps,
  type Publishing,
} from "../artifacts";
import { OpError } from "../mock/host";
import type { OwnerLink } from "./connections";
import type { ShopAnswer } from "./shops";

export const ARTIFACTS_PATH = "/v1/artifacts";
export const ARTIFACTS_REMOVE_PATH = "/v1/artifacts/remove";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const PUBLISHING: readonly Publishing[] = ["on", "feature_disabled", "artifact_origin_not_configured"];

/** One link of the API's answer, its time in seconds, or null when this build cannot read it whole. A link must be the API's own
 *  https address. */
export function decodeLink(v: unknown): ArtifactLink | null {
  if (!isObj(v) || typeof v.id !== "string" || v.id === "" || typeof v.title !== "string" || v.title === "") return null;
  if (!(ARTIFACT_KINDS as readonly unknown[]).includes(v.kind)) return null;
  const bytes = num(v.bytes);
  const createdAt = num(v.createdAt);
  if (bytes === null || createdAt === null) return null;
  let url: string | null = null;
  if (v.url !== null) {
    if (typeof v.url !== "string" || !v.url.startsWith("https://")) return null;
    url = v.url;
  }
  return { id: v.id, title: v.title, kind: v.kind as ArtifactLink["kind"], bytes, createdAt: createdAt / 1000, url };
}

/** `GET /v1/artifacts`, or null when the answer is not one or any link in it cannot be read. */
export function decodeList(json: unknown): { publishing: Publishing; links: ArtifactLink[] } | null {
  if (!isObj(json) || !PUBLISHING.includes(json.publishing as Publishing) || !Array.isArray(json.artifacts)) return null;
  const links = json.artifacts.map(decodeLink);
  return links.every((l): l is ArtifactLink => l !== null) ? { publishing: json.publishing as Publishing, links } : null;
}

/** What the page says when a link op was refused, by its code. Any other refusal is "did not make this change". */
const REFUSED: Record<string, () => string> = {
  switched_off: () => t("art.err.switchedOff"),
  owner_only: () => t("art.err.ownerOnly"),
  no_shop: () => t("art.err.noShop"),
  not_found: () => t("art.err.notFound"),
  not_settled: () => t("art.err.notSettled"),
  feature_disabled: () => t("art.err.featureOff"),
  artifact_origin_not_configured: () => t("art.err.noOrigin"),
  too_many: () => t("art.err.tooMany", { max: MAX_ARTIFACTS }),
  too_large: () => t("art.err.tooLarge", { max: MAX_ARTIFACT_BYTES / 1024 }),
  invalid_title: () => t("art.err.title"),
  invalid_kind: () => t("art.err.kind"),
  invalid_text: () => t("art.err.empty"),
};

export const refusal = (code: string): OpError => new OpError(code, (REFUSED[code] ?? (() => t("rt.change.refused")))());

type Handlers = { [K in keyof ArtifactOps]: (p: ArtifactOps[K]["params"]) => Promise<ArtifactOps[K]["result"]> };

/** The three artifact ops over `link`. `allowed` is the Settings switch (tests give their own). */
export function artifactHandlers(link: OwnerLink, allowed: () => boolean = () => artifactSettings().publish): Handlers {
  const ok = (answer: ShopAnswer, shop: string, changing: boolean): unknown => {
    if (answer.kind === "ok") return answer.json;
    if (answer.kind === "left") throw link.departed(shop, answer.departure);
    if (answer.kind === "refused") throw refusal(answer.code);
    if (answer.kind === "signed_out") throw new OpError("signed_out", t("rt.signedOut"));
    if (answer.kind === "offline") throw new OpError("offline", t("rt.offline"));
    // A 503 that says why publishing cannot happen is a refusal, not an outage.
    if (answer.code === "artifact_origin_not_configured") throw refusal(answer.code);
    throw new OpError("unavailable", changing ? t("rt.change.noReply") : t("art.err.unavailable"));
  };
  /** Before anything: the switch on, and a runtime that is not showing a kept read. */
  const open = () => {
    if (!allowed()) throw refusal("switched_off");
    link.live();
  };
  /** The shop a change names, checked with nothing sent: one of the person's shops, which they own. */
  const target = (shop: string): string => {
    const role = link.roleAt(shop);
    if (!role) throw new OpError("not_found", t("rt.notFound"));
    if (role !== "owner") throw refusal("owner_only");
    return shop;
  };

  return {
    "artifacts.list": async () => {
      open();
      const viewed = await link.viewed();
      if (!viewed) throw refusal("no_shop");
      if (viewed.role !== "owner") throw refusal("owner_only");
      const read = decodeList(ok(await link.read(viewed.shop, ARTIFACTS_PATH), viewed.shop, false));
      if (!read) throw new OpError("unavailable", t("art.err.unreadable"));
      return { shop: viewed.shop, ...read };
    },

    "artifacts.publish": async (p) => {
      open();
      const plan = await takeSettled(p.ask, "publish");
      if (!plan) throw refusal("not_settled");
      const shop = target(plan.shop);
      const refused = shareRefusal(plan);
      if (refused) throw refusal(refused);
      const json = ok(await link.write(shop, ARTIFACTS_PATH, shareBody(plan)), shop, true);
      const made = isObj(json) ? decodeLink(json.artifact) : null;
      if (!made) throw new OpError("unavailable", t("rt.change.unreadable"));
      return { link: made };
    },

    "artifacts.remove": async (p) => {
      open();
      const plan = await takeSettled(p.ask, "remove");
      if (!plan) throw refusal("not_settled");
      const shop = target(plan.shop);
      const json = ok(await link.write(shop, ARTIFACTS_REMOVE_PATH, { id: plan.id }), shop, true);
      if (!isObj(json) || json.id !== plan.id) throw new OpError("unavailable", t("rt.change.unreadable"));
      return { id: plan.id };
    },
  };
}
