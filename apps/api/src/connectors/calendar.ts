import {
  checkGrant,
  ConnectorError,
  providerGet,
  type FetchImpl,
  type ResourceGrant,
  type SourceRecord,
} from "./types";

export type CalendarEvent = {
  id: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  timeZone: string;
  status: string;
  recurringEventId?: string;
  htmlLink: string;
};

export type CalendarReadArgs = {
  accountId: string;
  /// Calendar ids from the grant. Only these are ever queried.
  calendarIds: string[];
  timeMin: string;
  timeMax: string;
};

const GCAL_READONLY = ["https://www.googleapis.com/auth/calendar.readonly"] as const;

/// Minimal OAuth scopes this connector needs. Event creation arrives only
/// through incremental consent, never this read path.
export const GCAL_SCOPES: readonly string[] = GCAL_READONLY;

function eventShape(payload: unknown): CalendarEvent {
  const root = payload as Record<string, unknown>;
  if (typeof root.id !== "string") throw new Error("shape");
  const start = root.start as Record<string, unknown> | undefined;
  const end = root.end as Record<string, unknown> | undefined;
  const startTime = typeof start?.dateTime === "string" ? start.dateTime : typeof start?.date === "string" ? start.date : "";
  const endTime = typeof end?.dateTime === "string" ? end.dateTime : typeof end?.date === "string" ? end.date : "";
  if (!startTime || !endTime) throw new Error("shape");
  return {
    id: root.id,
    summary: typeof root.summary === "string" ? root.summary : "(no title)",
    description: typeof root.description === "string" ? root.description : "",
    start: startTime,
    end: endTime,
    timeZone: typeof start?.timeZone === "string" ? (start.timeZone as string) : "UTC",
    status: typeof root.status === "string" ? root.status : "confirmed",
    ...(typeof root.recurringEventId === "string" ? { recurringEventId: root.recurringEventId } : {}),
    htmlLink: typeof root.htmlLink === "string" ? root.htmlLink : "",
  };
}

/// Read-only access to explicitly selected calendars over an explicit window.
/// Original timestamps and time zones are preserved; UTC instants stay
/// comparable. Cancelled events and changed recurring instances come back
/// labeled, never silently dropped. No create/update scope is requested.
export async function readCalendar(
  fetchImpl: FetchImpl,
  grant: ResourceGrant,
  token: string,
  args: CalendarReadArgs,
): Promise<{ events: SourceRecord<CalendarEvent>[] }> {
  checkGrant(grant, { accountId: args.accountId, resourceIds: args.calendarIds });
  if (!args.timeMin || !args.timeMax || args.timeMin >= args.timeMax) {
    throw new ConnectorError("forbidden", "bounds");
  }
  const retrievedAt = new Date().toISOString();
  const events: SourceRecord<CalendarEvent>[] = [];
  for (const calendarId of args.calendarIds) {
    const params = new URLSearchParams({
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });
    const page = await providerGet(
      fetchImpl,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      token,
      (payload) => {
        const root = payload as { items?: unknown };
        if (root.items !== undefined && !Array.isArray(root.items)) throw new Error("shape");
        return (root.items ?? []).map((item) => eventShape(item));
      },
    );
    for (const record of page) {
      events.push({
        record,
        source: { provider: "gcal", accountId: args.accountId, retrievedAt },
        deepLink: record.htmlLink || undefined,
      });
    }
  }
  return { events };
}
