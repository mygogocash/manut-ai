// The one constant-time comparison the Worker uses for the operator key, the cloud key, an email code's HMAC and an outpost's
// credential digest (src/timing-safe.ts): equal only when every character is, whatever the lengths.
import { describe, expect, it } from "vitest";
import { timingSafeEqual } from "../src/timing-safe";

describe("timingSafeEqual", () => {
  it("is true only for the very same string", () => {
    expect(timingSafeEqual("a1b2c3", "a1b2c3")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("a1b2c3", "a1b2c4")).toBe(false);
    expect(timingSafeEqual("x1b2c3", "a1b2c3")).toBe(false);
    expect(timingSafeEqual("a1b2c3", "a1b2c")).toBe(false);
    expect(timingSafeEqual("a1b2c", "a1b2c3")).toBe(false);
    expect(timingSafeEqual("é", "e")).toBe(false);
  });
});
