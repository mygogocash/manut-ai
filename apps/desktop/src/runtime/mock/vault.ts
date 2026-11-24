// Practice's vault and outposts (docs/browser-control.md, "The owner's Connections"), so Customize › Connections can be
// seen and tried without an API: two sample sign-ins, one of them refused by its site this morning, as the design canvas's
// states board draws them, and two sample outposts, a Mac at the front desk and a cloud outpost. They belong to the person's
// own shop; at Ran Pa Noi, the sample shop they help at, a helper sees none (host.ts).
//
// The rules are the API's (apps/api/src/sign-in-vault.ts), said again for Practice: a password is 1 to 1,024 characters, an
// outpost's name is 1 to 80 letters once trimmed, with no control characters. A password is never kept, not even here:
// Change marks the sign-in working with its password set now, and the value is dropped. Nothing here is real, and nothing
// leaves the app.
import { MAX_OUTPOST_NAME, MAX_PASSWORD, type ShopConnections, type ShopOutpost, type VaultSignIn } from "../connections";

export type VaultResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** Characters that cannot be typed into a name, as the API counts them. */
const CONTROL = /[\u0000-\u001f\u007f]/;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const refused = (code: string, message: string): VaultResult<never> => ({ ok: false, code, message });

export class PracticeVault {
  private signIns: VaultSignIn[];
  private outposts: ShopOutpost[];

  /** The sample vault as it stands at `now` (seconds): the Shopee sign-in used by Nam 40 minutes ago, the carrier portal's
   *  refused by its site 25 minutes ago, the front desk's Mac online and the cloud outpost asleep. */
  constructor(now: number) {
    this.signIns = [
      {
        id: "practice-signin-shopee",
        site: "Shopee Seller Centre",
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
    return { shop, signIns: this.signIns.map((s) => ({ ...s, members: [...s.members] })), outposts: this.outposts.map((o) => ({ ...o })) };
  }

  /** A new password for a sign-in, at `now`. It mends a broken sign-in, as the vault's does. The password itself is checked
   *  and then dropped: only the time it was set is kept. */
  password(signIn: unknown, password: unknown, now: number): VaultResult<VaultSignIn> {
    if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD) {
      return refused("invalid_password", `A password is 1 to ${MAX_PASSWORD} characters.`);
    }
    const at = this.signIns.findIndex((s) => s.id === signIn);
    if (at < 0) return refused("sign_in_not_found", "That sign-in is not in the vault.");
    const mended: VaultSignIn = { ...this.signIns[at], state: "working", passwordSetAt: now, brokenAt: null, brokenBy: null };
    this.signIns[at] = mended;
    return { ok: true, value: { ...mended, members: [...mended.members] } };
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
