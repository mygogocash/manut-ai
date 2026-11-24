// Settings › Developer › Make your shop (docs/several-shops.md, "A shop its owner makes"): a signed-in person in no shop
// names their shop and themselves, picks which kind of shop it is (the three shop templates, by their names, or None of
// these), and makes it; they are its owner from the first write, and it is in the switcher from then on. The rules, and what
// each answer does to the screen, are in makeShopFlow.ts; this file draws them in words. Where the page offers it, and why
// there and nowhere else yet, is `makeShopOffer` below and docs/decisions.md.
//
// `MakeShopView` draws a given state and uses no hooks, so a test calls it as a plain function and reads the handlers a
// render to a string leaves out (MakeShop.test.tsx). `MakeShop` is the part with hooks: it owns the flow and a client of
// the runtime the page runs, and asks that runtime's `shops.make`: Practice's makes the shop in memory with nothing sent;
// Connected's sends it to the API, which answers `sign_ups_closed`, said here in plain words, until the owner opens sign-ups.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { t, type Key } from "../i18n";
import { holdImeEnter } from "../lib/ime";
import { createRuntime, type RuntimeAdapter, type RuntimeKind } from "../runtime";
import type { SignInState } from "../runtime/http/session";
import { MADE_SHOPS_LIMIT, MAX_SHOP_NAME } from "../runtime/makeShop";
import type { RuntimeSetting } from "../runtime/setting";
import { Row } from "./DevRow";
import { MakeShopFlow, SHOP_KINDS, type MakeNotice, type MakeShopState, type ShopKind, type ShopMaker } from "./makeShopFlow";

/** Where Make your shop is offered, as Settings › Developer decides it:
 *  - `practice`: the page runs Practice, which has no API and makes a shop in memory, so the screens can be tried;
 *  - `connected`: the page runs the API it signs in to, someone is signed in, and they are in no shop (or this page has
 *    just made their first one, and keeps saying so);
 *  - null anywhere else: a restart is waiting (the runtime running is not the one saved), nobody is signed in, the person
 *    already has a shop, or the runtime is the Playwright suite's loopback bridge, which makes no shops. */
export function makeShopOffer(p: {
  kind: RuntimeKind;
  saved: RuntimeSetting;
  restart: boolean;
  signIn: SignInState | null;
  shops: { loaded: boolean; list: readonly unknown[] };
  made: boolean;
}): "practice" | "connected" | null {
  if (p.kind === "websocket" || p.restart) return null;
  if (p.saved.mode === "practice") return "practice";
  if (p.signIn?.kind !== "signed_in") return null;
  return p.made || (p.shops.loaded && p.shops.list.length === 0) ? "connected" : null;
}

/** The words a kind of shop is listed with, and the line under it saying which shops it fits. */
const KIND_KEY: Record<ShopKind, Key> = {
  handmade: "make.kind.handmade",
  fashion: "make.kind.fashion",
  food: "make.kind.food",
  none: "make.kind.none",
};
const FITS_KEY: Record<ShopKind, Key> = {
  handmade: "make.fits.handmade",
  fashion: "make.fits.fashion",
  food: "make.fits.food",
  none: "make.fits.none",
};

/** A runtime's refusal in the page's words, by its code. A code the page has no words for is said in the runtime's own. */
const REFUSAL_KEY: Readonly<Record<string, Key>> = {
  sign_ups_closed: "make.fail.sign_ups_closed",
  invalid_name: "make.fail.invalid_name",
  invalid_owner_name: "make.fail.invalid_owner_name",
  unknown_template: "make.fail.unknown_template",
  too_many_shops: "make.fail.too_many_shops",
  rate_limited: "make.fail.rate_limited",
  unavailable: "make.fail.unavailable",
  signed_out: "rt.signedOut",
  offline: "rt.offline",
};

const MISSING_KEY: Record<"name" | "ownerName" | "kind", Key> = {
  name: "make.missing.name",
  ownerName: "make.missing.ownerName",
  kind: "make.missing.kind",
};

/** The words of a notice. */
export function makeNoticeWords(n: MakeNotice): string {
  if (n.kind === "missing") return t(MISSING_KEY[n.field]);
  const key = REFUSAL_KEY[n.code];
  if (key) return t(key, { limit: MADE_SHOPS_LIMIT });
  return n.message || t("make.failed");
}

export interface MakeShopViewProps {
  state: MakeShopState;
  /** Practice's flavour: says that nothing is sent */
  practice: boolean;
  onName: (text: string) => void;
  onOwnerName: (text: string) => void;
  onKind: (kind: ShopKind) => void;
  onMake: () => void;
}

