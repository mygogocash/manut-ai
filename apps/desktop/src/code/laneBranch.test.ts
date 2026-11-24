// A lane's branch, named from the work and planned before the shell makes it (src/code/laneBranch.ts).
import { describe, expect, it } from "vitest";
import { laneBranchNames, planLaneBranch } from "./laneBranch";

/** What git takes as a branch name, as narrow as Kit makes them: one folder, lower case words joined by hyphens. */
const VALID = /^kit\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const first = (title: string) => laneBranchNames(title)[0];

describe("a lane's branch is named from its work", () => {
  it("takes the first words of the title, as the canvas's kit/promptpay-qr does", () => {
    expect(first("PromptPay QR")).toBe("kit/promptpay-qr");
    expect(first("PromptPay QR at checkout")).toBe("kit/promptpay-qr-checkout");
    expect(first("Add a PromptPay QR to the checkout")).toBe("kit/add-promptpay-qr-checkout");
    expect(first("Fix stock sync with Shopee")).toBe("kit/fix-stock-sync-shopee");
    expect(first("Thai date format")).toBe("kit/thai-date-format");
  });

  it("leaves out the small words a title is padded with, and the words that ask", () => {
    expect(first("Why is the QR code blurry?")).toBe("kit/qr-code-blurry");
    expect(first("Could you please fix the totals for me")).toBe("kit/fix-totals");
  });

  it("keeps four words at most, and never grows past a short name", () => {
    expect(first("Make the checkout page work for customers who pay in more than one currency")).toBe("kit/make-checkout-page-work");
    const long = first("internationalization localization infrastructure modernization framework");
    expect(long.length).toBeLessThanOrEqual(4 + 40);
    expect(long).toMatch(VALID);
  });

  it("writes lower case words and numbers only, whatever the title holds", () => {
    expect(first("fix: bug #12 (urgent!)")).toBe("kit/fix-bug-12-urgent");
    expect(first("WHY? QR_CODE & PromptPay—v2")).toBe("kit/qr-code-promptpay-v2");
    expect(first("  --spaced   out--  ")).toBe("kit/spaced-out");
    expect(first("Café menu")).toBe("kit/cafe-menu");
    expect(first("a/b\\c.d..e")).toBe("kit/b-c-d-e");
  });

  it("keeps the words it can write from a title in another script, and says work when there are none", () => {
    expect(first("PromptPay QR พร้อมเพย์ ที่หน้าชำระเงิน")).toBe("kit/promptpay-qr");
    expect(first("พร้อมเพย์")).toBe("kit/work");
    expect(first("결제 화면에 QR 추가")).toBe("kit/qr");
    expect(first("")).toBe("kit/work");
    expect(first("   ")).toBe("kit/work");
    expect(first("!!! ???")).toBe("kit/work");
    expect(first("the of and")).toBe("kit/work");
  });

  it("offers the same name with a number after it, for a branch that is taken", () => {
    expect(laneBranchNames("PromptPay QR")).toEqual(["kit/promptpay-qr", "kit/promptpay-qr-2", "kit/promptpay-qr-3", "kit/promptpay-qr-4", "kit/promptpay-qr-5", "kit/promptpay-qr-6", "kit/promptpay-qr-7", "kit/promptpay-qr-8", "kit/promptpay-qr-9"]);
    expect(laneBranchNames("x", 3)).toEqual(["kit/x", "kit/x-2", "kit/x-3"]);
  });

  it("is always a name git takes: no dots, no slash beyond kit/, no trailing hyphen, no .lock", () => {
    const titles = ["a.lock", "x--y", "-lead", "trail-", "a b c d e f g", "\u0000\u001f nul", "~^:?*[ ref", "HEAD", "@", "@{u}", "-", "kit/inside", "..", "a".repeat(500), "ß ǅ İ ı"];
    for (const t of titles) for (const n of laneBranchNames(t)) expect(n, JSON.stringify(t)).toMatch(VALID);
  });

  it("gives the same names for the same title", () => {
    expect(laneBranchNames("Thai date format")).toEqual(laneBranchNames("Thai date format"));
  });
});

describe("planning a lane's branch", () => {
  const plan = (current: string, others: { branch: string; busy: boolean }[] = [], title = "PromptPay QR") => planLaneBranch({ title, current, others });

  it("makes a branch from the one the folder is on", () => {
    expect(plan("main")).toEqual({ kind: "make", base: "main", names: laneBranchNames("PromptPay QR") });
    expect(plan("feat/session-controls")).toMatchObject({ kind: "make", base: "feat/session-controls" });
  });

  it("makes it from the commit a detached folder is on", () => {
    expect(plan("3e3f4c1")).toMatchObject({ kind: "make", base: "3e3f4c1" });
  });

  it("makes none where there is no repository", () => {
    expect(plan("")).toEqual({ kind: "none", why: "no_repository" });
  });

  it("joins the branch of a lane that is working on it, for one folder has one checkout", () => {
    expect(plan("kit/thai-date", [{ branch: "kit/thai-date", busy: true }])).toEqual({ kind: "join", branch: "kit/thai-date" });
  });

  it("makes its own from a branch a lane left idle, so the work stays one piece to a branch", () => {
    expect(plan("kit/thai-date", [{ branch: "kit/thai-date", busy: false }])).toMatchObject({ kind: "make", base: "kit/thai-date" });
  });

  it("is not held by a busy lane that is on some other branch, or on none", () => {
    expect(plan("main", [{ branch: "kit/thai-date", busy: true }])).toMatchObject({ kind: "make", base: "main" });
    expect(plan("main", [{ branch: "", busy: true }])).toMatchObject({ kind: "make", base: "main" });
  });
});
