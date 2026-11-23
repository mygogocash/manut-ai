import { describe, expect, it } from "vitest";
import { expiredAt, isExpired, RETENTION } from "../src/retention";

describe("retention policy", () => {
  it("keeps the chartered windows", () => {
    expect(RETENTION.sourceSnapshotDays).toBe(7);
    expect(RETENTION.opsMetadataDays).toBe(30);
  });

  it("expires snapshots after seven days, metadata after thirty", () => {
    const created = Date.UTC(2026, 8, 1);
    expect(isExpired(created + 6 * 24 * 3600 * 1000, created, RETENTION.sourceSnapshotDays)).toBe(false);
    expect(isExpired(expiredAt(created, RETENTION.sourceSnapshotDays), created, RETENTION.sourceSnapshotDays)).toBe(
      true,
    );
    expect(isExpired(created + 29 * 24 * 3600 * 1000, created, RETENTION.opsMetadataDays)).toBe(false);
    expect(isExpired(created + 31 * 24 * 3600 * 1000, created, RETENTION.opsMetadataDays)).toBe(true);
  });
});
