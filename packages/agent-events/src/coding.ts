/// Tolerant decoding, as GoSpark hand-writes it (`Core/Sources/GoSparkShared/Coding.swift`).
///
/// GoSpark has no migration step: a field added later must read from a save written before it,
/// and a value a newer build wrote must not cost an older one the whole record. Its decoders
/// therefore never throw on one field. `container.value(key, default:)` gives a missing or
/// wrong-typed value its default, and `Lenient` drops one unreadable element from a list without
/// losing the others. The readers below are those two tools for plain parsed JSON. Each returns
/// `undefined` where Swift's `try? decodeIfPresent` would give nil, so a call site reads as its
/// Swift line does: `readString(fields, "title") ?? ""`.

/// A UUID as text. Swift compares UUIDs by their bytes and writes them in capitals, while
/// JavaScript makes them in lower case and compares text. Every UUID read here is therefore
/// lower-cased, so `===` agrees with Swift's `==` whichever side wrote the id.
export type UUID = string;

/// An ISO 8601 instant, such as `2026-09-01T10:00:00Z`. GoSpark's stored JSON writes dates this
/// way (`JSONEncoder.storage`), without fractional seconds, and its decoder reads no fractions,
/// so a date meant for a GoSpark reader is made with `isoDate`.
export type ISODate = string;

/// What a decoder may ask for when a record has lost a value GoSpark replaces rather than
/// defaults: a fresh id for a record whose own is unreadable (`UUID()`), and the time of
/// reading for a date that is (`.now`). They are parameters so a test can pin both.
export interface DecodeContext {
  readonly newID: () => UUID;
  readonly now: () => ISODate;
}

/// The context every decoder uses unless it is given another: random ids and the real clock.
export const liveDecodeContext: DecodeContext = {
  newID: () => crypto.randomUUID(),
  now: () => isoDate(new Date()),
};

/// A date as GoSpark's storage writes it: UTC, whole seconds.
export function isoDate(date: Date): ISODate {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/// A parsed JSON object, read key by key.
export type Fields = Readonly<Record<string, unknown>>;

const NO_FIELDS: Fields = Object.freeze({});

export function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/// The object's fields, or none when the value is not an object, so a nested reader needs no
/// check of its own.
export function fieldsOf(value: unknown): Fields {
  return isObject(value) ? value : NO_FIELDS;
}

/// Parses JSON text without throwing. A truncated file decodes to nothing, which the caller
/// can tell apart from an empty document.
export function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/// The value under `key`, only when the object itself holds it. A key such as `constructor`
/// would otherwise read a function off `Object.prototype`.
export function readValue(fields: Fields, key: string): unknown {
  return Object.hasOwn(fields, key) ? fields[key] : undefined;
}

export function readString(fields: Fields, key: string): string | undefined {
  const value = readValue(fields, key);
  return typeof value === "string" ? value : undefined;
}

export function readBool(fields: Fields, key: string): boolean | undefined {
  const value = readValue(fields, key);
  return typeof value === "boolean" ? value : undefined;
}

/// A whole number. Swift's `Int` refuses a fraction, so `2.5` is unreadable here too.
export function readInt(fields: Fields, key: string): number | undefined {
  const value = readValue(fields, key);
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function readNumber(fields: Fields, key: string): number | undefined {
  const value = readValue(fields, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// The text as a UUID in lower case, or `undefined` when it is not one.
export function asUUID(value: unknown): UUID | undefined {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

export function readUUID(fields: Fields, key: string): UUID | undefined {
  return asUUID(readValue(fields, key));
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/// An ISO 8601 date and time, kept as it was written. Fractional seconds are accepted, which
/// GoSpark's decoder is not, because JavaScript writes them by default.
export function readDate(fields: Fields, key: string): ISODate | undefined {
  const value = readValue(fields, key);
  if (typeof value !== "string" || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

/// One of an enum's known raw values, or `undefined` for anything else.
export function readCase<T extends string>(fields: Fields, key: string, cases: readonly T[]): T | undefined {
  const value = readValue(fields, key);
  return typeof value === "string" && (cases as readonly string[]).includes(value) ? (value as T) : undefined;
}

/// An enum that keeps a value this build does not know as `"unknown"` rather than dropping the
/// record it sits on. GoSpark's synthesized decoders throw there, which costs the whole row.
/// A key that is absent is a different thing from a value that is not understood, so it takes
/// `missing`: the default Swift declares for the property, or `"unknown"` where it declares none.
export function readCaseOrUnknown<T extends string>(
  fields: Fields,
  key: string,
  cases: readonly T[],
  missing: T | "unknown" = "unknown",
): T | "unknown" {
  const value = readValue(fields, key);
  if (value === undefined || value === null) return missing;
  return typeof value === "string" && (cases as readonly string[]).includes(value) ? (value as T) : "unknown";
}

/// A list read as GoSpark's `Lenient` reads one: an element that will not decode costs that
/// element, not its neighbours. `undefined` when the key holds no list at all.
export function readList<T>(fields: Fields, key: string, element: (value: unknown) => T | undefined): T[] | undefined {
  const value = readValue(fields, key);
  if (!Array.isArray(value)) return undefined;
  const kept: T[] = [];
  for (const entry of value as unknown[]) {
    const decoded = element(entry);
    if (decoded !== undefined) kept.push(decoded);
  }
  return kept;
}

/// A list read as Swift reads a plain `[T]`: one unreadable element makes the whole list
/// unreadable, and the field then takes its default. GoSpark decodes lists of ids, numbers and
/// names this way, where a list with a hole in it would say something the writer never meant.
export function readStrictList<T>(
  fields: Fields,
  key: string,
  element: (value: unknown) => T | undefined,
): T[] | undefined {
  const value = readValue(fields, key);
  if (!Array.isArray(value)) return undefined;
  const kept: T[] = [];
  for (const entry of value as unknown[]) {
    const decoded = element(entry);
    if (decoded === undefined) return undefined;
    kept.push(decoded);
  }
  return kept;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];

/// `T` with every key that may hold `undefined` turned into a key that may be absent.
export type Compacted<T> = { [K in Exclude<keyof T, OptionalKeys<T>>]: T[K] } & {
  [K in OptionalKeys<T>]?: Exclude<T[K], undefined>;
};

/// Drops the keys whose value is `undefined`, so an absent optional is an absent key. Swift's
/// encoder writes no key for a nil optional, and older GoSpark builds and paired phones rely on
/// that: a call that was never cut off is saved exactly as it was before the mark existed.
export function compact<T extends Record<string, unknown>>(value: T): Compacted<T> {
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) kept[key] = field;
  }
  return kept as Compacted<T>;
}
