import { describe, expect, it } from "vitest";
import {
  bangkokMonth,
  ceilSatang,
  costMillisatang,
  DEFAULT_CAP_SATANG,
  DEFAULT_SATANG_PER_USD,
  effectiveCap,
  estimateInputTokens,
  floorSatang,
  gatewaySettings,
  isMonth,
  MAX_CAP_SATANG,
  MODEL_PRICES,
  priceOf,
  worstCaseMillisatang,
} from "../src/model-price";
import { standInProvider, type ChatRequest } from "../src/model-provider";

// Every amount below is worked out by hand from the published per-million-token
// prices, so a change to the arithmetic shows up as a changed number rather than
// as a test that recomputes the same formula.

const haiku = MODEL_PRICES["claude-haiku-5-5"]!;
const sonnet = MODEL_PRICES["claude-sonnet-5-5"]!;
const opus = MODEL_PRICES["claude-opus-5-5"]!;

describe("the price table", () => {
  it("prices the current models per million tokens, in millionths of a dollar", () => {
    expect(haiku).toEqual({
      inputMicrosUsd: 100_000,
      outputMicrosUsd: 500_000,
      longPrompt: { overInputTokens: 100_000, inputMicrosUsd: 500_000, outputMicrosUsd: 2_500_000 },
    });
    expect(sonnet).toEqual({ inputMicrosUsd: 2_000_000, outputMicrosUsd: 10_000_000 });
    expect(opus).toEqual({ inputMicrosUsd: 4_000_000, outputMicrosUsd: 20_000_000 });
  });

  it("knows only the models it lists", () => {
    expect(priceOf("claude-sonnet-5-5")).toBe(sonnet);
    for (const model of ["gpt-5", "claude-sonnet-5-5-20260401", "constructor", "toString", "__proto__", ""]) {
      expect(priceOf(model)).toBeNull();
    }
  });
});

describe("integer price arithmetic", () => {
  it("converts tokens to millisatang exactly", () => {
    // 1,000 input and 500 output tokens on Sonnet 5.5 cost $0.007: ฿0.245 at ฿35 a dollar.
    expect(costMillisatang(sonnet, { inputTokens: 1_000, outputTokens: 500 }, 3_500)).toBe(24_500);
    // 100,000 input tokens on Haiku 5.5 cost $0.01: ฿0.35.
    expect(costMillisatang(haiku, { inputTokens: 100_000, outputTokens: 0 }, 3_500)).toBe(35_000);
    expect(costMillisatang(opus, { inputTokens: 0, outputTokens: 0 }, 3_500)).toBe(0);
  });

  it("rounds any fraction of a millisatang up, in Manut AI's favour", () => {
    // One Haiku input token costs 0.35 millisatang, and three cost 1.05.
    expect(costMillisatang(haiku, { inputTokens: 1, outputTokens: 0 }, 3_500)).toBe(1);
    expect(costMillisatang(haiku, { inputTokens: 3, outputTokens: 0 }, 3_500)).toBe(2);
    // One Sonnet input token at ฿33.01 a dollar costs 6.602 millisatang.
    expect(costMillisatang(sonnet, { inputTokens: 1, outputTokens: 0 }, 3_301)).toBe(7);
  });

  it("stays exact where the intermediate product passes Number.MAX_SAFE_INTEGER", () => {
    // 1,000,001 input and 16,000 output tokens on Opus 5.5 cost $4.320004, which is
    // ฿151.20014 at ฿35. On the way, tokens × micros × satang reaches about 1.5e16.
    expect(costMillisatang(opus, { inputTokens: 1_000_001, outputTokens: 16_000 }, 3_500)).toBe(15_120_014);
  });

  it("charges the whole call at Haiku's long-prompt price once the prompt passes 100,000 tokens", () => {
    // 100,000 × $0.10 + 1,000 × $0.50 per million tokens: $0.0105, ฿0.3675.
    expect(costMillisatang(haiku, { inputTokens: 100_000, outputTokens: 1_000 }, 3_500)).toBe(36_750);
    // 100,001 × $0.50 + 1,000 × $2.50 per million tokens: $0.0525005, ฿1.8375175.
    expect(costMillisatang(haiku, { inputTokens: 100_001, outputTokens: 1_000 }, 3_500)).toBe(183_752);
  });

  it("refuses counts and rates that are not whole, non-negative and safe", () => {
    for (const tokens of [
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 1.5, outputTokens: 0 },
      { inputTokens: 0, outputTokens: Number.NaN },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
    ]) {
      expect(() => costMillisatang(sonnet, tokens, 3_500)).toThrow(RangeError);
    }
    expect(() => costMillisatang(sonnet, { inputTokens: 1, outputTokens: 1 }, 35.5)).toThrow(RangeError);
    expect(() => costMillisatang(sonnet, { inputTokens: 1, outputTokens: 1 }, 0)).toThrow(RangeError);
  });

  it("shows whole satang rounded up, and what is left rounded down", () => {
    expect([0, 1, 999, 1_000, 1_001, 24_500].map(ceilSatang)).toEqual([0, 1, 1, 1, 2, 25]);
    expect([0, 1, 999, 1_000, 1_001, 24_500].map(floorSatang)).toEqual([0, 0, 0, 1, 1, 24]);
  });
});