export function MakeShopView(p: MakeShopViewProps) {
  const s = p.state;
  if (s.made) {
    return (
      <div className="dev-make" data-testid="make-shop" data-state="made">
        <Row title={t("make.done", { name: s.made.name })} hint={t(p.practice ? "make.donePractice" : "make.doneHint")} />
      </div>
    );
  }
  const note = s.notice ? makeNoticeWords(s.notice) : null;
  const missing = s.notice?.kind === "missing" ? s.notice.field : null;
  const describe = note ? "make-shop-note" : undefined;
  return (
    <form
      className="dev-make"
      noValidate
      aria-label={t("make.title")}
      data-testid="make-shop"
      data-state={s.busy ? "making" : "form"}
      onSubmit={(e) => {
        e.preventDefault();
        p.onMake();
      }}
      // Enter that only commits what an input method is composing (Thai, Japanese, Chinese) is not a press of Make my shop.
      onKeyDown={holdImeEnter}
    >
      <Row hint={t(p.practice ? "make.leadPractice" : "make.lead")} />
      <Row title={t("make.name")} hint={t("make.nameHint")}>
        <input
          type="text"
          className="dev-in"
          value={s.name}
          maxLength={MAX_SHOP_NAME}
          onChange={(e) => p.onName(e.target.value)}
          disabled={s.busy}
          aria-label={t("make.name")}
          aria-describedby={missing === "name" ? describe : undefined}
          aria-invalid={missing === "name" || (s.notice?.kind === "refused" && s.notice.code === "invalid_name") || undefined}
          autoComplete="organization"
          spellCheck={false}
          data-testid="make-name"
        />
      </Row>
      <Row title={t("make.owner")} hint={t("make.ownerHint")}>
        <input
          type="text"
          className="dev-in"
          value={s.ownerName}
          maxLength={MAX_SHOP_NAME}
          onChange={(e) => p.onOwnerName(e.target.value)}
          disabled={s.busy}
          aria-label={t("make.owner")}
          aria-describedby={missing === "ownerName" ? describe : undefined}
          aria-invalid={missing === "ownerName" || (s.notice?.kind === "refused" && s.notice.code === "invalid_owner_name") || undefined}
          autoComplete="name"
          spellCheck={false}
          data-testid="make-owner"
        />
      </Row>
      <div className="st-row">
        <div className="st-k">
          <b id="make-kind-title">{t("make.kind")}</b>
          <span>{t("make.kindHint")}</span>
        </div>
      </div>
      {/* Native radio buttons, so Up and Down move through them and the choice is announced, as a radio group is. */}
      <div className="dev-kinds" role="radiogroup" aria-labelledby="make-kind-title" aria-describedby={missing === "kind" ? describe : undefined}>
        {SHOP_KINDS.map((kind) => (
          <label key={kind} className="dev-kind">
            <input
              type="radio"
              name="make-kind"
              value={kind}
              checked={s.kind === kind}
              onChange={() => p.onKind(kind)}
              disabled={s.busy}
              data-testid={`make-kind-${kind}`}
            />
            <span>
              <b>{t(KIND_KEY[kind])}</b>
              <span>{t(FITS_KEY[kind])}</span>
            </span>
          </label>
        ))}
      </div>
      {note && (
        <div className="st-row">
          <div className="st-k">
            <span id="make-shop-note" className="dev-err" role="alert" data-testid="make-notice">
              {note}
            </span>
          </div>
        </div>
      )}
      <Row>
        <button type="submit" className="st-btn" disabled={s.busy} data-testid="make-submit">
          {s.busy ? t("make.making") : t("make.button")}
        </button>
      </Row>
    </form>
  );
}

/** Waits a moment at most for a client that is opening; one the runtime cannot open now is asked anyway, and its refusal
 *  says why (PeoplePane.tsx `opened`). */
async function opened(client: RuntimeAdapter): Promise<void> {
  if (client.status === "open") return;
  await Promise.race([client.connect().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 0))]);
}

/** Make your shop, with its own client of the runtime the page runs. `onMade` is told once the shop is made. */
export function MakeShop({ practice, onMade }: { practice: boolean; onMade?: () => void }) {
  const client = useRef<RuntimeAdapter | null>(null);
  const told = useRef(onMade);
  told.current = onMade;
  const [flow] = useState(() => {
    const maker: ShopMaker = {
      async make(shop) {
        const own = client.current;
        if (!own) throw { code: "disconnected", message: t("bot.offline") };
        await opened(own);
        return own.request("shops.make", shop);
      },
    };
    return new MakeShopFlow(maker, () => told.current?.());
  });
  const state = useSyncExternalStore(flow.subscribe, flow.get, flow.get);
  useEffect(() => {
    const own = createRuntime();
    client.current = own;
    return () => {
      client.current = null;
      own.close();
    };
  }, []);
  return (
    <MakeShopView
      state={state}
      practice={practice}
      onName={flow.setName}
      onOwnerName={flow.setOwnerName}
      onKind={flow.setKind}
      onMake={() => void flow.make()}
    />
  );
}
