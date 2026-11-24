import { describe, expect, it } from "vitest";
import { ApiError, type JoinAnswer, type PilotApi } from "../src/api";
import { createFakeApi, DEMO_JOIN_SHOP, DEMO_JOIN_TOKENS, PRACTICE_SIGN_IN_CODE } from "../src/api/fake";

const NOW = Date.parse("2026-11-24T03:00:00Z");
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const BAAN_MALI = "shop_baanmali";
const DEVICE = "web-practice";

function memory() {
  const saved = new Map<string, string>();
  return {
    saved,
    storage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key),
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the call to be refused");
}

/// Signs `email` in with practice's code and answers the access token.
async function signIn(api: PilotApi, email: string): Promise<string> {
  await api.requestEmailCode(email);
  return (await api.exchangeEmailCode({ email, code: PRACTICE_SIGN_IN_CODE, deviceId: DEVICE })).accessToken;
}

describe("the practice fake, signing in by email", () => {
  it("sends practice's one code and signs in with it once, as the API's exchange does", async () => {
    const api = createFakeApi({ now: () => NOW });
    expect(await api.requestEmailCode("  Mint@BaanMali.example ")).toEqual({ sent: true, expiresIn: 600, resendIn: 60 });
    const session = await api.exchangeEmailCode({ email: "mint@baanmali.example", code: PRACTICE_SIGN_IN_CODE, deviceId: DEVICE });
    expect(session).toMatchObject({ expiresIn: 3600 });
    expect(session.accessToken).toBeTruthy();
    expect(session.tenant.startsWith("email:")).toBe(true);
    // The right code is used up: a second try has nothing to try.
    const again = await refusal(api.exchangeEmailCode({ email: "mint@baanmali.example", code: PRACTICE_SIGN_IN_CODE, deviceId: DEVICE }));
    expect([again.status, again.code]).toEqual([401, "code_ended"]);
  });

  it("counts wrong tries down to the code's end, and a new code starts again", async () => {
    let now = NOW;
    const api = createFakeApi({ now: () => now });
    await api.requestEmailCode("mint@baanmali.example");
    const tries: (number | undefined)[] = [];
    for (let i = 0; i < 5; i += 1) {
      const wrong = await refusal(api.exchangeEmailCode({ email: "mint@baanmali.example", code: "111111", deviceId: DEVICE }));
      expect([wrong.status, wrong.code]).toEqual([401, "wrong_code"]);
      tries.push(wrong.triesLeft);
    }
    expect(tries).toEqual([4, 3, 2, 1, 0]);
    // Even the right code is too late once five wrong tries ended it.
    expect((await refusal(api.exchangeEmailCode({ email: "mint@baanmali.example", code: PRACTICE_SIGN_IN_CODE, deviceId: DEVICE })))
      .code).toBe("code_ended");
    now += MINUTE;
    await api.requestEmailCode("mint@baanmali.example");
    const fresh = await refusal(api.exchangeEmailCode({ email: "mint@baanmali.example", code: "222222", deviceId: DEVICE }));
    expect(fresh.triesLeft).toBe(4);
  });

  it("ends a code after its ten minutes", async () => {
    let now = NOW;
    const api = createFakeApi({ now: () => now });
    await api.requestEmailCode("mint@baanmali.example");
    now += 10 * MINUTE;
    const ended = await refusal(api.exchangeEmailCode({ email: "mint@baanmali.example", code: PRACTICE_SIGN_IN_CODE, deviceId: DEVICE }));
    expect([ended.status, ended.code]).toEqual([401, "code_ended"]);
  });

  it("gives an address one code a minute and ten a day, saying how long to wait, and no other address waits for it", async () => {
    let now = NOW;
    const api = createFakeApi({ now: () => now });
    await api.requestEmailCode("mint@baanmali.example");
    now += 18_500;
    const soon = await refusal(api.requestEmailCode("mint@baanmali.example"));
    expect([soon.status, soon.code, soon.retryAfter]).toEqual([429, "too_many_codes", 42]);
    expect(await api.requestEmailCode("beam@baanmali.example")).toMatchObject({ sent: true });
    for (let i = 1; i < 10; i += 1) {
      now = NOW + i * MINUTE;
      await api.requestEmailCode("mint@baanmali.example");
    }
    now = NOW + 10 * MINUTE;
    const daily = await refusal(api.requestEmailCode("mint@baanmali.example"));
    expect([daily.code, daily.retryAfter]).toEqual(["too_many_codes", (DAY - 10 * MINUTE) / 1000]);
    now = NOW + DAY;
    expect(await api.requestEmailCode("mint@baanmali.example")).toMatchObject({ sent: true });
  });

  it("refuses what the API refuses as a request, and a code that is not six digits is not a try", async () => {
    const api = createFakeApi({ now: () => NOW });
    for (const email of ["", "mint", "mint@", "@baanmali.example", "mi nt@baanmali.example", `${"a".repeat(250)}@b.example`]) {
      expect((await refusal(api.requestEmailCode(email))).code, email).toBe("invalid_request");
    }
    await api.requestEmailCode("mint@baanmali.example");
    for (const [code, deviceId] of [["12345", DEVICE], ["1234567", DEVICE], ["12345a", DEVICE], [PRACTICE_SIGN_IN_CODE, ""],
      [PRACTICE_SIGN_IN_CODE, "d".repeat(129)]]) {
      const refused = await refusal(api.exchangeEmailCode({ email: "mint@baanmali.example", code: code!, deviceId: deviceId! }));
      expect([refused.status, refused.code]).toEqual([400, "invalid_request"]);
    }
    const first = await refusal(api.exchangeEmailCode({ email: "mint@baanmali.example", code: "999999", deviceId: DEVICE }));
    expect(first.triesLeft).toBe(4);
  });

  it("answers email_not_configured while the sign-in-off demo link is open, after checking the body", async () => {
    let path = `/join/${DEMO_JOIN_TOKENS.signInOff}`;
    const api = createFakeApi({ now: () => NOW, pagePath: () => path });
    const off = await refusal(api.requestEmailCode("mint@baanmali.example"));
    expect([off.status, off.code]).toEqual([400, "email_not_configured"]);
    expect((await refusal(api.exchangeEmailCode({ email: "mint@baanmali.example", code: PRACTICE_SIGN_IN_CODE, deviceId: DEVICE })))
      .code).toBe("email_not_configured");
    expect((await refusal(api.requestEmailCode("not an address"))).code).toBe("invalid_request");
    path = `/join/${DEMO_JOIN_TOKENS.joined}`;
    expect(await api.requestEmailCode("mint@baanmali.example")).toMatchObject({ sent: true });
  });
});

