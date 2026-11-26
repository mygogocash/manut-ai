import { afterEach, describe, expect, it, vi } from "vitest";
import { inTauri } from "./tauri";

describe("inTauri", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is false with no window, false in a plain page, and true once the shell's bridge is there", () => {
    expect(inTauri()).toBe(false);
    vi.stubGlobal("window", {});
    expect(inTauri()).toBe(false);
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(inTauri()).toBe(true);
  });
});
