/// PromptPay QR payloads for the pilot's manual payments.
///
/// A PromptPay QR code carries an EMVCo merchant-presented payload: a run of
/// tag, two-digit length and value fields, closed by a CRC. The field ids, the
/// PromptPay GUID and the CRC variant follow dtinth/promptpay-qr (MIT,
/// https://github.com/dtinth/promptpay-qr, index.js), whose published test
/// vectors this package's tests reproduce byte for byte. Money is taken in
/// satang (integers) so no float ever decides what a customer pays.

const ID_PAYLOAD_FORMAT = "00";
const ID_POI_METHOD = "01";
const ID_MERCHANT_INFORMATION_BOT = "29";
const ID_TRANSACTION_CURRENCY = "53";
const ID_TRANSACTION_AMOUNT = "54";
const ID_COUNTRY_CODE = "58";
const ID_CRC = "63";

const PAYLOAD_FORMAT_MERCHANT_PRESENTED = "01";
/// Static codes may be paid any amount; dynamic ones carry a fixed amount.
const POI_METHOD_STATIC = "11";
const POI_METHOD_DYNAMIC = "12";
const MERCHANT_GUID = "00";
const BOT_PHONE = "01";
const BOT_TAX_ID = "02";
const BOT_EWALLET = "03";
const GUID_PROMPTPAY = "A000000677010111";
const CURRENCY_THB = "764";
const COUNTRY_TH = "TH";

export type PromptPayTarget = "phone" | "taxId" | "eWallet";

export class PromptPayError extends Error {
  readonly code: "invalid_id" | "invalid_amount";

