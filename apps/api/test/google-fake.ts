// A fake Google for the tests: the OAuth token and revoke endpoints and the three Sheets calls Ton's books use, served
// inside the test through the global fetch, at `TEST_GOOGLE_ORIGIN` (wrangler.test.json). It holds what Google would:
// the codes a consent gave out, each bound to its PKCE challenge and redirect address; the refresh and access tokens;
// and the spreadsheets with their rows. It checks what Google checks (the client's id and secret, the verifier against
// the challenge, a code used once, a bearer token on every Sheets call), and keeps every call, so a test reads exactly
// what the Worker sent. Every other address answers 599 and is kept too, so nothing can leave a test unseen.

export const GOOGLE = "https://google.test";
export const CLIENT_ID = "test-google-client.apps.googleusercontent.com";
export const CLIENT_SECRET = "test-google-client-secret-0001";
export const REDIRECT = "https://api.manut.test/v1/google/callback";
export const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

export type GoogleCall = { method: string; url: URL; body: string; authorization: string | null };

type Sheet = { id: string; title: string; tabs: string[]; rows: unknown[][] };

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export class FakeGoogle {
  readonly calls: GoogleCall[] = [];
  /// Addresses the Worker tried that are not this fake's.
  readonly elsewhere: string[] = [];
  readonly sheets = new Map<string, Sheet>();
  readonly refreshTokens = new Map<string, { revoked: boolean }>();
  /// How the next calls answer. `ok` is Google's own answer; a number answers that status; `throw` drops the connection.
  appendAnswer: "ok" | number | "throw" = "ok";
  createAnswer: "ok" | number = "ok";
  revokeAnswer: "ok" | "throw" = "ok";
  /// The scope a consent grants, as Google's token answer lists it.
  grantedScope = DRIVE_FILE;
  private readonly codes = new Map<string, { challenge: string; redirectUri: string; refreshToken: string }>();
  private readonly access = new Map<string, string>();
  private counter = 0;

  /// The owner says yes on Google's consent page for the authorization address the Worker gave: a code bound to that
  /// address's PKCE challenge and redirect. `challenge` stands in for a code bound to another one.
  consent(authorizationUrl: string, challenge?: string): { state: string; code: string } {
    const url = new URL(authorizationUrl);
    const code = `4/fake-code-${++this.counter}-${crypto.randomUUID()}`;
    const refreshToken = `1//fake-refresh-${crypto.randomUUID()}`;
    this.codes.set(code, { challenge: challenge ?? url.searchParams.get("code_challenge") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "", refreshToken });
    return { state: url.searchParams.get("state") ?? "", code };
  }

  /// Every append Google applied, in order.
  appends(): GoogleCall[] {
    return this.calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith(":append"));
  }

  creates(): GoogleCall[] {
    return this.calls.filter((call) => call.method === "POST" && call.url.pathname === "/v4/spreadsheets");
  }

  tokenCalls(grant: "authorization_code" | "refresh_token"): URLSearchParams[] {
    return this.calls.filter((call) => call.url.pathname === "/token").map((call) => new URLSearchParams(call.body))
      .filter((form) => form.get("grant_type") === grant);
  }

  revokes(): GoogleCall[] {
    return this.calls.filter((call) => call.url.pathname === "/revoke");
  }

  /// Every token the fake handed out, for a test to look for in what the Worker kept or answered.
  tokens(): string[] {
    return [...this.refreshTokens.keys(), ...this.access.keys()];
  }

  /// Google forgets a grant, as when the owner removes Manut AI in their Google account.
  revokeAll(): void {
    for (const record of this.refreshTokens.values()) record.revoked = true;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== GOOGLE) {
      this.elsewhere.push(request.url);
      return Response.json({ error: "unexpected_outbound_call" }, { status: 599 });
    }
    // Read as bytes: workerd warns when a form body is read with `text()`.
    const body = new TextDecoder().decode(await request.arrayBuffer());
    const call = { method: request.method, url, body, authorization: request.headers.get("authorization") };
    this.calls.push(call);
    if (url.pathname === "/token" && request.method === "POST") return this.token(new URLSearchParams(body));
    if (url.pathname === "/revoke" && request.method === "POST") {
      if (this.revokeAnswer === "throw") throw new TypeError("fake: Google unreachable");
      const token = new URLSearchParams(body).get("token") ?? "";
      const record = this.refreshTokens.get(token);
      if (!record) return Response.json({ error: "invalid_token" }, { status: 400 });
      record.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (!url.pathname.startsWith("/v4/spreadsheets")) return Response.json({ error: "not_found" }, { status: 404 });
    const bearer = call.authorization?.startsWith("Bearer ") ? call.authorization.slice(7) : "";
    const refresh = this.access.get(bearer);
    if (!refresh || this.refreshTokens.get(refresh)?.revoked !== false) {
      return Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 });
    }
    if (url.pathname === "/v4/spreadsheets" && request.method === "POST") return this.create(body);
    const append = /^\/v4\/spreadsheets\/([^/]+)\/values\/([^/]+):append$/.exec(url.pathname);
    if (append && request.method === "POST") return this.append(append[1]!, decodeURIComponent(append[2]!), url, body);
    const read = /^\/v4\/spreadsheets\/([^/]+)$/.exec(url.pathname);
    if (read && request.method === "GET") {
      const sheet = this.sheets.get(read[1]!);
      if (!sheet) return Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
      return Response.json({ spreadsheetId: sheet.id, properties: { title: sheet.title },
        sheets: sheet.tabs.map((title, index) => ({ properties: { sheetId: index, title } })) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  private issueAccess(refreshToken: string): string {
    const accessToken = `ya29.fake-access-${crypto.randomUUID()}`;
    this.access.set(accessToken, refreshToken);
    return accessToken;
  }

  private async token(form: URLSearchParams): Promise<Response> {
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    const invalidGrant = () => Response.json({ error: "invalid_grant", error_description: "Bad Request" }, { status: 400 });
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      const granted = this.codes.get(code);
      // A code works once, for the redirect it was given to, with the verifier whose challenge it was bound to.
      this.codes.delete(code);
      if (!granted || granted.redirectUri !== form.get("redirect_uri") ||
          (await s256(form.get("code_verifier") ?? "")) !== granted.challenge) {
        return invalidGrant();
      }
      this.refreshTokens.set(granted.refreshToken, { revoked: false });
      return Response.json({ access_token: this.issueAccess(granted.refreshToken), expires_in: 3599,
        refresh_token: granted.refreshToken, scope: this.grantedScope, token_type: "Bearer" });
    }
    if (form.get("grant_type") === "refresh_token") {
      const refreshToken = form.get("refresh_token") ?? "";
      if (this.refreshTokens.get(refreshToken)?.revoked !== false) return invalidGrant();
      return Response.json({ access_token: this.issueAccess(refreshToken), expires_in: 3599, scope: this.grantedScope,
        token_type: "Bearer" });
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  private create(body: string): Response {
    if (this.createAnswer !== "ok") return Response.json({ error: { code: this.createAnswer } }, { status: this.createAnswer });
    const asked = JSON.parse(body) as { properties: { title: string }; sheets: { properties: { title: string } }[] };
    const id = `fakeSheet${++this.counter}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const sheet = { id, title: asked.properties.title, tabs: asked.sheets.map((one) => one.properties.title), rows: [] };
    this.sheets.set(id, sheet);
    return Response.json({ spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
      properties: { title: sheet.title }, sheets: sheet.tabs.map((title, index) => ({ properties: { sheetId: index, title } })) });
  }

  private append(id: string, range: string, url: URL, body: string): Response {
    if (this.appendAnswer === "throw") throw new TypeError("fake: the connection dropped");
    if (this.appendAnswer !== "ok") {
      return Response.json({ error: { code: this.appendAnswer } }, { status: this.appendAnswer });
    }
    const sheet = this.sheets.get(id);
    if (!sheet) return Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
    const tab = range.split("!")[0]!.replace(/^'|'$/g, "").replaceAll("''", "'");
    if (!sheet.tabs.includes(tab) || url.searchParams.get("valueInputOption") !== "RAW") {
      return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, { status: 400 });
    }
    const { values } = JSON.parse(body) as { values: unknown[][] };
    const first = sheet.rows.length + 1;
    sheet.rows.push(...values);
    return Response.json({ spreadsheetId: id, updates: { spreadsheetId: id,
      updatedRange: `${tab}!A${first}:G${sheet.rows.length}`, updatedRows: values.length, updatedColumns: 7,
      updatedCells: values.length * 7 } });
  }
}
