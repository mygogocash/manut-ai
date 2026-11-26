// What an ask card from one of several shops shows (docs/several-shops.md): its shop's name at the top; where the
// person's role there may not decide it, who may, and Ask <owner> in place of the answers; a note passed on with it, as
// the owner and the helper each see it; and a closed card's line still naming the shop. The runtime and the store decide
// what each ask offers (runtime/http/several.test.ts); this is what the person sees.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../../i18n";
import type { AskShop } from "../../lib/protocol";
import type { ApprovalItem } from "../../state/store";
import Cards from "./Cards.slot";

const HELPED: AskShop = { id: "pilot:b", name: "Ran Pa Noi", owner: "Noi", role: "helper" };
const OWNED: AskShop = { id: "pilot:a", name: "Baan Mali", owner: "Fon", role: "owner" };

const ask = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  kind: "approval",
  id: "approval-pilot%3Ab/refund-1@1",
  ts: 1_795_396_200,
  request_id: "pilot%3Ab/refund-1@1",
  title: "",
  command: "Refund ฿120 for order RP-118",
  choices: [],
  shop: HELPED,
  outside: true,
  approvalKind: "money",
  passOn: true,
  ...over,
});

afterEach(() => setLang("en"));

describe("an ask card from one of several shops", () => {
  it("names its shop, says who may decide what the helper may not, and offers Ask <owner> in place of the answers", () => {
    setLang("en");
    const html = renderToString(<Cards bot="buddy" item={ask()} />);
    expect(html).toMatch(/data-testid="card-shop"[^>]*>Ran Pa Noi</);
    expect(html).toMatch(/data-testid="card-only"[^>]*>Only Noi can approve money</);
    expect(html).toMatch(/<button[^>]*data-testid="card-ask-owner"[^>]*>Ask Noi</);
    expect(html).not.toContain("data-choice");
    expect(html).not.toContain("card-outdated");
  });

  it("shows the owner a note a helper passed on, with the answers the owner has", () => {
    setLang("en");
    const html = renderToString(
      <Cards bot="buddy" item={ask({ shop: OWNED, choices: ["once", "deny"], passOn: undefined, passedOn: { name: "Mint", note: "It looks right to me." } })} />,
    );
    expect(html).toMatch(/data-testid="card-shop"[^>]*>Baan Mali</);
    expect(html).toContain("Passed on by Mint");
    expect(html).toContain("Mint: It looks right to me.");
    expect(html).toMatch(/data-choice="deny"/);
    expect(html).toMatch(/data-choice="once"/);
    expect(html).not.toContain("card-ask-owner");
    expect(html).not.toContain("card-only");
  });

  it("shows the helper what they passed on, and no second Ask", () => {
    setLang("en");
    const html = renderToString(<Cards bot="buddy" item={ask({ passOn: undefined, passedOn: { name: "", note: "The jar arrived broken." } })} />);
    expect(html).toContain("Passed on to Noi");
    expect(html).toContain("The jar arrived broken.");
    expect(html).toContain("Only Noi can approve money");
    expect(html).not.toContain("card-ask-owner");
  });

  it("names the shop on the closed card's line too", () => {
    setLang("en");
    const html = renderToString(<Cards bot="buddy" item={ask({ shop: HELPED, choices: ["once", "deny"], passOn: undefined, approvalKind: "reply", command: "Send on LINE: “Hi”", resolved: "once" })} />);
    expect(html).toMatch(/data-testid="card-line"/);
    expect(html).toContain("Ran Pa Noi · Send on LINE: “Hi”");
  });

  it("says it in the person's language", () => {
    setLang("ko");
    const html = renderToString(<Cards bot="buddy" item={ask()} />);
    expect(html).toContain("돈은 Noi 님만 승인할 수 있어요");
    expect(html).toContain("Noi 님에게 묻기");
  });
});
