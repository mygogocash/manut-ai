// Practice's vault and outposts (docs/browser-control.md, "The owner's Connections"), so Customize › Connections can be
// seen and tried without an API: two sample sign-ins, one of them refused by its site this morning, as the design canvas's
// states board draws them, and two sample outposts, a Mac at the front desk and a cloud outpost. They belong to the person's
// own shop; at Ran Pa Noi, the sample shop they help at, a helper sees none (host.ts).
//
// The rules are the API's (apps/api/src/sign-in-vault.ts), said again for Practice: a password is 1 to 1,024 characters, an
// outpost's name is 1 to 80 letters once trimmed, with no control characters, and a new sign-in, who may use one and a
// change of its account or addresses follow the vault's own rules (`newSignInRefusal`, `membersOf` and
// `signInChangeRefusal` in ../connections.ts), up to 50 sign-ins: a change that could send the password somewhere new
// needs it typed again. A password is never kept, not even here: Add and Change keep only when it was set, and the value
// is dropped. Nothing here is real, and nothing leaves the app.
import {
  changeShapeRefusal,
  MAX_OUTPOST_NAME,
  MAX_PASSWORD,
  MAX_SIGN_INS,
  membersOf,
  newSignInRefusal,
  originsOf,
  signInChangeRefusal,
  siteOf,
  type NewSignIn,
  type ShopConnections,
  type ShopOutpost,
  type SignInChange,
  type VaultSignIn,
} from "../connections";

export type VaultResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** Characters that cannot be typed into a name, as the API counts them. */
const CONTROL = /[\u0000-\u001f\u007f]/;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const refused = (code: string, message: string): VaultResult<never> => ({ ok: false, code, message });

/** A sign-in the caller cannot change the vault through: its lists are copies too. */
const copyOf = (s: VaultSignIn): VaultSignIn => ({ ...s, origins: [...s.origins], members: [...s.members] });

/** Practice's words for what the vault refuses: the runtime's own, which the page replaces with its own words by code. */
const REFUSED: Record<string, string> = {
  invalid_site: "A site's name is 1 to 80 letters.",
  invalid_origins: "A sign-in has 1 to 5 of the site's own addresses, each starting with https://.",
  invalid_username: "The account's name is 1 to 256 characters.",
  invalid_password: `A password is 1 to ${MAX_PASSWORD} characters.`,
  invalid_members: "Choose who may use it: Nam, Pim, Ton or Kit.",
  no_change: "That is the account and the addresses it has now.",
  password_required: "Type its password again to give it a new account or a new address.",
};
const GONE = "That sign-in is not in the vault.";

export class PracticeVault {
  private signIns: VaultSignIn[];
  private outposts: ShopOutpost[];
  /** How many sign-ins were added here, so each gets an id of its own. */
  private added = 0;

  /** The sample vault as it stands at `now` (seconds): the Shopee sign-in used by Nam 40 minutes ago, the carrier portal's
   *  refused by its site 25 minutes ago, the front desk's Mac online and the cloud outpost asleep. */
  constructor(now: number) {
    this.signIns = [
      {
        id: "practice-signin-shopee",
        site: "Shopee Seller Centre",
        username: "baan.mali@example.com",
        origins: ["https://seller.shopee.co.th", "https://accounts.shopee.co.th"],
        members: ["nam", "ton"],
        state: "working",
        passwordSetAt: now - 20 * DAY,
        brokenAt: null,
        brokenBy: null,
        lastUsedAt: now - 40 * MINUTE,
        lastUsedBy: "nam",
        createdAt: now - 20 * DAY,
      },
      {
        id: "practice-signin-carrier",
        site: "Carrier portal",
        username: "baanmali",
        origins: ["https://track.carrier.example"],
        members: ["nam"],
        state: "broken",
        passwordSetAt: now - 12 * DAY,
        brokenAt: now - 25 * MINUTE,
        brokenBy: "nam",
        lastUsedAt: now - 26 * HOUR,
        lastUsedBy: "nam",
        createdAt: now - 12 * DAY,
      },
    ];
    this.outposts = [
      { id: "practice-outpost-front-desk", name: "Front desk Mac", kind: "this_mac", online: true, lastSeenAt: now - 10, createdAt: now - 9 * DAY },
      { id: "practice-outpost-cloud", name: "Cloud outpost", kind: "cloud", online: false, lastSeenAt: now - 3 * HOUR, createdAt: now - 20 * DAY },
    ];
  }

  /** The shop's sign-ins and outposts, oldest first, each a copy the caller cannot change the vault through. */
  list(shop: string): ShopConnections {
    return { shop, signIns: this.signIns.map(copyOf), outposts: this.outposts.map((o) => ({ ...o })) };
  }

