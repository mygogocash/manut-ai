// What the team knows, on the connected runtime (docs/pilot-api.md, "Memory", the owner's own routes): the shop's facts, read with
// its owner's session, and the owner's say over them: something to remember, "It's true" on a fact that waits, Correct and Forget.
//
// Rules this module keeps:
// - The list is of the shop the switcher shows, read with that shop's own session (shops.ts), or refused when there is none to
//   read: a person who is in no shops has none (the API answers a person's own sign-in 404, since what the team knows is a shop's),
//   so `memory.list` says `no_shop` and nothing is sent. A change goes to the shop its list was read for (`p.shop`), never to the one
//   the switcher shows now, and with that shop's session, as an answer to an ask goes to the ask's own shop.
// - Only the owner sees or changes these. A shop the person helps at is refused here (`owner_only`) with nothing sent, as the API
//   refuses a helper's session: what the team knows can hold the owner's costs and suppliers, and a helper's work is the
//   conversations.
// - What the API would refuse for a fact's words or id is refused here first, by rules said once beside the protocol
//   (src/runtime/memory.ts), which Practice keeps too. A change is sent as exactly the fields its route reads: `{ text }`, `{ id }`,
//   `{ id, text }`, and never a shop, a tenant or a role, which the API refuses.
// - What the API answers is read field by field. A fact this build cannot read whole makes the whole list unreadable rather than
//   leave it out, since half of what the team knows is never shown as all of it; an answer to a change that this build cannot read
//   is `unavailable`, never done, and the page reads the list again to see.
// - A change that got no answer (offline, too slow, a 5xx) is never sent again from here: the API may have it, and the page's next
//   read of the list says. Every 5xx reaches this build as no answer, `memory_unavailable` among them.
// - Nothing the owner typed or the API sent is kept here: not in the host, the saved read of the shop, an event or a log. The page
//   holds the list in its own state, and what the team knows stays out of the file kept for offline use. While only a kept read of
//   the shop is shown (the API cannot be reached), nothing here is sent or read: the kept read holds none of it, and a change made
//   blind could act on a list that moved on.
import { MAX_FACTS, MAX_TEXT } from "@manut/shop-memory";
import { t } from "../../i18n";
import { factIdOk, factTextRefusal, type MemoryFact, type MemoryOps, type MemorySource } from "../memory";
import { OpError } from "../mock/host";
import type { OwnerLink } from "./connections";
import type { ShopAnswer } from "./shops";

/** The shop's facts: `GET` lists them. */
export const MEMORY_PATH = "/v1/memory";
export const REMEMBER_PATH = "/v1/memory/remember";
export const CONFIRM_PATH = "/v1/memory/confirm";
export const CORRECT_PATH = "/v1/memory/correct";
export const FORGET_PATH = "/v1/memory/forget";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
/** A time or a count from the API: a finite number, else null. */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Where a fact came from, as the API keeps it (`FactSource` in `@manut/shop-memory`), a document's date in seconds as the protocol
 *  counts them; null for a kind this build does not know or one that is not whole. */
export function decodeSource(v: unknown): MemorySource | null {
  if (!isObj(v)) return null;
  switch (v.kind) {
    case "owner":
      return { kind: "owner" };
    case "document": {
      const date = num(v.date);
      return typeof v.name === "string" && date !== null ? { kind: "document", name: v.name, date: Math.floor(date / 1000) } : null;
    }
    case "edits": {
      const count = num(v.count);
      return count !== null ? { kind: "edits", count } : null;
    }
    case "orders": {
      const days = num(v.days);
      return days !== null ? { kind: "orders", days } : null;
    }
    case "connection":
      return typeof v.name === "string" && typeof v.detail === "string" ? { kind: "connection", name: v.name, detail: v.detail } : null;
    case "customer":
      return typeof v.chat === "string" ? { kind: "customer", chat: v.chat } : null;
    default:
      return null;
  }
}

/** One fact of the API's answer (`Fact` in docs/pilot-api.md), its times in seconds, or null when this build cannot read it whole:
 *  a status it does not know above all, since it is never shown as used or as waiting on a guess. */
export function decodeFact(v: unknown): MemoryFact | null {
  if (!isObj(v) || !factIdOk(v.id) || typeof v.text !== "string" || v.text === "") return null;
  if (v.status !== "confirmed" && v.status !== "waiting") return null;
  const updatedAt = num(v.updatedAt);
  const source = decodeSource(v.source);
  // the owner's correction is optional, but one that is there must be a time
  const correctedAt = v.correctedAt === undefined ? null : num(v.correctedAt);
  if (updatedAt === null || source === null || (v.correctedAt !== undefined && correctedAt === null)) return null;
  return { id: v.id, text: v.text, status: v.status, source, at: updatedAt / 1000, correctedAt: correctedAt === null ? null : correctedAt / 1000 };
}

/** Every fact of `GET /v1/memory`, in the order the API kept them (the order they were made), or null when the answer is not a
 *  memory or any fact in it cannot be read. */
export function decodeFacts(json: unknown): MemoryFact[] | null {
  if (!isObj(json) || !Array.isArray(json.facts)) return null;
  const facts = json.facts.map(decodeFact);
  return facts.every((f): f is MemoryFact => f !== null) ? facts : null;
}

