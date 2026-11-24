// Make your shop's rules without the screen (makeShopFlow.ts): what must be there before anything is sent, one request at a
// time, what a refusal leaves, and what a made shop leaves, against a fake runtime that records what it was asked.
import { describe, expect, it, vi } from "vitest";
import type { ShopRow } from "../lib/protocol";
import { MAKE_START, MakeShopFlow, shopToMake, type NewShop, type ShopMaker } from "./makeShopFlow";

const MADE: ShopRow = { id: "pilot:made", name: "Khao Hom", owner: "Dao", role: "owner" };

/** A runtime that answers each `make` with the next of `answers`: a shop, or a refusal to throw. */
function maker(...answers: ({ shop: ShopRow } | { code: string; message: string })[]) {
  const asked: NewShop[] = [];
  const m: ShopMaker = {
    make: vi.fn(async (shop: NewShop) => {
      asked.push(shop);
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if ("code" in next) throw next;
      return next;
    }),
  };
  return { m, asked };
}

function filled(flow: MakeShopFlow, kind: "food" | "none" = "food") {
  flow.setName("  Khao Hom ");
  flow.setOwnerName("Dao");
  flow.setKind(kind);
}

describe("what the form asks for", () => {
  it("asks for the shop's name, then the person's, then a kind, in the order the form reads", () => {
    expect(shopToMake({ name: "", ownerName: "", kind: null })).toEqual({ missing: "name" });
    expect(shopToMake({ name: "   ", ownerName: "Dao", kind: "food" })).toEqual({ missing: "name" });
    expect(shopToMake({ name: "Khao Hom", ownerName: " ", kind: "food" })).toEqual({ missing: "ownerName" });
    expect(shopToMake({ name: "Khao Hom", ownerName: "Dao", kind: null })).toEqual({ missing: "kind" });
    expect(shopToMake({ name: "x".repeat(81), ownerName: "Dao", kind: "food" })).toEqual({ missing: "name" });
  });

  it("sends each name as the API keeps it, and None of these as no template", () => {
    expect(shopToMake({ name: "  Café ", ownerName: " Dao", kind: "handmade" })).toEqual({ name: "Café", ownerName: "Dao",
      template: "handmade" });
    expect(shopToMake({ name: "Khao Hom", ownerName: "Dao", kind: "none" })).toEqual({ name: "Khao Hom", ownerName: "Dao", template: null });
  });
});

describe("making the shop", () => {
  it("says what is missing and sends nothing until the form is whole", async () => {
    const { m } = maker({ shop: MADE });
    const flow = new MakeShopFlow(m);
    await flow.make();
    expect(flow.get().notice).toEqual({ kind: "missing", field: "name" });
    flow.setName("Khao Hom");
    expect(flow.get().notice).toBeNull();
    flow.setOwnerName("Dao");
    await flow.make();
    expect(flow.get().notice).toEqual({ kind: "missing", field: "kind" });
    expect(m.make).not.toHaveBeenCalled();
  });

  it("asks once, with the shop as typed and trimmed, and keeps the made shop, telling the page", async () => {
    const { m, asked } = maker({ shop: MADE });
    const onMade = vi.fn();
    const flow = new MakeShopFlow(m, onMade);
    filled(flow);
    const pressed = flow.make();
    expect(flow.get().busy).toBe(true);
    // A second press while the first is on its way makes nothing more.
    await flow.make();
    await pressed;
    expect(asked).toEqual([{ name: "Khao Hom", ownerName: "Dao", template: "food" }]);
    expect(flow.get()).toEqual({ ...MAKE_START, name: "  Khao Hom ", ownerName: "Dao", kind: "food", made: MADE });
    expect(onMade).toHaveBeenCalledWith(MADE);
    // Once made, the form is done: typing and pressing again change nothing and send nothing.
    flow.setName("Another");
    await flow.make();
    expect(flow.get().name).toBe("  Khao Hom ");
    expect(m.make).toHaveBeenCalledTimes(1);
  });

  it("keeps what was typed after a refusal, says the refusal by its code, and sends again when pressed", async () => {
    const { m, asked } = maker({ code: "sign_ups_closed", message: "closed" }, { code: "too_many_shops", message: "" }, { shop: MADE });
    const flow = new MakeShopFlow(m);
    filled(flow, "none");
    await flow.make();
    expect(flow.get()).toMatchObject({ busy: false, made: null, name: "  Khao Hom ", notice: { kind: "refused", code: "sign_ups_closed", message: "closed" } });
    await flow.make();
    expect(flow.get().notice).toEqual({ kind: "refused", code: "too_many_shops", message: "" });
    await flow.make();
    expect(flow.get().made).toEqual(MADE);
    expect(asked).toHaveLength(3);
    expect(asked.every((shop) => shop.template === null)).toBe(true);
  });

  it("reads a failure that is not the runtime's refusal as one it has no words for", async () => {
    const m: ShopMaker = { make: async () => Promise.reject(new Error("boom")) };
    const flow = new MakeShopFlow(m);
    filled(flow);
    await flow.make();
    expect(flow.get().notice).toEqual({ kind: "refused", code: "internal", message: "" });
  });

  it("tells subscribers of each change, and stops when they leave", async () => {
    const { m } = maker({ shop: MADE });
    const flow = new MakeShopFlow(m);
    const heard = vi.fn();
    const leave = flow.subscribe(heard);
    flow.setName("Khao Hom");
    expect(heard).toHaveBeenCalledTimes(1);
    leave();
    flow.setOwnerName("Dao");
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