describe("the worst case reserved before a call", () => {
  const request: ChatRequest = {
    model: "claude-sonnet-5-5",
    system: "You are Nam, the shop's sales chat.",
    messages: [
      { role: "user", content: "มีไซซ์ M ไหมคะ" },
      { role: "assistant", content: "มีค่ะ" },
      { role: "user", content: "ราคาเท่าไหร่" },
    ],
    maxOutputTokens: 400,
  };

  it("counts every UTF-8 byte as a token, plus room for the request's own framing", () => {
    const bytes = new TextEncoder().encode(`${request.system}มีไซซ์ M ไหมคะมีค่ะราคาเท่าไหร่`).byteLength;
    // 512 tokens for the request and 16 for each message, whatever the provider adds around them.
    expect(estimateInputTokens(request)).toBe(bytes + 512 + 3 * 16);
  });

  it("is the input estimate plus the whole output allowance, at the model's price", () => {
    expect(worstCaseMillisatang(sonnet, request, 3_500)).toBe(
      costMillisatang(sonnet, { inputTokens: estimateInputTokens(request), outputTokens: 400 }, 3_500),
    );
  });

  it("is never below what the stand-in provider then reports", async () => {
    const result = await standInProvider().complete(request);
    expect(costMillisatang(sonnet, result.usage, 3_500)).toBeLessThanOrEqual(worstCaseMillisatang(sonnet, request, 3_500));
  });
});

describe("months in Bangkok", () => {
  it("turns at midnight in Bangkok, seven hours ahead of UTC", () => {
    expect(bangkokMonth(Date.UTC(2026, 10, 30, 16, 59, 59, 999))).toBe("2026-11");
    expect(bangkokMonth(Date.UTC(2026, 10, 30, 17, 0, 0, 0))).toBe("2026-12");
    // Already 1 November in Bangkok while it is still 31 October in UTC.
    expect(bangkokMonth(Date.UTC(2026, 9, 31, 17, 0, 0, 0))).toBe("2026-11");
  });

  it("turns the year with the month", () => {
    expect(bangkokMonth(Date.UTC(2026, 11, 31, 16, 59, 59, 999))).toBe("2026-12");
    expect(bangkokMonth(Date.UTC(2026, 11, 31, 17, 0, 0, 0))).toBe("2027-01");
  });

  it("reads only a real year and month", () => {
    expect(["2026-11", "2027-01", "1999-12"].every(isMonth)).toBe(true);
    expect(["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", "", " 2026-11"].some(isMonth)).toBe(false);
  });
});

describe("the owner's settings", () => {
  it("falls back to the documented defaults when unset", () => {
    expect(DEFAULT_SATANG_PER_USD).toBe(3_500);
    expect(DEFAULT_CAP_SATANG).toBe(20_000);
    expect(gatewaySettings({})).toEqual({ ok: true, settings: { satangPerUsd: 3_500, defaultCapSatang: 20_000 } });
  });

  it("reads whole numbers of satang", () => {
    expect(gatewaySettings({ MODEL_SATANG_PER_USD: "3390", MODEL_DEFAULT_CAP_SATANG: "0" })).toEqual({
      ok: true,
      settings: { satangPerUsd: 3_390, defaultCapSatang: 0 },
    });
  });

  it("names a setting it cannot read instead of guessing", () => {
    for (const value of ["", "33.90", "3,390", "0", "-1", "฿34", " 3390", "1e3"]) {
      expect(gatewaySettings({ MODEL_SATANG_PER_USD: value })).toEqual({ ok: false, setting: "MODEL_SATANG_PER_USD" });
    }
    for (const value of ["", "200.50", "-1", String(MAX_CAP_SATANG + 1)]) {
      expect(gatewaySettings({ MODEL_DEFAULT_CAP_SATANG: value })).toEqual({
        ok: false,
        setting: "MODEL_DEFAULT_CAP_SATANG",
      });
    }
  });

  it("lets a shop's override replace the default, an override of zero included", () => {
    expect(effectiveCap(null, 20_000)).toEqual({ capSatang: 20_000, source: "default" });
    const stored = { capSatang: 0, setAt: "2026-11-23T00:00:00.000Z", setBy: null };
    expect(effectiveCap(stored, 20_000)).toEqual({ capSatang: 0, source: "override" });
  });
});