  /** A new sign-in, added at `now` by the vault's rules, working and never used yet. The password is checked and then
   *  dropped, as Change drops it: only the time it was set is kept. */
  add(fields: Partial<Record<keyof NewSignIn, unknown>>, now: number): VaultResult<VaultSignIn> {
    const code = newSignInRefusal(fields);
    if (code) return refused(code, REFUSED[code] ?? code);
    if (this.signIns.length >= MAX_SIGN_INS) return refused("too_many_sign_ins", `A shop's vault keeps ${MAX_SIGN_INS} sign-ins.`);
    this.added += 1;
    const signIn: VaultSignIn = {
      id: `practice-signin-added-${this.added}`,
      site: siteOf(fields.site)!,
      // Kept exactly as sent, as the vault keeps the account's name.
      username: fields.username as string,
      origins: originsOf(fields.origins)!,
      members: membersOf(fields.members)!,
      state: "working",
      passwordSetAt: now,
      brokenAt: null,
      brokenBy: null,
      lastUsedAt: null,
      lastUsedBy: null,
      createdAt: now,
    };
    this.signIns.push(signIn);
    return { ok: true, value: copyOf(signIn) };
  }

  /** Who may use a sign-in from now on, by the vault's rule for members. Nothing else about it changes. */
  members(signIn: unknown, members: unknown): VaultResult<VaultSignIn> {
    const chosen = membersOf(members);
    if (!chosen) return refused("invalid_members", REFUSED.invalid_members!);
    const at = this.signIns.findIndex((s) => s.id === signIn);
    if (at < 0) return refused("sign_in_not_found", GONE);
    const changed: VaultSignIn = { ...this.signIns[at]!, members: chosen };
    this.signIns[at] = changed;
    return { ok: true, value: copyOf(changed) };
  }

  /** A sign-in's account and addresses from now on, at `now`, by the vault's rule for a change: the values first, as adding
   *  checks them, then the sign-in, then that a change which could send the password somewhere new has it typed again. A
   *  password typed again mends a broken sign-in, as a new password does, and is then dropped; addresses only taken away
   *  leave it as it was. Who may use it stays. */
  change(signIn: unknown, fields: Partial<Record<keyof SignInChange, unknown>>, now: number): VaultResult<VaultSignIn> {
    const shape = changeShapeRefusal(fields);
    if (shape) return refused(shape, REFUSED[shape] ?? shape);
    const at = this.signIns.findIndex((s) => s.id === signIn);
    if (at < 0) return refused("sign_in_not_found", GONE);
    const current = this.signIns[at]!;
    const code = signInChangeRefusal(current, fields);
    if (code) return refused(code, REFUSED[code] ?? code);
    const typed = typeof fields.password === "string";
    const changed: VaultSignIn = {
      ...current,
      origins: originsOf(fields.origins)!,
      username: fields.username as string,
      ...(typed ? { state: "working" as const, passwordSetAt: now, brokenAt: null, brokenBy: null } : {}),
    };
    this.signIns[at] = changed;
    return { ok: true, value: copyOf(changed) };
  }

  /** Removes a sign-in, as the vault's removal does: nothing of it is kept to bring back. Its id is what the answer names. */
  removeSignIn(signIn: unknown): VaultResult<string> {
    const found = this.signIns.find((s) => s.id === signIn);
    if (!found) return refused("sign_in_not_found", GONE);
    this.signIns = this.signIns.filter((s) => s !== found);
    return { ok: true, value: found.id };
  }

  /** A new password for a sign-in, at `now`. It mends a broken sign-in, as the vault's does. The password itself is checked
   *  and then dropped: only the time it was set is kept. */
  password(signIn: unknown, password: unknown, now: number): VaultResult<VaultSignIn> {
    if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD) {
      return refused("invalid_password", `A password is 1 to ${MAX_PASSWORD} characters.`);
    }
    const at = this.signIns.findIndex((s) => s.id === signIn);
    if (at < 0) return refused("sign_in_not_found", GONE);
    const mended: VaultSignIn = { ...this.signIns[at]!, state: "working", passwordSetAt: now, brokenAt: null, brokenBy: null };
    this.signIns[at] = mended;
    return { ok: true, value: copyOf(mended) };
  }

  /** A new name for an outpost, trimmed. Only the name changes. */
  rename(outpost: unknown, name: unknown): VaultResult<ShopOutpost> {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || [...trimmed].length > MAX_OUTPOST_NAME || CONTROL.test(trimmed)) {
      return refused("invalid_name", `A name is 1 to ${MAX_OUTPOST_NAME} letters.`);
    }
    const at = this.outposts.findIndex((o) => o.id === outpost);
    if (at < 0) return refused("outpost_not_found", "That outpost is not the shop's.");
    this.outposts[at] = { ...this.outposts[at], name: trimmed };
    return { ok: true, value: { ...this.outposts[at] } };
  }

  /** Removes an outpost. Its id is what the answer names. */
  remove(outpost: unknown): VaultResult<string> {
    const found = this.outposts.find((o) => o.id === outpost);
    if (!found) return refused("outpost_not_found", "That outpost is not the shop's.");
    this.outposts = this.outposts.filter((o) => o !== found);
    return { ok: true, value: found.id };
  }
}
