// The asks before an artifact link is published or removed (artifactAsks.ts): each is an approval-core request of the kind its change
// is, offering yes this once or no; it settles once; and the one runtime op that acts on it gets the ask's own plan only after a yes,
// and only once. Everything else (no answer yet, a no, a withdrawn or expired ask, an ask of the other kind, an id never opened) gives
// nothing to publish or remove.
import { beforeEach, describe, expect, it } from "vitest";
import { answerArtifactAsk, artifactAskRecord, ASK_WAITS_MS, askToRemove, askToShare, askToShareSkills, resetArtifactAsks, reviewOf, takeSettled, withdrawArtifactAsk } from "./artifactAsks";
import type { RemovePlan, SharePlan } from "./artifacts";
import type { SkillsPlan } from "./skillBundle";

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

describe("asking before a bundle of skills is published (item 84)", () => {
  const BUNDLE: SkillsPlan = {
    shop: "pilot:shop-a",
    title: "promptpay",
    skills: [{ name: "promptpay", files: [{ path: "SKILL.md", text: "---\nname: promptpay\n---\n" }, { path: "scripts/qr.sh", text: "#!/bin/sh\n" }] }],
    bytes: 90,
    scripts: ["promptpay/scripts/qr.sh"],
  };

  it("is a public post whose detail is the exact bundle, and whose yes waits until every file was opened", async () => {
    const id = await askToShareSkills(BUNDLE);
    const record = await artifactAskRecord(id);
    expect(record?.request.kind).toBe("public_post");
    expect(record?.request.detail).toEqual({ what: "skills", plan: BUNDLE });
    // an unreviewed bundle cannot reach a yes: nothing is decided, and the ask keeps waiting
    expect(await answerArtifactAsk(id, true)).toEqual({ ok: false, refused: "not_reviewed" });
    expect((await artifactAskRecord(id))?.status).toBe("pending");
    expect(await takeSettled(id, "skills")).toBeNull();
    const review = reviewOf(id)!;
    review.open("promptpay/SKILL.md");
    // a file the ask did not show counts for nothing
    review.open("promptpay/other.md");
    expect(await answerArtifactAsk(id, true)).toEqual({ ok: false, refused: "not_reviewed" });
    review.open("promptpay/scripts/qr.sh");
    expect(await answerArtifactAsk(id, true)).toEqual({ ok: true, yes: true });
    expect(await takeSettled(id, "skills")).toEqual(BUNDLE);
    expect(await takeSettled(id, "skills")).toBeNull();
    // never handed to the page publish or a removal
    expect(await takeSettled(id, "publish")).toBeNull();
  });

  it("takes the tick instead of opening every file, and a no needs no review", async () => {
    const ticked = await askToShareSkills(BUNDLE);
    reviewOf(ticked)!.tick(true);
    expect(await answerArtifactAsk(ticked, true)).toEqual({ ok: true, yes: true });
    const untick = await askToShareSkills(BUNDLE);
    reviewOf(untick)!.tick(true);
    reviewOf(untick)!.tick(false);
    expect(await answerArtifactAsk(untick, true)).toEqual({ ok: false, refused: "not_reviewed" });
    const declined = await askToShareSkills(BUNDLE);
    expect(await answerArtifactAsk(declined, false)).toEqual({ ok: true, yes: false });
    expect(await takeSettled(declined, "skills")).toBeNull();
    // a page plan's ask has no review to wait for
    expect(reviewOf(await askToShare(PAGE))).toBeNull();
  });
});