  constructor(code: PromptPayError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/// Which kind of PromptPay id a number is. Spaces, dashes and a leading plus
/// are ignored. A Thai mobile number is 10 digits starting with 0, or 11
/// starting with 66; national ids and tax ids are 13 digits; e-wallet ids 15.
/// Anything else is refused rather than guessed, because a wrong id sends
/// the customer's money to someone else.
export function targetOf(id: string): { kind: PromptPayTarget; digits: string } {
  const digits = id.replace(/[^0-9]/g, "");
  // An id of nothing but zeros has the right length but names nobody.
  if (/^0*$/.test(digits)) {
    throw new PromptPayError("invalid_id", "not a PromptPay phone number, national id, tax id or e-wallet id");
  }
  if (digits.length === 15) return { kind: "eWallet", digits };
  if (digits.length === 13) return { kind: "taxId", digits };
  if ((digits.length === 10 && digits.startsWith("0")) || (digits.length === 11 && digits.startsWith("66"))) {
    return { kind: "phone", digits };
  }
  throw new PromptPayError("invalid_id", "not a PromptPay phone number, national id, tax id or e-wallet id");
}

function field(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/// A phone number travels as 13 digits: the leading 0 becomes the country
/// code 66, then zeros pad the front.
function formatTarget(kind: PromptPayTarget, digits: string): string {
  if (kind !== "phone") return digits;
  return digits.replace(/^0/, "66").padStart(13, "0");
}

/// Baht with two decimals, built from integer satang.
export function formatAmount(amountSatang: number): string {
  if (!Number.isSafeInteger(amountSatang) || amountSatang <= 0) {
    throw new PromptPayError("invalid_amount", "the amount must be a positive whole number of satang");
  }
  const text = `${Math.floor(amountSatang / 100)}.${String(amountSatang % 100).padStart(2, "0")}`;
  // The amount field holds at most 13 characters (EMVCo tag 54).
  if (text.length > 13) throw new PromptPayError("invalid_amount", "the amount is too large for a QR code");
  return text;
}

/// CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection,
/// no final XOR. The same value dtinth/promptpay-qr gets from
/// `crc16xmodem(text, 0xffff)`. The payload is ASCII, so each character is
/// one byte.
export function crc16(text: string): number {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i++) {
    crc ^= (text.charCodeAt(i) & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/// The text to put in the QR code. Without an amount the code is static and
/// the customer types the amount; with one it is dynamic and fixed.
export function promptPayPayload(input: { id: string; amountSatang?: number }): string {
  const { kind, digits } = targetOf(input.id);
  const botId = kind === "eWallet" ? BOT_EWALLET : kind === "taxId" ? BOT_TAX_ID : BOT_PHONE;
  const hasAmount = input.amountSatang !== undefined;
  const parts = [
    field(ID_PAYLOAD_FORMAT, PAYLOAD_FORMAT_MERCHANT_PRESENTED),
    field(ID_POI_METHOD, hasAmount ? POI_METHOD_DYNAMIC : POI_METHOD_STATIC),
    field(ID_MERCHANT_INFORMATION_BOT, field(MERCHANT_GUID, GUID_PROMPTPAY) + field(botId, formatTarget(kind, digits))),
    field(ID_COUNTRY_CODE, COUNTRY_TH),
    field(ID_TRANSACTION_CURRENCY, CURRENCY_THB),
    hasAmount ? field(ID_TRANSACTION_AMOUNT, formatAmount(input.amountSatang as number)) : "",
  ];
  // The CRC covers everything before it, including its own id and length.
  const body = `${parts.join("")}${ID_CRC}04`;
  return body + crc16(body).toString(16).toUpperCase().padStart(4, "0");
}

export type PromptPayReadRefusal =
  | "not_text"
  | "bad_crc"
  | "bad_length"
  | "bad_format"
  | "bad_guid"
  | "bad_country"
  | "bad_currency"
  | "bad_id"
  | "bad_amount";

export type PromptPayRead =
  | {
      ok: true;
      kind: PromptPayTarget;
      /// Phone numbers come back as typed locally (0 and nine digits); the
      /// other kinds are their 13 or 15 digits.
      id: string;
      /// Absent when the code lets the payer type the amount.
      amountSatang?: number;
      /// "dynamic" means the code fixes the amount (point of initiation 12).
      method: "static" | "dynamic";
    }
  | { ok: false; reason: PromptPayReadRefusal };

/// Splits "tag, two-digit length, value" runs. Returns null when a length is
/// not digits or runs past the end, or a tag is seen twice: a payload that
/// says one thing twice could be read two ways, so it is refused.
function readFields(text: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  let at = 0;
  while (at < text.length) {
    const tag = text.slice(at, at + 2);
    const lengthText = text.slice(at + 2, at + 4);
    if (tag.length < 2 || !/^[0-9]{2}$/.test(tag) || !/^[0-9]{2}$/.test(lengthText)) return null;
    const length = Number(lengthText);
    const value = text.slice(at + 4, at + 4 + length);
    if (value.length !== length || fields.has(tag)) return null;
    fields.set(tag, value);
    at += 4 + length;
  }
  return fields;
}

/// Takes a PromptPay QR payload apart, the reverse of `promptPayPayload`.
/// Never throws: a payload it cannot trust comes back as a refusal, because
/// a half-read code could send a customer's money to the wrong place.
export function readPromptPayPayload(text: string): PromptPayRead {
  if (typeof text !== "string") return { ok: false, reason: "not_text" };
  const refuse = (reason: PromptPayReadRefusal): PromptPayRead => ({ ok: false, reason });

  // The CRC field closes the payload: "6304" and four hex digits.
  const crcAt = text.length - 8;
  if (crcAt < 0 || text.slice(crcAt, crcAt + 4) !== `${ID_CRC}04`) return refuse("bad_crc");
  const crcText = text.slice(crcAt + 4);
  if (!/^[0-9A-Fa-f]{4}$/.test(crcText) || crc16(text.slice(0, crcAt + 4)) !== parseInt(crcText, 16)) {
    return refuse("bad_crc");
  }

  const fields = readFields(text.slice(0, crcAt));
  if (!fields) return refuse("bad_length");

  if (fields.get(ID_PAYLOAD_FORMAT) !== PAYLOAD_FORMAT_MERCHANT_PRESENTED) return refuse("bad_format");
  const poi = fields.get(ID_POI_METHOD);
  if (poi !== POI_METHOD_STATIC && poi !== POI_METHOD_DYNAMIC) return refuse("bad_format");
  if (fields.get(ID_COUNTRY_CODE) !== COUNTRY_TH) return refuse("bad_country");
  if (fields.get(ID_TRANSACTION_CURRENCY) !== CURRENCY_THB) return refuse("bad_currency");

  const merchant = fields.get(ID_MERCHANT_INFORMATION_BOT);
  if (merchant === undefined) return refuse("bad_guid");
  const inner = readFields(merchant);
  if (!inner) return refuse("bad_length");
  if (inner.get(MERCHANT_GUID) !== GUID_PROMPTPAY) return refuse("bad_guid");

  const phone = inner.get(BOT_PHONE);
  const taxId = inner.get(BOT_TAX_ID);
  const eWallet = inner.get(BOT_EWALLET);
  if ([phone, taxId, eWallet].filter((v) => v !== undefined).length !== 1) return refuse("bad_id");

  let kind: PromptPayTarget;
  let id: string;
  if (phone !== undefined) {
    // 0066 plus the nine digits after a local 0.
    if (!/^0066[0-9]{9}$/.test(phone)) return refuse("bad_id");
    kind = "phone";
    id = `0${phone.slice(4)}`;
  } else if (taxId !== undefined) {
    if (!/^[0-9]{13}$/.test(taxId) || /^0+$/.test(taxId)) return refuse("bad_id");
    kind = "taxId";
    id = taxId;
  } else {
    if (!/^[0-9]{15}$/.test(eWallet as string) || /^0+$/.test(eWallet as string)) return refuse("bad_id");
    kind = "eWallet";
    id = eWallet as string;
  }

  const method = poi === POI_METHOD_DYNAMIC ? "dynamic" : "static";
  const amountText = fields.get(ID_TRANSACTION_AMOUNT);
  if (amountText === undefined) {
    // A dynamic code with no amount contradicts itself.
    if (method === "dynamic") return refuse("bad_amount");
    return { ok: true, kind, id, method };
  }
  const match = /^([0-9]{1,11})(?:\.([0-9]{1,2}))?$/.exec(amountText);
  if (!match) return refuse("bad_amount");
  const amountSatang = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amountSatang) || amountSatang <= 0) return refuse("bad_amount");
  return { ok: true, kind, id, amountSatang, method };
}
