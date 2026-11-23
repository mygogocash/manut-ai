import { describe, expect, it } from "vitest";
import {
  type AssistantMessage,
  EXCERPT_LIMIT,
  type ResearchSourceRecord,
  type TimelineItem,
  decodeAssistantMessage,
  decodeResearchSourceRecord,
  decodeTimelineItem,
  encodeTimelineItem,
  researchSourceRecord,
} from "../src/index";
import { overTheWire, uuid } from "./support";

/// Pins the research source record an answer keeps: what survives a save and a reload, how a
/// record from another build reads, and that a gap stays a gap. Ported from GoSpark's
/// `Tests/Shared/ResearchEvidenceTests.swift`.
describe("ResearchEvidenceTests", () => {
  /// A whole second, because the library writes dates as ISO 8601 without fractions.
  const retrieved = "2026-09-22T08:26:40Z";
  const run = { retrievedAt: retrieved, provider: "perplexity", runID: "run-1", responseID: "resp-1" };

  const found = (index = 1, excerpt: string | undefined = "Swift 6 makes data races compile errors."): ResearchSourceRecord =>
    researchSourceRecord({
      index,
      url: "https://swift.org/blog/swift-6",
      title: "Swift 6 released",
      providerSourceID: "src-1",
      publishedDate: "2024-09-17",
      updatedDate: "2024-10-01",
      excerpt,
      ...run,
    });

  const gap = (index: number): ResearchSourceRecord => researchSourceRecord({ index, ...run });

  it("roundTrip: a record survives the library's encoder unchanged, retrieval time included", () => {
    expect(decodeResearchSourceRecord(overTheWire(found()))).toStrictEqual(found());
    expect(decodeResearchSourceRecord(overTheWire(gap(3)))).toStrictEqual(gap(3));
    expect(gap(3)).toStrictEqual({ index: 3, isMissing: true, excerptTruncated: false, ...run });
  });

  it("eachKeyMissing: a record missing any one key still decodes, and only that field takes its default", () => {
    const full = overTheWire(found()) as Record<string, unknown>;
    const expected: Record<string, ResearchSourceRecord> = {
      index: { ...found(), index: 0 },
      // With no address the source is missing, and a missing record keeps nothing a found one would show.
      url: gap(1),
      retrievedAt: (({ retrievedAt: _dropped, ...rest }) => rest)(found()),
      excerptTruncated: found(),
      isMissing: found(),
      provider: { ...found(), provider: "" },
      runID: { ...found(), runID: "" },
      responseID: { ...found(), responseID: "" },
    };
    for (const key of ["providerSourceID", "title", "publishedDate", "updatedDate", "excerpt"] as const) {
      const { [key]: _dropped, ...rest } = found();
      expected[key] = rest as ResearchSourceRecord;
    }
    expect(Object.keys(full).sort()).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(full)) {
      const { [key]: _removed, ...partial } = full;
      expect(decodeResearchSourceRecord(partial), `without ${key}`).toStrictEqual(expected[key]);
    }
    const empty = decodeResearchSourceRecord({});
    expect(empty).toStrictEqual({ index: 0, isMissing: true, excerptTruncated: false, provider: "", runID: "", responseID: "" });
  });

  it("assistantMessageKeepsSources: an answer's sources survive a save and a reload, gaps and retrieval time included", () => {
    const message: AssistantMessage = { text: "See [1] and [2].", isStreaming: false, sources: [found(), gap(2)] };
    const item: TimelineItem = { id: "a1", turnID: uuid(1), date: retrieved, content: { type: "assistant", message } };
    expect(decodeTimelineItem(overTheWire(encodeTimelineItem(item)))).toStrictEqual(item);
    // A research answer that came back with no sources says so, and is not an old save.
    const bare: AssistantMessage = { text: "No sources.", isStreaming: false, sources: [] };
    expect(decodeAssistantMessage(overTheWire(bare))?.sources).toStrictEqual([]);
  });

  it("unreadableRecord: one unreadable record costs that record, not the answer or its other sources", () => {
    const message = decodeAssistantMessage({ text: "Answer", sources: [overTheWire(found()), 42, "not a record"] });
    expect(message?.text).toBe("Answer");
    expect(message?.sources).toStrictEqual([found()]);
    const wrongShape = decodeAssistantMessage({ text: "Answer", sources: "lost" });
    expect(wrongShape).toStrictEqual({ text: "Answer", isStreaming: false });
  });

  it("excerptTruncation: an excerpt past the limit is cut and says so, and one within it is left alone", () => {
    const long = "a".repeat(EXCERPT_LIMIT + 100);
    const cut = found(1, long);
    expect(cut.excerpt?.length).toBe(EXCERPT_LIMIT);
    expect(cut.excerptTruncated).toBe(true);
    const exact = "b".repeat(EXCERPT_LIMIT);
    expect(found(1, exact).excerpt).toBe(exact);
    expect(found(1, exact).excerptTruncated).toBe(false);
    expect(found(1, "   ").excerpt).toBeUndefined();
    expect(found(1, undefined).excerptTruncated).toBe(false);
    // A record written with more than the limit, by hand or by a later build, is cut on the way in too.
    const oversized = { ...(overTheWire(found()) as Record<string, unknown>), excerpt: long, excerptTruncated: false };
    const decoded = decodeResearchSourceRecord(oversized);
    expect(decoded?.excerpt?.length).toBe(EXCERPT_LIMIT);
    expect(decoded?.excerptTruncated).toBe(true);
  });

  it("an excerpt is cut between characters as a person reads them, never inside one", () => {
    // One Thai character here is a consonant with a vowel and a tone mark: three code points.
    const character = String.fromCodePoint(0x0e01, 0x0e35, 0x0e49);
    const cut = found(1, character.repeat(EXCERPT_LIMIT + 5));
    expect(cut.excerpt).toBe(character.repeat(EXCERPT_LIMIT));
    expect(cut.excerptTruncated).toBe(true);
  });

  it("publicationDate: a missing publication date stays unknown, and a given one is kept as written", () => {
    const dated = (publishedDate: string | undefined) => researchSourceRecord({ index: 1, url: "https://swift.org", publishedDate, ...run });
    expect(dated(undefined).publishedDate).toBeUndefined();
    expect(dated(undefined).retrievedAt).toBe(retrieved);
    expect(dated("  ").publishedDate).toBeUndefined();
    expect(dated("2024").publishedDate).toBe("2024");
    expect(dated("2024").updatedDate).toBeUndefined();
  });

  it("missingStaysMissing: a missing source keeps no address, title, date or excerpt, however it is made", () => {
    const marked = researchSourceRecord({
      index: 4,
      url: "https://invented.example",
      title: "Looks found",
      isMissing: true,
      publishedDate: "2024-01-01",
      excerpt: "Something",
      excerptTruncated: true,
      ...run,
    });
    expect(marked).toStrictEqual(gap(4));
    const blank = researchSourceRecord({ index: 5, url: "  ", title: "Untitled", ...run });
    expect(blank).toStrictEqual(gap(5));
    // A saved record that says missing reads as missing even if an address was written beside it.
    const contradictory = { ...(overTheWire(found()) as Record<string, unknown>), isMissing: true };
    expect(decodeResearchSourceRecord(contradictory)).toStrictEqual(gap(1));
  });
});
