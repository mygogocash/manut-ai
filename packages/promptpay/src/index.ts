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
