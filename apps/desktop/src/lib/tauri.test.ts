import { afterEach, describe, expect, it } from "vitest";
import { inTauri } from "./tauri";

describe("inTauri", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });
  it("is false in a plain page and true once the shell's bridge is there", () => {
    expect(inTauri()).toBe(false);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(inTauri()).toBe(true);
  });
});