describe("the practice fake, accepting an invite", () => {
  it("needs a signed-in session, and a signed-out one is no longer one", async () => {
    const api = createFakeApi({ now: () => NOW });
    expect((await refusal(api.acceptInvite({ accessToken: "nobody", inviteToken: DEMO_JOIN_TOKENS.joined }))).code)
      .toBe("unauthorized");
    const access = await signIn(api, "noi@khaosoi.example");
    await api.signOut(access);
    const after = await refusal(api.acceptInvite({ accessToken: access, inviteToken: DEMO_JOIN_TOKENS.joined }));
    expect([after.status, after.code]).toEqual([401, "unauthorized"]);
    expect((await refusal(api.signOut(access))).code).toBe("invalid_session");
  });

  it("answers each demo link as its name says, whoever signs in, naming the shop only where the API does", async () => {
    const api = createFakeApi({ now: () => NOW });
    const access = await signIn(api, "noi@khaosoi.example");
    const accept = (inviteToken: string) => api.acceptInvite({ accessToken: access, inviteToken });
    const shop = { name: DEMO_JOIN_SHOP.name, ownerName: DEMO_JOIN_SHOP.ownerName };

    const joined = await accept(DEMO_JOIN_TOKENS.joined);
    expect(joined).toMatchObject({ answer: "joined", shop: { id: DEMO_JOIN_SHOP.id, ...shop }, helper: { name: "Noi" } });
    if (joined.answer !== "joined") throw new Error("expected joined");
    expect(joined.session.accessToken.startsWith("mhs1.")).toBe(true);
    expect(Date.parse(joined.session.expiresAt) - NOW).toBe(30 * DAY);

    const answers: [string, JoinAnswer][] = [
      [DEMO_JOIN_TOKENS.wrongEmail, { answer: "wrong_account", shop, invitedOn: "email" }],
      [DEMO_JOIN_TOKENS.wrongLine, { answer: "wrong_account", shop, invitedOn: "line" }],
      [DEMO_JOIN_TOKENS.expired, { answer: "expired" }],
      [DEMO_JOIN_TOKENS.used, { answer: "already_used" }],
      [DEMO_JOIN_TOKENS.revoked, { answer: "revoked" }],
      ["not-a-real-invite", { answer: "unknown" }],
      ["practice-inv-nobody-made", { answer: "unknown" }],
    ];
    for (const [token, answer] of answers) expect(await accept(token), token).toEqual(answer);

    // A demo's helper session ends once, as any does.
    await api.endShopSession(joined.session.accessToken);
    expect((await refusal(api.endShopSession(joined.session.accessToken))).code).toBe("unauthorized");
  });

  it("answers a practice invite's own link from its shop's people, and joining makes a helper the People page lists", async () => {
    const api = createFakeApi({ now: () => NOW, webOrigin: "https://web.test" });
    const made = await api.createInvite({ tenant: BAAN_MALI, name: "Ploy", identity: { kind: "email", address: "Ploy@BaanMali.example" } });
    const token = made.inviteUrl.split("/join/")[1]!;
    expect(token).toBe(`practice-${made.invite.id}`);

    // Another address is the wrong account, and the invite stays for the right one.
    const stranger = await signIn(api, "someone@else.example");
    expect(await api.acceptInvite({ accessToken: stranger, inviteToken: token }))
      .toEqual({ answer: "wrong_account", shop: { name: "Baan Mali", ownerName: "Fon" }, invitedOn: "email" });

    const ploy = await signIn(api, "ploy@baanmali.example");
    const joined = await api.acceptInvite({ accessToken: ploy, inviteToken: token });
    expect(joined).toMatchObject({ answer: "joined", shop: { id: BAAN_MALI, name: "Baan Mali", ownerName: "Fon" }, helper: { name: "Ploy" } });
    if (joined.answer !== "joined") throw new Error("expected joined");
    const people = await api.getPeople(BAAN_MALI);
    expect(people.helpers.find((helper) => helper.id === joined.helper.id))
      .toMatchObject({ name: "Ploy", identity: { kind: "email", address: "Ploy@BaanMali.example" }, devices: 1 });
    expect(people.invites.find((invite) => invite.id === made.invite.id)?.status).toBe("used");
    expect(await api.acceptInvite({ accessToken: ploy, inviteToken: token })).toEqual({ answer: "already_used" });

    // Ending the device's session leaves the helper a helper, with no device, and the log says both, by ids only.
    await api.endShopSession(joined.session.accessToken);
    expect((await api.getPeople(BAAN_MALI)).helpers.find((helper) => helper.id === joined.helper.id)?.devices).toBe(0);
    const log = (await api.listAudit(BAAN_MALI, { limit: 5 })).entries;
    expect(log.slice(0, 2).map(({ actor, action, subject }) => ({ actor, action, subject }))).toEqual([
      { actor: { kind: "helper", id: joined.helper.id }, action: "helper.session_ended", subject: { helperId: joined.helper.id } },
      { actor: { kind: "helper", id: joined.helper.id }, action: "helper.joined",
        subject: { inviteId: made.invite.id, helperId: joined.helper.id } },
    ]);
  });

  it("answers the sample invites by their state: Beam's on LINE, Tum's cancelled, Mint's used, and an old one expired", async () => {
    let now = NOW;
    const api = createFakeApi({ now: () => now, webOrigin: "https://web.test" });
    const access = await signIn(api, "beam@baanmali.example");
    const accept = (inviteToken: string) => api.acceptInvite({ accessToken: access, inviteToken });
    expect(await accept("practice-inv-beam")).toEqual({ answer: "wrong_account", shop: { name: "Baan Mali", ownerName: "Fon" },
      invitedOn: "line" });
    expect(await accept("practice-inv-tum")).toEqual({ answer: "revoked" });
    expect(await accept("practice-inv-mint")).toEqual({ answer: "already_used" });
    const old = await api.createInvite({ tenant: BAAN_MALI, name: "Som", identity: { kind: "email", address: "som@baanmali.example" } });
    now += 7 * DAY;
    expect(await accept(`practice-${old.invite.id}`)).toEqual({ answer: "expired" });
  });

  it("never saves a code, a sign-in or a helper session with the practice world, and Reset forgets them", async () => {
    const kept = memory();
    const api = createFakeApi({ now: () => NOW, storage: kept.storage, webOrigin: "https://web.test" });
    const made = await api.createInvite({ tenant: BAAN_MALI, name: "Ploy", identity: { kind: "email", address: "ploy@baanmali.example" } });
    const access = await signIn(api, "ploy@baanmali.example");
    const joined = await api.acceptInvite({ accessToken: access, inviteToken: `practice-${made.invite.id}` });
    if (joined.answer !== "joined") throw new Error("expected joined");
    const saved = [...kept.saved.values()].join("\n");
    expect(saved).toContain("helper.joined");
    for (const secret of [access, joined.session.accessToken, "practice-refresh", "practice-csrf"]) {
      expect(saved, secret).not.toContain(secret);
    }
    // The code as a number of its own: the sample's LINE channel id, 2001234567, holds its digits inside a longer run.
    expect(saved).not.toMatch(new RegExp(`(^|\\D)${PRACTICE_SIGN_IN_CODE}(\\D|$)`));
    api.reset();
    expect((await refusal(api.acceptInvite({ accessToken: access, inviteToken: DEMO_JOIN_TOKENS.joined }))).code).toBe("unauthorized");
    expect((await refusal(api.endShopSession(joined.session.accessToken))).code).toBe("unauthorized");
  });
});
