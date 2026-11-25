// The asks before an artifact link is published or removed (artifactAsks.ts): each is an approval-core request of the kind its change
// is, offering yes this once or no; it settles once; and the one runtime op that acts on it gets the ask's own plan only after a yes,
// and only once. Everything else (no answer yet, a no, a withdrawn or expired ask, an ask of the other kind, an id never opened) gives
// nothing to publish or remove.
import { beforeEach, describe, expect, it } from "vitest";
import { answerArtifactAsk, artifactAskRecord, ASK_WAITS_MS, askToRemove, askToShare, resetArtifactAsks, takeSettled, withdrawArtifactAsk } from "./artifactAsks";
import type { RemovePlan, SharePlan } from "./artifacts";

const PAGE: SharePlan = { shop: "pilot:shop-a", title: "Menu", kind: "html", text: "<h1>Somtam</h1>", bytes: 15 };
const LINK: RemovePlan = { shop: "pilot:shop-a", id: "art-1", title: "Menu", url: "https://links.example/a/x.y" };

let now = 1_800_000_000_000;
beforeEach(() => {
  now = 1_800_000_000_000;
  resetArtifactAsks(() => now);
});

describe("asking before a link is published", () => {
  it("opens a public post that only offers yes this once or no, and shows exactly the page", async () => {
    const id = await askToShare(PAGE);
    const record = await artifactAskRecord(id);
    expect(record?.status).toBe("pending");
    expect(record?.request.kind).toBe("public_post");
    expect(record?.request.options.map((o) => [o.id, o.effect])).toEqual([["yes", "approve"], ["no", "decline"]]);
    expect(record?.request.detail).toEqual({ what: "publish", plan: PAGE });
  });

  it("hands the plan to the runtime once, after a yes, and never again", async () => {
    const id = await askToShare(PAGE);
    expect(await takeSettled(id, "publish")).toBeNull();
    expect(await answerArtifactAsk(id, true)).toEqual({ ok: true, yes: true });
    // the other kind of op finds nothing, and does not use the ask up
    expect(await takeSettled(id, "remove")).toBeNull();
    expect(await takeSettled(id, "publish")).toEqual(PAGE);
    expect(await takeSettled(id, "publish")).toBeNull();
  });

  it("gives nothing for a no, a second answer, a withdrawn or an expired ask, or an id it never opened", async () => {
    const no = await askToShare(PAGE);
    expect(await answerArtifactAsk(no, false)).toEqual({ ok: true, yes: false });
    expect(await takeSettled(no, "publish")).toBeNull();
    // settled once: a later yes is refused and changes nothing
    expect(await answerArtifactAsk(no, true)).toEqual({ ok: false, refused: "already_decided" });
    expect(await takeSettled(no, "publish")).toBeNull();

    const taken = await askToShare(PAGE);
    await withdrawArtifactAsk(taken);
    expect(await answerArtifactAsk(taken, true)).toMatchObject({ ok: false });
    expect(await takeSettled(taken, "publish")).toBeNull();

    const late = await askToShare(PAGE);
    now += ASK_WAITS_MS;
    expect(await answerArtifactAsk(late, true)).toEqual({ ok: false, refused: "expired" });
    expect(await takeSettled(late, "publish")).toBeNull();

    expect(await takeSettled("artifact-publish-never", "publish")).toBeNull();
    expect(await takeSettled(42, "publish")).toBeNull();
  });

  it("keeps its own copy, so changing the page after asking changes nothing that is published", async () => {
    const plan = { ...PAGE };
    const id = await askToShare(plan);
    plan.text = "<h1>something else</h1>";
    await answerArtifactAsk(id, true);
    expect((await takeSettled(id, "publish"))?.text).toBe(PAGE.text);
  });
});

describe("asking before a link is removed", () => {
  it("is a command of the shop's own, settled once, and names the link it removes", async () => {
    const id = await askToRemove(LINK);
    expect((await artifactAskRecord(id))?.request.kind).toBe("command");
    expect(await takeSettled(id, "remove")).toBeNull();
    await answerArtifactAsk(id, true);
    expect(await takeSettled(id, "publish")).toBeNull();
    expect(await takeSettled(id, "remove")).toEqual(LINK);
    expect(await takeSettled(id, "remove")).toBeNull();
  });
});
