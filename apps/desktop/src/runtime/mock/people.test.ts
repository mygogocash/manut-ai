// Practice's people (people.ts), through the in-process runtime as Settings › People asks for them: the canvas's sample, Fon the
// owner, Mint a helper and Beam invited, and each change by the same rules as the shop's record, because they are the same code
// (`@manut/people-rules`): one invite for one account at a time, cancelling one that waits, removing a helper (which ends their
// sessions, their invites and their cover), cover until a day that has not passed, and Ran Pa Noi, where the person helps, refused
// as a helper's session is on the connected runtime.
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import { MockHost, MockRuntime } from "./index";
import { PRACTICE_JOIN } from "./people";
import { HELPED_SHOP, OWN_SHOP } from "./shops";

const T0 = 1_800_000_000;
const DAY = 86_400;

async function open(host = new MockHost({ now: () => T0 })) {
  const rt = new MockRuntime(host);
  await rt.connect();
  return { rt, host };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code: string }) => e.code);

beforeEach(() => setLang("en"));

describe("Practice's people", () => {
  it("lists the canvas's sample: Fon the owner, Mint a helper since three weeks ago, and Beam invited 40 minutes ago", async () => {
    const { rt } = await open();
    expect(await rt.request("people.list", {})).toEqual({
      shop: OWN_SHOP,
      owner: { name: "Fon", devices: 1 },
      helpers: [{ id: "practice-helper-mint", name: "Mint", identity: { kind: "email", address: "mint@example.com" }, joinedAt: T0 - 22 * DAY, devices: 2 }],
      invites: [
        {
          id: "practice-invite-beam",
          name: "Beam",
          identity: { kind: "line", id: "beam.baanmali" },
          state: "pending",
          createdAt: T0 - 40 * 60,
          expiresAt: T0 - 40 * 60 + 7 * DAY,
          link: `${PRACTICE_JOIN}practice-invite-beam`,
        },
      ],
      away: null,
    });
  });

  it("gives an invite a link that can never be a real one, so a copy from Practice cannot be taken for a real invite", async () => {
    const { rt } = await open();
    const { invite } = await rt.request("people.invite", { shop: OWN_SHOP, name: "Tum", identity: { kind: "email", address: "tum@example.com" } });
    expect(new URL(invite.link!).hostname.endsWith(".invalid")).toBe(true);
    expect((await rt.request("people.list", {})).invites.every((i) => new URL(i.link!).hostname.endsWith(".invalid"))).toBe(true);
  });

  it("makes an invite for one account, newest first, trimmed, and refuses a second for the same account while the first waits", async () => {
    const { rt } = await open();
    const { invite } = await rt.request("people.invite", { shop: OWN_SHOP, name: "  Tum  ", identity: { kind: "email", address: " Tum@Example.com " } });
    expect(invite).toMatchObject({ name: "Tum", identity: { kind: "email", address: "Tum@Example.com" }, state: "pending", createdAt: T0, expiresAt: T0 + 7 * DAY });
    expect((await rt.request("people.list", {})).invites.map((i) => i.name)).toEqual(["Tum", "Beam"]);
    // the same account in other letters, and Beam's LINE ID, each already has an invite waiting; Mint is already a helper
    expect(await refusal(rt.request("people.invite", { shop: OWN_SHOP, name: "Tum again", identity: { kind: "email", address: "tum@example.com" } }))).toBe("already_invited");
    expect(await refusal(rt.request("people.invite", { shop: OWN_SHOP, name: "Beam again", identity: { kind: "line", id: "beam.baanmali" } }))).toBe("already_invited");
    expect(await refusal(rt.request("people.invite", { shop: OWN_SHOP, name: "Mint again", identity: { kind: "email", address: "MINT@example.com" } }))).toBe("already_helper");
    // a LINE ID is compared exactly
    expect((await rt.request("people.invite", { shop: OWN_SHOP, name: "Beam B", identity: { kind: "line", id: "Beam.Baanmali" } })).invite.state).toBe("pending");
  });

  it("refuses a name or an account the rules would refuse, as the connected runtime does", async () => {
    const { rt } = await open();
    for (const name of ["", "   ", "x".repeat(81), "Tum\u0007"]) {
      expect(await refusal(rt.request("people.invite", { shop: OWN_SHOP, name, identity: { kind: "line", id: "tum" } })), name).toBe("invalid_name");
    }
    for (const identity of [{ kind: "line", id: " " }, { kind: "email", address: "no-at" }, { kind: "line", id: "x", extra: 1 }, null]) {
      expect(await refusal(rt.request("people.invite", { shop: OWN_SHOP, name: "Tum", identity: identity as never })), JSON.stringify(identity)).toBe("bad_identity");
    }
    expect((await rt.request("people.list", {})).invites).toHaveLength(1);
  });

  it("cancels an invite that waits, once", async () => {
    const { rt } = await open();
    expect(await rt.request("people.cancelInvite", { shop: OWN_SHOP, invite: "practice-invite-beam" })).toEqual({ invite: "practice-invite-beam" });
    expect((await rt.request("people.list", {})).invites).toEqual([]);
    expect(await refusal(rt.request("people.cancelInvite", { shop: OWN_SHOP, invite: "practice-invite-beam" }))).toBe("not_pending");
    expect(await refusal(rt.request("people.cancelInvite", { shop: OWN_SHOP, invite: "nowhere" }))).toBe("unknown_invite");
    // Beam can be invited again once the first invite is cancelled
    expect((await rt.request("people.invite", { shop: OWN_SHOP, name: "Beam", identity: { kind: "line", id: "beam.baanmali" } })).invite.state).toBe("pending");
  });

  it("removes a helper: their sessions end and their cover goes, and nothing brings them back but a new invite", async () => {
    const { rt } = await open();
    // Mint covers while the owner is away
    await rt.request("people.setAway", { shop: OWN_SHOP, helper: "practice-helper-mint", until: T0 + 3 * DAY });
    expect(await rt.request("people.remove", { shop: OWN_SHOP, helper: "practice-helper-mint" })).toEqual({ helper: "practice-helper-mint", sessionsEnded: 2, invitesRevoked: 0, coverEnded: true });
    const after = await rt.request("people.list", {});
    expect(after.helpers).toEqual([]);
    expect(after.away).toBeNull();
    expect(await refusal(rt.request("people.remove", { shop: OWN_SHOP, helper: "practice-helper-mint" }))).toBe("not_a_helper");
    // the same account can be invited again, and becomes someone new
    expect((await rt.request("people.invite", { shop: OWN_SHOP, name: "Mint", identity: { kind: "email", address: "mint@example.com" } })).invite.state).toBe("pending");
  });

  it("sets the cover for one helper until a day that has not passed, in force until then, and ends it", async () => {
    const { rt } = await open();
    const until = T0 + 3 * DAY;
    expect(await rt.request("people.setAway", { shop: OWN_SHOP, helper: "practice-helper-mint", until })).toEqual({ away: { helperId: "practice-helper-mint", name: "Mint", until, inForce: true } });
    expect((await rt.request("people.list", {})).away).toEqual({ helperId: "practice-helper-mint", name: "Mint", until, inForce: true });
    expect(await refusal(rt.request("people.setAway", { shop: OWN_SHOP, helper: "practice-helper-mint", until: T0 }))).toBe("bad_date");
    expect(await refusal(rt.request("people.setAway", { shop: OWN_SHOP, helper: "practice-helper-mint", until: T0 - DAY }))).toBe("bad_date");
    expect(await refusal(rt.request("people.setAway", { shop: OWN_SHOP, helper: "practice-helper-mint", until: Number.NaN }))).toBe("bad_date");
    expect(await refusal(rt.request("people.setAway", { shop: OWN_SHOP, helper: "nobody", until }))).toBe("not_a_helper");
    expect(await rt.request("people.clearAway", { shop: OWN_SHOP })).toEqual({ away: null });
    expect((await rt.request("people.list", {})).away).toBeNull();
    // ending a cover nobody holds changes nothing
    expect(await rt.request("people.clearAway", { shop: OWN_SHOP })).toEqual({ away: null });
  });

  it("says the cover is over, not in force, once its day has passed", async () => {
    let now = T0;
    const { rt } = await open(new MockHost({ now: () => now }));
    await rt.request("people.setAway", { shop: OWN_SHOP, helper: "practice-helper-mint", until: T0 + DAY });
    now = T0 + 2 * DAY;
    expect((await rt.request("people.list", {})).away).toMatchObject({ helperId: "practice-helper-mint", inForce: false });
  });

  it("shows an invite that ran out as one that ran out, with no link, once its 7 days are past", async () => {
    let now = T0;
    const { rt } = await open(new MockHost({ now: () => now }));
    now = T0 + 8 * DAY;
    const [beam] = (await rt.request("people.list", {})).invites;
    expect(beam).toMatchObject({ id: "practice-invite-beam", state: "expired", link: null });
  });

  it("refuses Ran Pa Noi, where the person helps, and any other shop, as a helper's session is on the connected runtime", async () => {
    const { rt } = await open();
    await rt.request("shops.switch", { shop: HELPED_SHOP });
    expect(await refusal(rt.request("people.list", {}))).toBe("owner_only");
    const calls: [string, Record<string, unknown>][] = [
      ["people.invite", { shop: HELPED_SHOP, name: "Tum", identity: { kind: "line", id: "tum" } }],
      ["people.cancelInvite", { shop: HELPED_SHOP, invite: "practice-invite-beam" }],
      ["people.remove", { shop: HELPED_SHOP, helper: "practice-helper-mint" }],
      ["people.setAway", { shop: HELPED_SHOP, helper: "practice-helper-mint", until: T0 + DAY }],
      ["people.clearAway", { shop: HELPED_SHOP }],
    ];
    for (const [op, params] of calls) expect(await refusal((rt.request as (op: string, p: unknown) => Promise<unknown>)(op, params)), op).toBe("owner_only");
    expect(await refusal(rt.request("people.remove", { shop: "practice:nowhere", helper: "practice-helper-mint" }))).toBe("not_found");
    // the person's own shop was not touched by any of it
    await rt.request("shops.switch", { shop: OWN_SHOP });
    const own = await rt.request("people.list", {});
    expect([own.helpers.length, own.invites.length]).toEqual([1, 1]);
  });

  it("changes the shop its list was read for, even after the switcher moved", async () => {
    const { rt } = await open();
    const listed = await rt.request("people.list", {});
    await rt.request("shops.switch", { shop: HELPED_SHOP });
    expect(await rt.request("people.cancelInvite", { shop: listed.shop, invite: "practice-invite-beam" })).toEqual({ invite: "practice-invite-beam" });
    await rt.request("shops.switch", { shop: OWN_SHOP });
    expect((await rt.request("people.list", {})).invites).toEqual([]);
  });

  it("starts from the sample again after a reset, and keeps no link, name or account anywhere a list does not show it", async () => {
    const { rt, host } = await open();
    const { invite } = await rt.request("people.invite", { shop: OWN_SHOP, name: "Tum", identity: { kind: "email", address: "tum@example.com" } });
    expect(JSON.stringify(await rt.request("people.list", {}))).toContain(invite.link!);
    host.reset();
    expect((await rt.request("people.list", {})).invites.map((i) => i.name)).toEqual(["Beam"]);
  });
});
