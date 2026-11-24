// "No secret in the preview", drawn with react-dom/server from props, and its buttons read from the elements it returns
// (the view uses no hooks). The project is the canvas's baanmali-preorder, whose checkout reads a PromptPay shop ID.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import type { Need } from "./preview";
import { PreviewSampleView, type PreviewSampleProps } from "./PreviewSample";

const SHOP: Need = { name: "PROMPTPAY_SHOP_ID", kind: "shop_id" };
const STRIPE: Need = { name: "STRIPE_SECRET_KEY", kind: "key" };

const props = (over: Partial<PreviewSampleProps> = {}): PreviewSampleProps => ({ needs: [SHOP], asked: null, onAdd: vi.fn(), ...over });

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const byId = (p: PreviewSampleProps, id: string) => drawn(PreviewSampleView(p)).filter((e) => e.props["data-testid"] === id);
const html = (p: PreviewSampleProps) => renderToString(createElement(PreviewSampleView, p));

afterEach(() => setLang("en"));

describe("a preview on a sample", () => {
  it("says nothing when no secret is missing", () => {
    expect(html(props({ needs: [] }))).toBe("");
  });

  it("says what the canvas says for the shop ID: it is a sample, and Add the shop ID", () => {
    const out = html(props());
    expect(out).toContain("Preview");
    expect(out).toContain("Sample");
    expect(out).toContain("The preview has no shop ID yet, so the QR code is a sample.");
    expect(out).toContain("Add the shop ID");
  });

  it("names any other secret by the variable the code reads", () => {
    const out = html(props({ needs: [SHOP, STRIPE] }));
    expect(out).toContain("The preview has no value for STRIPE_SECRET_KEY yet, so what needs it is a sample.");
    expect(out).toContain("Add the value");
    expect(byId(props({ needs: [SHOP, STRIPE] }), "kit-sample")).toHaveLength(2);
  });

  it("keeps the vault's note until Add is pressed, then says the vault comes later", () => {
    expect(html(props())).not.toContain("comes later");
    const p = props();
    (byId(p, "kit-sample-add")[0].props.onClick as () => void)();
    expect(p.onAdd).toHaveBeenCalledWith("PROMPTPAY_SHOP_ID");
    const out = html(props({ asked: "PROMPTPAY_SHOP_ID" }));
    expect(out).toContain("The vault for a project&#x27;s secrets comes later.");
    expect(out).toContain("a test payment can&#x27;t reach your account");
  });

  it("puts the note under the secret that was asked about only", () => {
    const out = html(props({ needs: [SHOP, STRIPE], asked: "STRIPE_SECRET_KEY" }));
    expect(out.match(/data-testid="kit-sample-vault"/g)).toHaveLength(1);
    expect(out.indexOf("kit-sample-vault")).toBeGreaterThan(out.indexOf("STRIPE_SECRET_KEY"));
  });

  it("never shows a sample value or a secret's value: only the name", () => {
    const out = html(props({ needs: [SHOP, STRIPE] }));
    expect(out).not.toContain("0000000000");
    expect(out).not.toContain("sample-value");
  });

  it("is in all four languages", () => {
    for (const [lang, words] of [["ko", "가게 ID 추가"], ["ja", "ショップ ID を追加"], ["zh", "添加店铺 ID"]] as const) {
      setLang(lang);
      expect(html(props()), lang).toContain(words);
    }
  });
});
