// A preview with sample values until the owner adds a real one, read without a DOM: which secrets Kit's changes make the
// project need (by name, never by value), and the one rule for what a preview runs with. The project is the canvas's
// baanmali-preorder, whose checkout reads a PromptPay shop ID to draw a QR code.
import { afterEach, describe, expect, it } from "vitest";
import type { DiffFile } from "../lib/protocol";
import { DICT, setLang, t } from "../i18n";
import { SAMPLES, kindOf, needsOfProject, noteReads, onSample, previewEnv, readsAfter, needsOf, resetPreview, sessionsWithNeeds, type Need } from "./preview";

const file = (path: string, lines: string[], kind: DiffFile["kind"] = "update"): DiffFile => ({
  path,
  kind,
  lines: ["@@ -1,2 +1,3 @@", ...lines],
  added: lines.filter((l) => l.startsWith("+")).length,
  removed: lines.filter((l) => l.startsWith("-")).length,
});

const SHOP: Need = { name: "PROMPTPAY_SHOP_ID", kind: "shop_id" };
const STRIPE: Need = { name: "STRIPE_SECRET_KEY", kind: "key" };

afterEach(() => {
  resetPreview();
  setLang("en");
});

describe("which names are a secret the preview needs", () => {
  it("reads a shop ID by what it is called", () => {
    for (const n of ["PROMPTPAY_SHOP_ID", "SHOP_ID", "VITE_SHOP_ID", "MERCHANT_ID", "PROMPTPAY_ID"]) expect(kindOf(n), n).toBe("shop_id");
  });

  it("reads a key, token, secret or password by what it is called", () => {
    for (const n of ["STRIPE_SECRET_KEY", "API_KEY", "APIKEY", "LINE_CHANNEL_TOKEN", "SESSION_SECRET", "DB_PASSWORD", "OMISE_SECRET"]) expect(kindOf(n), n).toBe("key");
  });

  it("reads nothing else as one: a mode, a port, a name that only contains the letters", () => {
    for (const n of ["NODE_ENV", "PORT", "DEBUG", "MONKEY_BUSINESS", "KEYBOARD_LAYOUT", "TOKENIZER", "SECRETARY"]) expect(kindOf(n), n).toBeNull();
  });
});

