// The owner's web app in practice mode (src/api/practiceOwner.ts): a practice sign-in with the one pretend code, its two
// shops, their requests as approval-core records, and decisions settled or refused by approval-core's own rules, with
// every answer the decision route can give. Nothing of it reaches the browser's storage.
import { describe, expect, it } from "vitest";
import { ApiError, type WebAnswer } from "../src/api";
import { createFakeApi, PRACTICE_SIGN_IN_CODE } from "../src/api/fake";
import { PRACTICE_SHOPS } from "../src/api/practiceOwner";

const BAAN_MALI = PRACTICE_SHOPS[0]!.id;
const KHAO_SOI = PRACTICE_SHOPS[1]!.id;
const EMAIL = "fon@baanmali.example";

/// A storage that records every write, so a test can say nothing was kept.
function recordingStorage() {
  const writes: string[] = [];
  const store = new Map<string, string>();
  return {
    writes,
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes.push(key);
        store.set(key, value);
      },
      removeItem: (key: string) => void store.delete(key),
    },
  };
}

async function signedIn(options: Parameters<typeof createFakeApi>[0] = {}) {
  const api = createFakeApi({ pagePath: () => "/app/", pageSearch: () => "", ...options });
  await api.requestEmailCode(EMAIL);
  await api.webSignIn({ email: EMAIL, code: PRACTICE_SIGN_IN_CODE });
  return api;
}

type Listed = { approvals: { record: { request: { id: string; kind: string; detail: { text: string } } }; standing: { state: string } }[] };
const ids = (answer: WebAnswer) => (answer.body as Listed).approvals.map((one) => one.record.request.id);
const bodyOf = (answer: WebAnswer) => answer.body as Record<string, unknown> & { result: Record<string, unknown> };

describe("signing in to practice", () => {
  it("is signed out at first, signs in with the one pretend code, and refuses any other as the API does", async () => {
    const api = createFakeApi({ pagePath: () => "/app/", pageSearch: () => "" });
    expect(await api.webShops()).toEqual({ signedIn: false, emailSignIn: true });
    await api.requestEmailCode(EMAIL);
    const wrong = await api.webSignIn({ email: EMAIL, code: "000000" }).catch((err: unknown) => err);
    expect(wrong).toMatchObject({ status: 401, code: "wrong_code", triesLeft: 4 });
    await api.webSignIn({ email: EMAIL, code: PRACTICE_SIGN_IN_CODE });
    expect(await api.webShops()).toEqual({ signedIn: true, shops: PRACTICE_SHOPS });
    // The code is used up.
    await expect(api.webSignIn({ email: EMAIL, code: PRACTICE_SIGN_IN_CODE })).rejects.toMatchObject({ code: "code_ended" });
  });

  it("stands for an environment where signing in is off when the app is opened with its demo query", async () => {
    const api = createFakeApi({ pagePath: () => "/app/", pageSearch: () => "?demo=sign-in-off" });
    expect(await api.webShops()).toEqual({ signedIn: false, emailSignIn: false });
    const refused = await api.requestEmailCode(EMAIL).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 400, code: "email_not_configured" });
  });

  it("keeps nothing in the browser's storage, and forgets the sign-in on signing out", async () => {
    const { storage, writes } = recordingStorage();
    const api = await signedIn({ storage });
    await api.webApprovals(BAAN_MALI, "open");
    await api.webDecide({ shop: BAAN_MALI, requestId: "practice-bm-late", optionId: "approve", seenRevision: 1 });
    await api.webSignOut();
    expect(writes).toEqual([]);
    expect(await api.webShops()).toEqual({ signedIn: false, emailSignIn: true });
    expect(await api.webApprovals(BAAN_MALI, "open")).toEqual({ status: 401, body: { error: "session_ended", shop: BAAN_MALI } });
  });
});

describe("the practice shops", () => {
  it("lists what waits, newest asked first, and what was answered lately, as approval-core's wire records", async () => {
    const api = await signedIn();
    expect(ids(await api.webApprovals(BAAN_MALI, "open"))).toEqual(["practice-bm-books", "practice-bm-free", "practice-bm-late"]);
    expect(ids(await api.webApprovals(BAAN_MALI, "recent"))).toEqual(["practice-bm-mint", "practice-bm-old"]);
    const recent = (await api.webApprovals(BAAN_MALI, "recent")).body as Listed;
    expect(recent.approvals.map((one) => one.standing.state)).toEqual(["decided", "expired"]);
    expect(ids(await api.webApprovals(KHAO_SOI, "open"))).toEqual(["practice-ksn-books", "practice-ksn-taken", "practice-ksn-hours"]);
    const helperBooks = ((await api.webApprovals(KHAO_SOI, "open")).body as Listed).approvals[0]!.record.request;
    expect(helperBooks.kind).toBe("command");
    expect(helperBooks.detail.text).toContain("Only the owner sees the books");
    expect(await api.webApprovals("pilot:elsewhere", "open")).toEqual({ status: 401, body: { error: "session_ended", shop: "pilot:elsewhere" } });
  });

  it("answers each decision as the API's route would: sent, refused by LINE, unknown, declined, and once only", async () => {
    const api = await signedIn();
    const decide = (shop: string, requestId: string, optionId = "approve", seenRevision = 1) =>
      api.webDecide({ shop, requestId, optionId, seenRevision });
    const sent = await decide(BAAN_MALI, "practice-bm-late");
    expect(sent.status).toBe(200);
    expect(bodyOf(sent).action).toBe("confirmed");
    expect(bodyOf(sent).result).toMatchObject({ ok: true, decision: { decidedBy: "owner-fon", role: "owner", optionId: "approve" } });
    expect(bodyOf(await decide(BAAN_MALI, "practice-bm-free")).action).toBe("failed");
    expect(bodyOf(await decide(KHAO_SOI, "practice-ksn-hours")).action).toBe("unknown");
    expect(bodyOf(await decide(BAAN_MALI, "practice-bm-books", "decline")).action).toBe("rejected");
    const again = await decide(BAAN_MALI, "practice-bm-late", "decline");
    expect(again.status).toBe(409);
    expect(bodyOf(again)).toMatchObject({ error: "already_decided", action: "confirmed",
      result: { ok: false, refused: "already_decided", decision: { decidedBy: "owner-fon" } } });
  });

  it("refuses what approval-core refuses: a helper's command, a revision not seen, and one the owner answered first", async () => {
    const api = await signedIn();
    const books = await api.webDecide({ shop: KHAO_SOI, requestId: "practice-ksn-books", optionId: "approve", seenRevision: 1 });
    expect(books.status).toBe(403);
    expect(bodyOf(books)).toMatchObject({ error: "not_permitted" });
    const unseen = await api.webDecide({ shop: KHAO_SOI, requestId: "practice-ksn-hours", optionId: "approve", seenRevision: 2 });
    expect(unseen.status).toBe(409);
    expect(bodyOf(unseen)).toMatchObject({ error: "changed", result: { currentRevision: 1 } });
    const taken = await api.webDecide({ shop: KHAO_SOI, requestId: "practice-ksn-taken", optionId: "approve", seenRevision: 1 });
    expect(taken.status).toBe(409);
    expect(bodyOf(taken)).toMatchObject({ error: "already_decided", action: "confirmed",
      result: { decision: { decidedBy: "owner-link", role: "owner" } } });
    const unknown = await api.webDecide({ shop: BAAN_MALI, requestId: "practice-none", optionId: "approve", seenRevision: 1 });
    expect(unknown.status).toBe(404);
  });
});
