// Practice's Google Sheets (docs/connectors.md, 4b), so Customize › Connections can be seen and tried without an API: the person's
// own shop starts connected to a sample sheet, "Manut AI books: Baan Mali", with two months already sent to it (one confirmed, one
// whose answer Google never gave), as the design canvas's Connections board draws a connected app. The row can be tried from there:
// Disconnect asks first and leaves the sheet and what was sent to it where they are, Connect brings it back, and asking Ton for a
// month answers that Ton kept a draft and sent nothing, because Practice is always in its practice days with Google.
//
// The rest of the row's states are reached by choosing where the sample starts (`manut.practice.google`, read once when the page
// starts: `off`, `none`, `working` or `broken`), which the design checks and the Playwright suite do; nothing in the app sets it.
// The rules are the API's (apps/api/src/google-connect.ts), said again for Practice. No window ever opens, nothing is sent and
// nothing is kept outside this page. Times are seconds.
import { bangkokMonth, endedMonths, MONTH, type BooksSheet, type GoogleBooks, type SentMonth, type ShopGoogle } from "../google";

export type GoogleResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** Where the sample starts. */
export type PracticeGoogleStart = "off" | "none" | "working" | "broken";

/** The saved choice of where the sample starts: the `working` sample unless this computer chose another. Never throws, and reads
 *  nothing where there is no storage. */
export const PRACTICE_GOOGLE_KEY = "manut.practice.google";

export function readPracticeGoogleStart(store: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): PracticeGoogleStart {
  try {
    const v = store?.getItem(PRACTICE_GOOGLE_KEY);
    return v === "off" || v === "none" || v === "working" || v === "broken" ? v : "working";
  } catch {
    return "working";
  }
}

const HOUR = 3600;
const DAY = 24 * HOUR;
/** The consent page of a real connection is good ten minutes; Practice says the same, though it has no page. */
const CONSENT_SECONDS = 600;
const SAMPLE_TITLE = "Manut AI books: Baan Mali";
const SAMPLE_URL = "https://docs.google.com/spreadsheets/d/practice-sample/edit";

const refused = (code: string, message: string): GoogleResult<never> => ({ ok: false, code, message });

export class PracticeGoogle {
  private state: PracticeGoogleStart;
  private sheet: BooksSheet | null;

  /** The sample as it stands at `now` (seconds): connected to its sheet with the month before this one sent two days ago, and the
   *  month before that sent a month ago with no answer from Google, unless `start` says another state. A sample that starts
   *  unconnected has made no sheet yet, as a shop that has never connected has not. */
  constructor(now: number, start: PracticeGoogleStart = "working") {
    this.state = start;
    const [last, before] = endedMonths(now * 1000, 2) as [string, string];
    const sent: SentMonth[] = [
      { month: last, at: now - 2 * DAY, rows: 41, outcome: "confirmed" },
      { month: before, at: now - 33 * DAY, rows: 38, outcome: "unknown" },
    ];
    this.sheet = start === "working" || start === "broken" ? { title: SAMPLE_TITLE, url: SAMPLE_URL, sent } : null;
  }

  private copy(): BooksSheet | null {
    return this.sheet ? { ...this.sheet, sent: this.sheet.sent.map((one) => ({ ...one })) } : null;
  }

  /** Where Google Sheets stands at `shop`, a copy the caller cannot change the sample through. */
  status(shop: string, now: number): ShopGoogle {
    switch (this.state) {
      case "off":
        return { shop, state: "off" };
      case "none":
        return { shop, state: "none" };
      case "working":
        return { shop, state: "working", connectedAt: now - 9 * DAY, sheet: this.copy() };
      case "broken":
        return { shop, state: "broken", since: now - 3 * HOUR, reason: "invalid_grant", sheet: this.copy() };
    }
  }

  /** Connecting: no window opens, so the connection is made at once. It mends a broken one, as a new sign-in does. */
  connect(now: number): GoogleResult<{ url: null; expiresAt: number }> {
    if (this.state === "off") return refused("google_not_configured", "Google Sheets isn't set up for Manut AI yet.");
    this.state = "working";
    return { ok: true, value: { url: null, expiresAt: now + CONSENT_SECONDS } };
  }

  /** Disconnecting: the sheet and what was sent to it stay, as they stay in the owner's Drive and in the shop's record. */
  disconnect(): GoogleResult<{ revoked: boolean }> {
    if (this.state === "off") return refused("google_not_configured", "Google Sheets isn't set up for Manut AI yet.");
    if (this.state === "none") return refused("not_connected", "Google Sheets is not connected.");
    this.state = "none";
    return { ok: true, value: { revoked: true } };
  }

  /** Asking Ton for a month. A month that has not ended, or a broken or missing connection, fail as the API's worker run says; any
   *  other month ends with Ton's draft, since Practice is always in its practice days and sends nothing. */
  books(month: unknown, nowMs: number): GoogleResult<GoogleBooks> {
    if (this.state === "off") return refused("google_not_configured", "Google Sheets isn't set up for Manut AI yet.");
    if (typeof month !== "string" || !MONTH.test(month)) return refused("invalid_month", "Pick a month that has ended.");
    if (this.state === "none") return { ok: true, value: { outcome: "failed", reason: "not_connected" } };
    if (this.state === "broken") return { ok: true, value: { outcome: "failed", reason: "google_broken" } };
    if (!(month < bangkokMonth(nowMs))) return { ok: true, value: { outcome: "failed", reason: "month_not_over" } };
    return { ok: true, value: { outcome: "drafted" } };
  }
}
