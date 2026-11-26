import { describe, expect, it, vi } from "vitest";
import { downloadText, exportFileName, REVOKE_AFTER_MS } from "../src/ops/download";
import { captureDownloads } from "./helpers";

const AT = "2026-11-23T03:00:00Z";

describe("the export's file name", () => {
  it("is the shop's name and the export's day on the shop's calendar", () => {
    expect(exportFileName("Baan Mali", "shop_baanmali", AT)).toBe("baan-mali-export-2026-11-23.json");
    // 00:30 on 24 November in Bangkok is still 23 November in UTC.
    expect(exportFileName("Baan Mali", "shop_baanmali", "2026-11-23T17:30:00Z")).toBe(
      "baan-mali-export-2026-11-24.json",
    );
  });

  it("keeps letters in any script, turns everything else into dashes, and falls back to the shop's id", () => {
    expect(exportFileName("ร้านบ้านมะลิ", "shop_x", AT)).toBe("ร้านบ้านมะลิ-export-2026-11-23.json");
    expect(exportFileName("  Sabai Tea & Co. / 2 ", "shop_x", AT)).toBe("sabai-tea-co-2-export-2026-11-23.json");
    expect(exportFileName("!!!", "pilot:6f1c-22aa", AT)).toBe("pilot-6f1c-22aa-export-2026-11-23.json");
    expect(exportFileName("x".repeat(300), "shop_x", AT)).toBe(`${"x".repeat(50)}-export-2026-11-23.json`);
  });

  it("uses the day it is now when the export carries no time it can read", () => {
    expect(exportFileName("Baan Mali", "shop_baanmali", "", Date.parse(AT))).toBe(
      "baan-mali-export-2026-11-23.json",
    );
  });
});

describe("downloading a file", () => {
  it("hands the text to the browser under the file's name, then lets the object URL go", async () => {
    const { blobs, revoked, downloads } = captureDownloads();
    vi.useFakeTimers();

    downloadText("baan-mali-export-2026-11-23.json", '{"tenant":"shop_baanmali"}', "application/json");

    expect(downloads).toEqual([
      { name: "baan-mali-export-2026-11-23.json", href: "blob:https://web.test/download-1", attached: true },
    ]);
    expect(document.querySelector("a")).toBeNull();
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(REVOKE_AFTER_MS);
    expect(revoked).toEqual(["blob:https://web.test/download-1"]);

    vi.useRealTimers();
    expect(blobs[0]!.type).toBe("application/json");
    expect(await blobs[0]!.text()).toBe('{"tenant":"shop_baanmali"}');
  });
});
