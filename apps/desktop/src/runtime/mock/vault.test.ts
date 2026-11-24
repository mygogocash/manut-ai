// Practice's vault and outposts (vault.ts), through the in-process runtime as Customize › Connections asks for them: the
// person's own shop's two sample sign-ins and two sample outposts, a new password that mends the refused one and is kept
// nowhere, a rename and a removal by the vault's own rules, and Ran Pa Noi, where the person helps, refused as a helper's
// session is on the connected runtime.
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import { MockHost, MockRuntime } from "./index";
import { HELPED_SHOP, OWN_SHOP } from "./shops";

const T0 = 1_800_000_000;
// Made up, and never a real password: a search for it finds only what this file typed.
const PASSWORD = "practice-pw-7f3a9c";

async function open(host = new MockHost({ now: () => T0 })) {
  const rt = new MockRuntime(host);
  await rt.connect();
  return { rt, host };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code: string }) => e.code);

beforeEach(() => setLang("en"));

describe("Practice's vault and outposts", () => {
  it("lists the person's own shop's sample sign-ins and outposts, oldest first", async () => {
    const { rt } = await open();
    const listed = await rt.request("connections.list", {});
    expect(listed.shop).toBe(OWN_SHOP);
    expect(listed.signIns).toEqual([
      { id: "practice-signin-shopee", site: "Shopee Seller Centre", members: ["nam", "ton"], state: "working", passwordSetAt: T0 - 20 * 86_400,
        brokenAt: null, brokenBy: null, lastUsedAt: T0 - 40 * 60, lastUsedBy: "nam", createdAt: T0 - 20 * 86_400 },
      { id: "practice-signin-carrier", site: "Carrier portal", members: ["nam"], state: "broken", passwordSetAt: T0 - 12 * 86_400,
        brokenAt: T0 - 25 * 60, brokenBy: "nam", lastUsedAt: T0 - 26 * 3600, lastUsedBy: "nam", createdAt: T0 - 12 * 86_400 },
    ]);
    expect(listed.outposts.map((o) => [o.name, o.kind, o.online])).toEqual([
      ["Front desk Mac", "this_mac", true],
      ["Cloud outpost", "cloud", false],
    ]);
  });

  it("takes a new password for the refused sign-in, mends it, and keeps the password nowhere", async () => {
    const { rt, host } = await open();
    const { signIn } = await rt.request("connections.password", { shop: OWN_SHOP, signIn: "practice-signin-carrier", password: PASSWORD });
    expect(signIn).toMatchObject({ id: "practice-signin-carrier", state: "working", passwordSetAt: T0, brokenAt: null, brokenBy: null });
    expect((await rt.request("connections.list", {})).signIns[1]).toEqual(signIn);
    // Nothing the runtime holds or answers carries it: not the vault, not any list.
    expect(JSON.stringify(host)).not.toContain(PASSWORD);
    expect(JSON.stringify(await rt.request("connections.list", {}))).not.toContain(PASSWORD);
  });

  it("refuses a password the vault would not take, and a sign-in it does not have", async () => {
    const { rt } = await open();
    for (const password of ["", "x".repeat(1025)]) {
      expect(await refusal(rt.request("connections.password", { shop: OWN_SHOP, signIn: "practice-signin-carrier", password }))).toBe("invalid_password");
    }
    expect(await refusal(rt.request("connections.password", { shop: OWN_SHOP, signIn: "nowhere", password: PASSWORD }))).toBe("sign_in_not_found");
    expect((await rt.request("connections.list", {})).signIns[1].state).toBe("broken");
  });

  it("renames an outpost, trimmed, by the vault's rule for a name, and removes one", async () => {
    const { rt } = await open();
    const { outpost } = await rt.request("connections.rename", { shop: OWN_SHOP, outpost: "practice-outpost-front-desk", name: "  Counter Mac  " });
    expect(outpost).toMatchObject({ id: "practice-outpost-front-desk", name: "Counter Mac", kind: "this_mac" });
    for (const name of ["   ", "x".repeat(81), "Mac\u0007"]) {
      expect(await refusal(rt.request("connections.rename", { shop: OWN_SHOP, outpost: "practice-outpost-front-desk", name }))).toBe("invalid_name");
    }
    expect(await rt.request("connections.remove", { shop: OWN_SHOP, outpost: "practice-outpost-cloud" })).toEqual({ outpost: "practice-outpost-cloud" });
    expect((await rt.request("connections.list", {})).outposts.map((o) => o.name)).toEqual(["Counter Mac"]);
    expect(await refusal(rt.request("connections.remove", { shop: OWN_SHOP, outpost: "practice-outpost-cloud" }))).toBe("outpost_not_found");
  });

  it("refuses Ran Pa Noi, where the person helps, as the API refuses a helper's session, and a shop that is not theirs", async () => {
    const { rt } = await open();
    await rt.request("shops.switch", { shop: HELPED_SHOP });
    expect(await refusal(rt.request("connections.list", {}))).toBe("owner_only");
    expect(await refusal(rt.request("connections.password", { shop: HELPED_SHOP, signIn: "practice-signin-shopee", password: PASSWORD }))).toBe("owner_only");
    expect(await refusal(rt.request("connections.remove", { shop: "practice:nowhere", outpost: "practice-outpost-cloud" }))).toBe("not_found");
    // A change names the shop its row was read for, so the person's own shop's rows still take one while Ran Pa Noi is viewed.
    expect((await rt.request("connections.rename", { shop: OWN_SHOP, outpost: "practice-outpost-cloud", name: "Night outpost" })).outpost.name).toBe("Night outpost");
  });

  it("starts again from the samples on a reset", async () => {
    const { rt, host } = await open();
    await rt.request("connections.remove", { shop: OWN_SHOP, outpost: "practice-outpost-cloud" });
    host.reset();
    expect((await rt.request("connections.list", {})).outposts).toHaveLength(2);
  });
});