describe("what Kit's changes make the project read", () => {
  const reads = (...files: DiffFile[]) => readsAfter({}, files);
  const names = (...files: DiffFile[]) => needsOf(reads(...files)).map((n) => n.name);

  it("is the secret a changed line reads from the environment, in each language's way of saying so", () => {
    expect(names(file("src/checkout.tsx", ["+  const qr = promptPayQR(process.env.PROMPTPAY_SHOP_ID, total);"]))).toEqual(["PROMPTPAY_SHOP_ID"]);
    expect(names(file("src/a.ts", ['+  const k = process.env["STRIPE_SECRET_KEY"];']))).toEqual(["STRIPE_SECRET_KEY"]);
    expect(names(file("src/a.ts", ["+  const k = import.meta.env.VITE_SHOP_ID;"]))).toEqual(["VITE_SHOP_ID"]);
    expect(names(file("src/worker.ts", ["+  const id = env.PROMPTPAY_SHOP_ID;"]))).toEqual(["PROMPTPAY_SHOP_ID"]);
    expect(names(file("app.py", ['+SECRET = os.environ["SESSION_SECRET"]', '+ID = os.getenv("SHOP_ID")']))).toEqual(["SESSION_SECRET", "SHOP_ID"]);
    expect(names(file("main.go", ['+  key := os.Getenv("API_KEY")']))).toEqual(["API_KEY"]);
    expect(names(file("main.ts", ['+  const t = Deno.env.get("LINE_CHANNEL_TOKEN");']))).toEqual(["LINE_CHANNEL_TOKEN"]);
  });

  it("is the name only: the value a line also holds is never kept", () => {
    const f = file("src/a.ts", ['+  const k = process.env.STRIPE_SECRET_KEY ?? "sk-FAKE0000000000000000TEST";']);
    const kept = JSON.stringify(reads(f));
    expect(kept).toContain("STRIPE_SECRET_KEY");
    expect(kept).not.toContain("FAKE0000");
  });

  it("is nothing for a name that is not a secret, a line that was not changed, or a line taken out", () => {
    expect(names(file("src/a.ts", ["+  if (process.env.NODE_ENV === 'test') run();"]))).toEqual([]);
    expect(names(file("src/a.ts", ["   const k = process.env.STRIPE_SECRET_KEY;"]))).toEqual([]);
    expect(names(file("src/a.ts", ["-  const k = process.env.STRIPE_SECRET_KEY;"]))).toEqual([]);
  });

  it("is the same secret once when several lines and files read it", () => {
    const a = file("src/a.ts", ["+  x(process.env.SHOP_ID);", "+  y(process.env.SHOP_ID);"]);
    const b = file("src/b.ts", ["+  z(process.env.SHOP_ID);"]);
    expect(names(a, b)).toEqual(["SHOP_ID"]);
  });

  it("goes away when the line that read it is taken out, a later change, or its file is deleted", () => {
    const added = file("src/a.ts", ["+  x(process.env.SHOP_ID);"]);
    const other = file("src/b.ts", ["+  y(process.env.SHOP_ID);"]);
    const after = readsAfter(readsAfter({}, [added, other]), [file("src/a.ts", ["-  x(process.env.SHOP_ID);"])]);
    // still read by the other file
    expect(needsOf(after).map((n) => n.name)).toEqual(["SHOP_ID"]);
    expect(needsOf(readsAfter(after, [file("src/b.ts", [], "delete")])).map((n) => n.name)).toEqual([]);
  });

  it("lists each secret with what it is, in name order", () => {
    const f = file("src/a.ts", ["+  a(process.env.STRIPE_SECRET_KEY, process.env.PROMPTPAY_SHOP_ID);"]);
    expect(needsOf(reads(f))).toEqual([SHOP, STRIPE]);
  });
});

describe("what a preview runs with", () => {
  it("is a sample for every secret, until the owner adds one", () => {
    expect(previewEnv([SHOP, STRIPE])).toEqual([
      { ...SHOP, value: SAMPLES.shop_id, sample: true },
      { ...STRIPE, value: SAMPLES.key, sample: true },
    ]);
  });

  it("is the owner's value for the secret the owner added, and a sample for the rest", () => {
    const env = previewEnv([SHOP, STRIPE], { PROMPTPAY_SHOP_ID: "0899999999" });
    expect(env.find((s) => s.name === "PROMPTPAY_SHOP_ID")).toMatchObject({ value: "0899999999", sample: false });
    expect(env.find((s) => s.name === "STRIPE_SECRET_KEY")).toMatchObject({ value: SAMPLES.key, sample: true });
  });

  it("never takes a real secret from anywhere the owner did not add it: not this computer's environment", () => {
    const was = process.env.PROMPTPAY_SHOP_ID;
    process.env.PROMPTPAY_SHOP_ID = "0812345678";
    try {
      expect(previewEnv([SHOP])[0]).toMatchObject({ value: SAMPLES.shop_id, sample: true });
    } finally {
      if (was === undefined) delete process.env.PROMPTPAY_SHOP_ID;
      else process.env.PROMPTPAY_SHOP_ID = was;
    }
  });

  it("does not count an empty value as one the owner added, nor a value for a secret the project does not read", () => {
    expect(previewEnv([SHOP], { PROMPTPAY_SHOP_ID: "" })[0].sample).toBe(true);
    expect(previewEnv([SHOP], { PROMPTPAY_SHOP_ID: "   " })[0].sample).toBe(true);
    expect(previewEnv([SHOP], { OTHER_KEY: "x" })).toHaveLength(1);
  });

  it("uses samples that are plainly not real: all zeros for a shop ID, so no payment can reach anyone", () => {
    expect(SAMPLES.shop_id).toMatch(/^0+$/);
    expect(SAMPLES.key).toMatch(/sample/i);
  });

  it("lists the secrets still on a sample, and none once the owner added each", () => {
    expect(onSample([SHOP, STRIPE], { STRIPE_SECRET_KEY: "k" })).toEqual([SHOP]);
    expect(onSample([SHOP], { PROMPTPAY_SHOP_ID: "0899999999" })).toEqual([]);
    expect(onSample([])).toEqual([]);
  });
});