/** What the page says when the API refused a change, by its code: the package's refusals in plain words (the page says them in
 *  its own words too, by the same codes), the owner-only rule, and a person with no shop. Any other refusal is "did not make this
 *  change". Never a word of what was typed. */
const REFUSED: Record<string, () => string> = {
  owner_only: () => t("memory.err.ownerOnly"),
  no_shop: () => t("memory.err.noShop"),
  not_found: () => t("memory.refuse.not_found"),
  invalid_text: () => t("memory.refuse.invalid_text", { max: MAX_TEXT }),
  already_known: () => t("memory.refuse.already_known"),
  full: () => t("memory.refuse.full", { max: MAX_FACTS }),
};

export const refusal = (code: string): OpError => new OpError(code, (REFUSED[code] ?? (() => t("rt.change.refused")))());

/** A shop that is not one of the person's, or a read of one the API has no record of: not in this shop, whatever it was. */
const shopGone = (): OpError => new OpError("not_found", t("rt.notFound"));

type Handlers = { [K in keyof MemoryOps]: (p: MemoryOps[K]["params"]) => Promise<MemoryOps[K]["result"]> };

/** The five memory ops over `link`. */
export function memoryHandlers(link: OwnerLink): Handlers {
  /** The JSON of an answer that did what it said, or the refusal to throw. `changing`: the request made a change, so an API that
   *  does not answer leaves it unknown whether it was made, which the words say (the page reads the list again to see). */
  const ok = (answer: ShopAnswer, shop: string, changing: boolean): unknown => {
    if (answer.kind === "ok") return answer.json;
    if (answer.kind === "left") throw link.departed(shop, answer.departure);
    if (answer.kind === "refused") {
      if (changing) throw refusal(answer.code);
      // A read has no fact that could be gone: a 404 is a shop the API has no record of, and a 403 the owner's rule. Anything else
      // the API says of a read, this build has no words for.
      if (answer.code === "not_found") throw shopGone();
      if (answer.code === "owner_only") throw refusal("owner_only");
      throw new OpError("unavailable", t("memory.err.unavailable"));
    }
    if (answer.kind === "signed_out") throw new OpError("signed_out", t("rt.signedOut"));
    if (answer.kind === "offline") throw new OpError("offline", t("rt.offline"));
    throw new OpError("unavailable", changing ? t("rt.change.noReply") : t("memory.err.unavailable"));
  };
  /** The shop a change names, checked here with nothing sent: one of the person's shops, which they own. A person in no shops names
   *  none, and has none to change. */
  const target = (shop: unknown): string => {
    if (shop === null && !link.inShops()) throw refusal("no_shop");
    const role = typeof shop === "string" ? link.roleAt(shop) : undefined;
    if (!role) throw shopGone();
    if (role !== "owner") throw refusal("owner_only");
    return shop as string;
  };
  /** A fact a change is about: one the API could have, else it is gone. */
  const fact = (v: unknown): string => {
    if (!factIdOk(v)) throw refusal("not_found");
    return v;
  };
  /** The fact an answer to a change holds, which must be the one the change was about; else it is not one this build can read. */
  const changed = (json: unknown, id?: string): MemoryFact => {
    const made = decodeFact(json);
    if (!made || (id !== undefined && made.id !== id)) throw new OpError("unavailable", t("rt.change.unreadable"));
    return made;
  };
  /** A fact's new words: what the package would refuse is refused here, and what is sent is trimmed, as the package keeps it. */
  const words = (text: unknown): string => {
    const refused = factTextRefusal(text);
    if (refused) throw refusal(refused);
    return (text as string).trim();
  };

  return {
    "memory.list": async () => {
      link.live();
      const viewed = await link.viewed();
      if (!viewed) throw refusal("no_shop");
      if (viewed.role !== "owner") throw refusal("owner_only");
      const facts = decodeFacts(ok(await link.read(viewed.shop, MEMORY_PATH), viewed.shop, false));
      if (!facts) throw new OpError("unavailable", t("memory.err.unreadable"));
      return { shop: viewed.shop, facts };
    },

    "memory.remember": async (p) => {
      link.live();
      const shop = target(p.shop);
      const text = words(p.text);
      return { fact: changed(ok(await link.write(shop, REMEMBER_PATH, { text }), shop, true)) };
    },

    "memory.confirm": async (p) => {
      link.live();
      const shop = target(p.shop);
      const id = fact(p.fact);
      return { fact: changed(ok(await link.write(shop, CONFIRM_PATH, { id }), shop, true), id) };
    },

    "memory.correct": async (p) => {
      link.live();
      const shop = target(p.shop);
      const id = fact(p.fact);
      const text = words(p.text);
      return { fact: changed(ok(await link.write(shop, CORRECT_PATH, { id, text }), shop, true), id) };
    },

    "memory.forget": async (p) => {
      link.live();
      const shop = target(p.shop);
      const id = fact(p.fact);
      const json = ok(await link.write(shop, FORGET_PATH, { id }), shop, true);
      // The answer names the fact and holds none of it: the words are gone, and nothing here asks for them back.
      if (!isObj(json) || json.id !== id) throw new OpError("unavailable", t("rt.change.unreadable"));
      return { fact: id };
    },
  };
}
