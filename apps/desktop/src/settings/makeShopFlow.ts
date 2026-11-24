// Make your shop, as Settings › Developer offers it (docs/several-shops.md, "A shop its owner makes"), without the screen:
// what is typed and picked, what is checked before anything is sent, and what each answer leaves on the screen. MakeShop.tsx
// draws it.
//
// What it asks goes through a `ShopMaker`: the runtime this page runs, through its `shops.make` op. Practice's runtime makes
// the shop in memory with no network; Connected's sends it to the API and keeps the owner session it answers. Either way
// the runtime then lists the shop with the person's others and shows it on every page, so the switcher has it once the
// answer arrives, and this flow only says so.
//
// Rules this module keeps:
// - Nothing is sent until the shop has a name, the person has a name and a kind of shop is picked (None of these is a
//   pick); a name the API would not keep is said before it is asked.
// - One request at a time: a second press while one is on its way does nothing, so one press makes at most one shop.
// - A refusal keeps what was typed, so the person can fix the one thing it names and send again.
import type { ShopRow } from "../lib/protocol";
import { isBridgeError } from "../lib/protocol";
import { shopNameOf, type ShopTemplateId } from "../runtime/makeShop";

/** A kind of shop as the page offers it: one of the three templates, or none of them. */
export type ShopKind = ShopTemplateId | "none";

/** The kinds, in the order the page lists them: the templates, then None of these. */
export const SHOP_KINDS: readonly ShopKind[] = ["handmade", "fashion", "food", "none"];

/** What the runtime is asked: the shop's name, the person's own and the template, or null for none. */
export interface NewShop {
  name: string;
  ownerName: string;
  template: ShopTemplateId | null;
}

/** What the page needs from a runtime: make the shop, or throw its refusal (`{ code, message }`). */
export interface ShopMaker {
  make(shop: NewShop): Promise<{ shop: ShopRow }>;
}

/** What the line under the form says: the last answer, as data, so the words are the screen's and the rules are tested
 *  without them. */
export type MakeNotice =
  /** a field still needs something before the form is sent */
  | { kind: "missing"; field: "name" | "ownerName" | "kind" }
  /** the runtime did not make the shop: its code, and its own words for a code the page has none for */
  | { kind: "refused"; code: string; message: string };

export interface MakeShopState {
  /** what is typed in the Shop name box, as typed */
  name: string;
  /** what is typed in the Your name box, as typed */
  ownerName: string;
  /** the kind picked; null until one is */
  kind: ShopKind | null;
  busy: boolean;
  notice: MakeNotice | null;
  /** the shop, once made: the form is then done, and says so */
  made: ShopRow | null;
}

export const MAKE_START: MakeShopState = { name: "", ownerName: "", kind: null, busy: false, notice: null, made: null };

/** The shop to ask for, or what is still missing, the first missing field first, as the form reads top to bottom. */
export function shopToMake(s: Pick<MakeShopState, "name" | "ownerName" | "kind">): NewShop | { missing: "name" | "ownerName" | "kind" } {
  const name = shopNameOf(s.name);
  if (!name) return { missing: "name" };
  const ownerName = shopNameOf(s.ownerName);
  if (!ownerName) return { missing: "ownerName" };
  if (s.kind === null) return { missing: "kind" };
  return { name, ownerName, template: s.kind === "none" ? null : s.kind };
}

/** The flow's state and what it does, outside React: `useSyncExternalStore` reads `get` and `subscribe`, and a test drives it
 *  with a fake maker. Every method is safe to call at any time: one that does not apply (a press while an answer is awaited,
 *  typing after the shop is made) does nothing. */
export class MakeShopFlow {
  private state: MakeShopState = MAKE_START;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly maker: ShopMaker,
    /** Told once the shop is made. The app then opens the new shop, as choosing it in the switcher does, which leaves
     *  Settings; while the page is still showing, it says the shop is made in place of the form. */
    private readonly onMade: (shop: ShopRow) => void = () => undefined,
  ) {}

  /** The state as of now; the same object until something changes. An arrow, so it can be handed to React as it is. */
  readonly get = (): MakeShopState => this.state;

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Typing a field, or picking a kind: what an earlier answer said was about what was there, so it goes. */
  readonly setName = (text: string): void => this.edit({ name: text });
  readonly setOwnerName = (text: string): void => this.edit({ ownerName: text });
  readonly setKind = (kind: ShopKind): void => this.edit({ kind });

  /** Make my shop: checks the form, then asks the runtime once, and says what came of it. */
  readonly make = async (): Promise<void> => {
    const s = this.state;
    if (s.busy || s.made) return;
    const asked = shopToMake(s);
    if ("missing" in asked) return void this.set({ notice: { kind: "missing", field: asked.missing } });
    this.set({ busy: true, notice: null });
    try {
      const { shop } = await this.maker.make(asked);
      this.set({ busy: false, made: shop, notice: null });
      this.onMade(shop);
    } catch (e) {
      const code = isBridgeError(e) ? e.code : "internal";
      const message = isBridgeError(e) && typeof e.message === "string" ? e.message : "";
      this.set({ busy: false, notice: { kind: "refused", code, message } });
    }
  };

  private edit(patch: Partial<MakeShopState>): void {
    if (this.state.busy || this.state.made) return;
    this.set({ ...patch, notice: null });
  }

  private set(patch: Partial<MakeShopState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn();
  }
}