describe("what each session's changes need", () => {
  it("is kept per session, and counted again with each change", () => {
    noteReads("agent:s1", [file("src/checkout.tsx", ["+  qr(process.env.PROMPTPAY_SHOP_ID);"])]);
    noteReads("agent:s2", [file("src/a.ts", ["+  k(process.env.STRIPE_SECRET_KEY);"])]);
    expect(sessionsWithNeeds()).toEqual([
      { chat: "agent:s1", needs: [SHOP] },
      { chat: "agent:s2", needs: [STRIPE] },
    ]);
    noteReads("agent:s1", [file("src/checkout.tsx", ["-  qr(process.env.PROMPTPAY_SHOP_ID);"])]);
    expect(sessionsWithNeeds()).toEqual([{ chat: "agent:s2", needs: [STRIPE] }]);
  });

  it("is nothing for a change that reads no secret", () => {
    noteReads("agent:s1", [file("README.md", ["+Hello"])]);
    expect(sessionsWithNeeds()).toEqual([]);
  });
});

describe("what a project's sessions need", () => {
  const list = [
    { id: "s1", cwd: "/Users/fon/baanmali-preorder" },
    { id: "s2", cwd: "/Users/fon/baanmali-preorder/" },
    { id: "s3", cwd: "/Users/fon/storefront" },
  ];

  it("is what the sessions that started in its folder read, once each, in name order", () => {
    const found = [
      { chat: "agent:s2", needs: [STRIPE, SHOP] },
      { chat: "agent:s1", needs: [SHOP] },
      { chat: "agent:s3", needs: [{ name: "OTHER_TOKEN", kind: "key" as const }] },
    ];
    expect(needsOfProject("/Users/fon/baanmali-preorder", found, list)).toEqual([SHOP, STRIPE]);
    expect(needsOfProject("/Users/fon/storefront", found, list)).toEqual([{ name: "OTHER_TOKEN", kind: "key" }]);
  });

  it("is nothing for a session that is gone, a chat that is not a session's, or another folder", () => {
    const found = [{ chat: "agent:s9", needs: [SHOP] }, { chat: "kami", needs: [SHOP] }];
    expect(needsOfProject("/Users/fon/baanmali-preorder", found, list)).toEqual([]);
    expect(needsOfProject("/Users/fon/elsewhere", [{ chat: "agent:s1", needs: [SHOP] }], list)).toEqual([]);
  });
});

describe("the words, from the canvas", () => {
  it("say what the canvas says, in English", () => {
    expect(t("kit.sample.tag")).toBe("Sample");
    expect(t("kit.sample.shop_id")).toBe("The preview has no shop ID yet, so the QR code is a sample.");
    expect(t("kit.sample.add.shop_id")).toBe("Add the shop ID");
  });

  it("say that the vault comes later, and that a test payment cannot reach the owner's account", () => {
    expect(t("kit.sample.vault")).toContain("comes later");
    expect(t("kit.sample.vault")).toContain("test payment can't reach your account");
  });

  it("are in all four languages", () => {
    for (const l of ["en", "ko", "ja", "zh"] as const) for (const k of Object.keys(DICT.en).filter((x) => x.startsWith("kit.sample."))) expect(DICT[l][k as keyof typeof DICT.en], `${l} ${k}`).toBeTruthy();
  });
});
