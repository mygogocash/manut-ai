import { describe, expect, it } from "vitest";
import {
  asInt,
  asUUID,
  compact,
  fieldsOf,
  isoDate,
  liveDecodeContext,
  parseJSON,
  readBool,
  readCase,
  readCaseOrUnknown,
  readDate,
  readInt,
  readList,
  readNumber,
  readStrictList,
  readString,
} from "../src/index";

/// The readers every decoder is built from. Each gives `undefined` where Swift's
/// `try? decodeIfPresent` gives nil: for a key that is missing, null, or of another type.
describe("tolerant readers", () => {
  const fields = { text: "hi", count: 3, ratio: 2.5, flag: false, none: null, list: [1, "two", 3], when: "2026-09-01T10:00:00Z" };

  it("read a value of the right type and nothing else", () => {
    expect(readString(fields, "text")).toBe("hi");
    expect(readString(fields, "count")).toBeUndefined();
    expect(readString(fields, "none")).toBeUndefined();
    expect(readString(fields, "missing")).toBeUndefined();
    expect(readBool(fields, "flag")).toBe(false);
    expect(readBool(fields, "count")).toBeUndefined();
    expect(readNumber(fields, "ratio")).toBe(2.5);
    expect(readNumber(fields, "text")).toBeUndefined();
  });

  it("read a whole number only, as Swift's Int does", () => {
    expect(readInt(fields, "count")).toBe(3);
    expect(readInt(fields, "ratio")).toBeUndefined();
    expect(readInt({ count: "3" }, "count")).toBeUndefined();
    expect(readInt({ count: Number.MAX_SAFE_INTEGER + 2 }, "count")).toBeUndefined();
    expect(readInt({ count: -4 }, "count")).toBe(-4);
  });

  it("read a date written with or without fractions and offsets, kept as written", () => {
    for (const written of ["2026-09-01T10:00:00Z", "2026-09-01T10:00:00.250Z", "2026-09-01T17:00:00+07:00", "2026-09-01T10:00:00+0000"]) {
      expect(readDate({ when: written }, "when"), written).toBe(written);
    }
    for (const written of ["yesterday", "2026-09-01", "2026-13-45T10:00:00Z", "2026-09-01 10:00:00", 1_790_000_000, null]) {
      expect(readDate({ when: written }, "when"), String(written)).toBeUndefined();
    }
  });

  it("read a UUID in either case as the lower case JavaScript makes", () => {
    expect(asUUID("75046753-532C-4F36-87E8-07578CC1C539")).toBe("75046753-532c-4f36-87e8-07578cc1c539");
    expect(asUUID("75046753-532c-4f36-87e8-07578cc1c539")).toBe("75046753-532c-4f36-87e8-07578cc1c539");
    for (const value of ["not-a-uuid", "75046753532C4F3687E807578CC1C539", "", 7, null, undefined]) {
      expect(asUUID(value)).toBeUndefined();
    }
  });

  it("read an enum's known case, and say which of missing and not understood it was", () => {
    const cases = ["running", "completed"] as const;
    expect(readCase({ status: "completed" }, "status", cases)).toBe("completed");
    expect(readCase({ status: "paused" }, "status", cases)).toBeUndefined();
    expect(readCaseOrUnknown({ status: "completed" }, "status", cases)).toBe("completed");
    expect(readCaseOrUnknown({ status: "paused" }, "status", cases)).toBe("unknown");
    expect(readCaseOrUnknown({ status: 7 }, "status", cases)).toBe("unknown");
    expect(readCaseOrUnknown({}, "status", cases)).toBe("unknown");
    expect(readCaseOrUnknown({}, "status", cases, "running")).toBe("running");
    expect(readCaseOrUnknown({ status: null }, "status", cases, "running")).toBe("running");
  });

  it("read a list leniently, or strictly where a list with a hole would say something else", () => {
    expect(readList(fields, "list", asInt)).toEqual([1, 3]);
    expect(readStrictList(fields, "list", asInt)).toBeUndefined();
    expect(readStrictList({ list: [1, 2] }, "list", asInt)).toEqual([1, 2]);
    expect(readList(fields, "text", asInt)).toBeUndefined();
    expect(readList(fields, "missing", asInt)).toBeUndefined();
    expect(readList({ list: [] }, "list", asInt)).toEqual([]);
  });

  it("treat anything that is not an object as having no fields", () => {
    for (const value of [undefined, null, 7, "text", [1, 2], true]) {
      expect(fieldsOf(value)).toEqual({});
    }
    expect(fieldsOf(fields)).toBe(fields);
  });

  it("parse JSON text without throwing", () => {
    expect(parseJSON('{"a":1}')).toEqual({ a: 1 });
    expect(parseJSON('{"a":')).toBeUndefined();
    expect(parseJSON("")).toBeUndefined();
  });
});

describe("writing", () => {
  it("an absent optional is an absent key, never a key holding undefined", () => {
    const written = compact({ id: "a", detail: undefined, count: 0, flag: false, text: "" });
    expect(written).toStrictEqual({ id: "a", count: 0, flag: false, text: "" });
    expect("detail" in written).toBe(false);
  });

  it("a date is written in whole seconds, which is all GoSpark's decoder reads", () => {
    expect(isoDate(new Date("2026-09-01T10:00:00.789Z"))).toBe("2026-09-01T10:00:00Z");
    expect(isoDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe("2026-01-02T03:04:05Z");
  });

  it("the live context makes ids and times the decoders themselves would read", () => {
    expect(asUUID(liveDecodeContext.newID())).toBeDefined();
    expect(readDate({ now: liveDecodeContext.now() }, "now")).toBeDefined();
  });
});
