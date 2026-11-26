/// One source behind a research answer, kept on the answer so the evidence can be inspected
/// later exactly as it stood when the answer arrived. Ported from GoSpark's
/// `Shared/ResearchEvidence.swift`.
///
/// Everything here is what the provider returned, or what the client knew when it asked.
/// Nothing is read out of the answer's prose and nothing is filled in. A number the answer cites
/// with nothing behind it, or a source that came back without an address, is a record with
/// `isMissing` set and no address, title, date or excerpt, so the gap reads as a gap rather than
/// as a source that was found.

import { type ISODate, compact, isObject, readBool, readDate, readInt, readString } from "./coding";
import { firstCharacters, trimmedOrUndefined } from "./text";

/// The longest excerpt a record keeps, in characters. An excerpt says what the source was about;
/// it does not carry the page. A longer one is cut and says so in `excerptTruncated`, so a
/// preview never passes for the whole text.
export const EXCERPT_LIMIT = 600;

export interface ResearchSourceRecord {
  /// The source's number in the answer, as in `[3]`.
  readonly index: number;
  /// The provider's own id for the source, when its reply gave one. Never an id the client made
  /// up, which would pass for the provider's.
  readonly providerSourceID?: string;
  /// The address as the provider gave it. Absent for a missing source.
  readonly url?: string;
  readonly title?: string;
  /// The page's publication date exactly as the provider wrote it. Never parsed, so a bare
  /// "2024" is not turned into a precise day. Absent reads as unknown, not as recent.
  readonly publishedDate?: string;
  /// When the provider says the page was last updated, as written.
  readonly updatedDate?: string;
  /// When the request the source came back on was sent: one time for every source of a run.
  /// Not when the provider fetched the page, and not the page's own date.
  readonly retrievedAt?: ISODate;
  /// The provider's snippet of the page, at most `EXCERPT_LIMIT` characters. Plain text, shown
  /// and never acted on: instructions inside a page stay words on the screen.
  readonly excerpt?: string;
  /// The provider's snippet was longer than the limit and `excerpt` is its start.
  readonly excerptTruncated: boolean;
  /// The answer cites this number, or the provider listed this source, with no address behind it.
  readonly isMissing: boolean;
  /// Which provider returned the source. Text, so a record from a provider this build does not
  /// know still decodes.
  readonly provider: string;
  /// The research run that used the source, and the provider's id for the response it came in.
  readonly runID: string;
  readonly responseID: string;
}

/// What a record is made from, before the rules below are applied.
export interface ResearchSourceInput {
  readonly index: number;
  readonly url?: string | undefined;
  readonly title?: string | undefined;
  readonly isMissing?: boolean | undefined;
  readonly providerSourceID?: string | undefined;
  readonly publishedDate?: string | undefined;
  readonly updatedDate?: string | undefined;
  readonly excerpt?: string | undefined;
  readonly excerptTruncated?: boolean | undefined;
  readonly retrievedAt?: ISODate | undefined;
  readonly provider: string;
  readonly runID: string;
  readonly responseID: string;
}

/// Makes a record, normalizing what it is given so every way a record is made, decoding one
/// included, keeps the same rules: a blank address is a missing source, a missing source keeps
/// only its number and the run it belongs to, blank text is absent and the excerpt is capped.
export function researchSourceRecord(input: ResearchSourceInput): ResearchSourceRecord {
  const address = trimmedOrUndefined(input.url);
  const missing = input.isMissing === true || address === undefined;
  if (missing) {
    return compact({
      index: input.index,
      retrievedAt: input.retrievedAt,
      excerptTruncated: false,
      isMissing: true,
      provider: input.provider,
      runID: input.runID,
      responseID: input.responseID,
    });
  }
  const excerpt = trimmedOrUndefined(input.excerpt);
  const capped = excerpt === undefined ? undefined : firstCharacters(excerpt, EXCERPT_LIMIT);
  return compact({
    index: input.index,
    providerSourceID: trimmedOrUndefined(input.providerSourceID),
    url: address,
    title: trimmedOrUndefined(input.title),
    publishedDate: trimmedOrUndefined(input.publishedDate),
    updatedDate: trimmedOrUndefined(input.updatedDate),
    retrievedAt: input.retrievedAt,
    excerpt: capped === undefined ? undefined : capped.text.trim(),
    excerptTruncated: capped !== undefined && (input.excerptTruncated === true || capped.cut),
    isMissing: false,
    provider: input.provider,
    runID: input.runID,
    responseID: input.responseID,
  });
}

/// A record from JSON. Every key is optional on the way in, so a record written by a newer or
/// an older build still reads; only a value that is not an object at all is dropped.
export function decodeResearchSourceRecord(json: unknown): ResearchSourceRecord | undefined {
  if (!isObject(json)) return undefined;
  return researchSourceRecord({
    index: readInt(json, "index") ?? 0,
    url: readString(json, "url"),
    title: readString(json, "title"),
    isMissing: readBool(json, "isMissing") ?? false,
    providerSourceID: readString(json, "providerSourceID"),
    publishedDate: readString(json, "publishedDate"),
    updatedDate: readString(json, "updatedDate"),
    excerpt: readString(json, "excerpt"),
    excerptTruncated: readBool(json, "excerptTruncated") ?? false,
    retrievedAt: readDate(json, "retrievedAt"),
    provider: readString(json, "provider") ?? "",
    runID: readString(json, "runID") ?? "",
    responseID: readString(json, "responseID") ?? "",
  });
}
