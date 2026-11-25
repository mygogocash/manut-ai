// A shop's live feed, the desktop's half (docs/runtime-adapter.md, "The live feed"; apps/api's half is
// apps/api/src/feed.ts). While the API says the feed is on, the connected runtime keeps one socket open for each shop it
// shows, and a ping on it makes the host read the shops again soon instead of at its next one-minute read.
//
// The feed carries no data: a ping is `{ "v": 1, "seq": n }` and says only that something changed at that shop. The host
// then reads as it reads each minute, with each shop's own session, so the feed can never show the person anything their
// sessions could not read, and it decides nothing. A socket that closes or fails is never fatal: the minute's read goes on
// whatever the feed does.
//
// Each shop's follower asks the API first (`FeedLink.look`: `POST /v1/feed/ticket` with the shop's session, through the
// shell's request command like every write of the shop's, which opens the session again when it has ended), and opens
// the socket only when the answer says the feed is on, with the one-use ticket that answer carries. Off, it asks again an
// hour later. The page's own WebSocket is the only socket the desktop has (macOS's curl speaks no WebSocket, and the shell
// has no WebSocket crate), and a page's WebSocket can send no `Authorization` header, so the ticket goes as one entry of
// the handshake's protocols, `manut-ticket.<ticket>`, beside `manut-feed.v1`. The shop session never goes there: the API's
// host records that header in its logs as it is, and a session token never goes in a log, an address or a protocol entry.
// A ticket there is spent by the socket it opens and dead 30 seconds after it was minted, so every socket mints its own,
// and one a log keeps opens nothing. The app's CSP lets the page open a socket to Manut AI's own API hosts and nowhere else
// (`feedUrl`), so a runtime connected to any other origin has no feed.

/** The socket's route, the route that mints its ticket, the one protocol the API answers, and the protocol entry that
 *  carries the ticket. */
export const FEED_PATH = "/v1/feed";
export const FEED_TICKET_PATH = "/v1/feed/ticket";
export const FEED_PROTOCOL = "manut-feed.v1";
export const TICKET_PROTOCOL = "manut-ticket.";
/** The first ping waits this long for others before the shops are read, so pings from several shops are one read. */
export const FEED_DEBOUNCE_MS = 1_000;
/** How often the socket says it is still there. The API's runtime answers without waking the shop's object, and a
 *  connection that says nothing for minutes is one that routers on the way may drop without telling either end. */
export const KEEPALIVE_MS = 50_000;
/** A keepalive with no answer in this long means the socket is gone, though neither end was told. */
export const PONG_WAIT_MS = 15_000;
/** After a socket drops or the API cannot be asked: wait this long, doubling each time, up to an hour, so a socket the
 *  network or a proxy keeps refusing costs a look an hour, not one a minute. */
export const FEED_RETRY_MIN_MS = 2_000;
export const FEED_RETRY_MAX_MS = 60 * 60_000;
/** While the API says the feed is off, it is asked again this often: turning it on reaches a running app within an
 *  hour, and its next start at once. */
export const FEED_OFF_MS = 60 * 60_000;
/** A socket that stayed open this long was a good one: its drop starts the backoff over, and its hour ending (4000) opens
 *  the next socket at once. A socket that closes sooner is treated as one that failed, so nothing loops. */
export const FEED_STEADY_MS = 60_000;

/** The API's close codes that change what the follower does (apps/api/src/feed.ts `FEED_CLOSE`): the socket's hour is
 *  over, or the switch is off. Every other close is a drop. */
const CLOSE_RENEW = 4000;
const CLOSE_OFF = 4503;

/** What the desktop needs of a WebSocket. The page's own `WebSocket` is one; the tests' fake is another. */
export interface FeedSocket {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type OpenSocket = (url: string, protocols: string[]) => FeedSocket;

/** What asking the API whether a shop's feed is on came to. */
export type Look =
  /** On: open the socket with this ticket, minted just now with the shop's session. It opens one socket, once. */
  | { kind: "on"; ticket: string }
  /** The API says the feed is off, or is from before the feed: ask again in an hour. */
  | { kind: "off" }
  /** Offline, not answering, or an answer this build cannot read: back off and ask again. */
  | { kind: "retry" }
  /** Signed out, or the person's place in the shop ended: stop following it. */
  | { kind: "stop" };

/** The host's side of the feed (host.ts): asking a shop whether its feed is on, and hearing its pings. */
export interface FeedLink {
  look(shop: string): Promise<Look>;
  ping(shop: string): void;
}

/** The feed's address for the API at `origin`, or null where the app's CSP lets the page open no socket. The packaged
 *  app's `connect-src` names `wss://manut.xyz` and `wss://*.manut.xyz`, at the default port (src-tauri/tauri.conf.json),
 *  so only an https origin on those hosts has a feed; a test keeps the two in step. */
export function feedUrl(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const ours = host === "manut.xyz" || host.endsWith(".manut.xyz");
  // Built from the host alone, so nothing else of the origin, a user name least of all, can reach the address.
  if (url.protocol !== "https:" || !ours || url.port !== "") return null;
  return `wss://${host}${FEED_PATH}`;
}

/** The ticket of a mint's answer (`{ feed: "on", ticket }`), or null for an answer that does not say the feed is on with
 *  one. A ticket is taken only as a string a protocol entry may carry: anything else would make the page's WebSocket throw,
 *  and an answer this build cannot read is tried again, never guessed at. */
export function ticketOf(json: unknown): string | null {
  const answer = json && typeof json === "object" ? (json as { feed?: unknown; ticket?: unknown }) : null;
  const ticket = answer?.ticket;
  return answer?.feed === "on" && typeof ticket === "string" && /^[A-Za-z0-9._-]{1,1024}$/.test(ticket) ? ticket : null;
}

/** Whether a message is a ping, and nothing else is ever taken from one: it carries no data. */
function isPing(data: unknown): boolean {
  if (typeof data !== "string" || data.length > 256) return false;
  try {
    const v = JSON.parse(data) as { v?: unknown; seq?: unknown } | null;
    return !!v && typeof v === "object" && v.v === 1 && typeof v.seq === "number";
  } catch {
    return false;
  }
}

export type FollowerState = "looking" | "opening" | "open" | "waiting" | "off" | "stopped";

interface Options {
  url: string;
  open: OpenSocket;
  link: FeedLink;
  now: () => number;
}

/** One shop's socket: looking, opening, open, waiting to try again, off until the next look, or stopped for good. */
class Follower {
  state: FollowerState = "waiting";
  private attempt = 0;
  private socket: FeedSocket | null = null;
  /** Moves on with every look and every socket, so an answer or an event of an earlier one changes nothing. */
  private turn = 0;
  private openedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private pong: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly shop: string,
    private readonly opts: Options,
  ) {}

  /** Asks the API whether the shop's feed is on, and opens the socket when it is. Only a new follower, a timer and a socket
   *  whose hour ended start one, and `stop` clears the timer and lets the socket go, so a stopped follower never looks. */
  async look(): Promise<void> {
    this.state = "looking";
    const turn = ++this.turn;
    let look: Look;
    try {
      look = await this.opts.link.look(this.shop);
    } catch {
      look = { kind: "retry" };
    }
    // A stop, or a newer look, moved the turn on while this one was asked: its answer changes nothing.
    if (turn !== this.turn) return;
    if (look.kind === "stop") return this.stop();
    if (look.kind === "off") return this.off();
    if (look.kind === "retry") return this.backoff();
    this.openSocket(look.ticket);
  }

  /** Opens the socket with the ticket its own look minted, the only credential a protocol entry ever carries. Its handlers
   *  are taken off it whenever the follower stops listening to it (`release`), so a socket let go says nothing more, and one
   *  the API closed fires nothing after its close. */
  private openSocket(ticket: string): void {
    this.state = "opening";
    let socket: FeedSocket;
    try {
      socket = this.opts.open(this.opts.url, [FEED_PROTOCOL, `${TICKET_PROTOCOL}${ticket}`]);
    } catch {
      // A CSP that refuses the address throws here in some engines, and fails the socket in others: a drop either way.
      return this.backoff();
    }
    this.socket = socket;
    socket.onopen = () => {
      this.state = "open";
      this.openedAt = this.opts.now();
      this.startKeepalive(socket);
    };
    socket.onmessage = (ev) => {
      if (ev.data === "pong") return this.clearPong();
      if (isPing(ev.data)) this.opts.link.ping(this.shop);
    };
    socket.onclose = (ev) => this.dropped(ev.code);
    // A failed socket also closes, and the close says what to do next.
    socket.onerror = () => undefined;
  }

  /** Says ping every `KEEPALIVE_MS` while the socket is open. Every way the socket ends clears it (`dropped`, `stop`). */
  private startKeepalive(socket: FeedSocket): void {
    this.keepalive = setInterval(() => {
      try {
        socket.send("ping");
      } catch {
        return this.gone(socket);
      }
      if (this.pong === null) this.pong = setTimeout(() => this.gone(socket), PONG_WAIT_MS);
    }, KEEPALIVE_MS);
  }

  /** The socket stopped answering: it is let go here, and handled as a drop at once rather than when a close that may
   *  never come arrives. */
  private gone(socket: FeedSocket): void {
    this.release(socket);
    this.dropped(0);
  }

  /** What follows a socket that closed: the next socket at once when its hour ended after a good run, an hour's wait when
   *  the switch is off, and otherwise a wait that doubles with each try. */
  private dropped(code: number): void {
    const steady = this.state === "open" && this.opts.now() - this.openedAt >= FEED_STEADY_MS;
    this.socket = null;
    this.stopKeepalive();
    if (steady) this.attempt = 0;
    if (code === CLOSE_OFF) return this.off();
    if (code === CLOSE_RENEW && steady) {
      void this.look();
      return;
    }
    this.backoff();
  }

  private off(): void {
    this.state = "off";
    this.attempt = 0;
    this.later(FEED_OFF_MS);
  }

  private backoff(): void {
    const delay = Math.min(FEED_RETRY_MAX_MS, FEED_RETRY_MIN_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.state = "waiting";
    this.later(delay);
  }

  private later(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.look();
    }, ms);
  }

  /** Stops following the shop: the socket is closed, every timer is cleared, and nothing of it acts again. */
  stop(): void {
    this.state = "stopped";
    this.turn += 1;
    this.clearTimer();
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    if (socket) this.release(socket);
  }

  /** Closes a socket this follower no longer listens to. */
  private release(socket: FeedSocket): void {
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(1000, "done");
    } catch {
      // A socket that is already closing needs no close of its own.
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private clearPong(): void {
    if (this.pong !== null) clearTimeout(this.pong);
    this.pong = null;
  }

  private stopKeepalive(): void {
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.keepalive = null;
    this.clearPong();
  }
}

/** The connected runtime's feeds: one follower for each shop the latest read shows (host.ts). */
export class ShopFeeds {
  private readonly followers = new Map<string, Follower>();
  private readonly opts: Options;

  constructor(opts: { url: string; open: OpenSocket; link: FeedLink; now?: () => number }) {
    this.opts = { url: opts.url, open: opts.open, link: opts.link, now: opts.now ?? Date.now };
  }

  /** Follows exactly these shops: a shop the read no longer shows is let go, and a new one is looked at now. */
  follow(shops: readonly string[]): void {
    const wanted = new Set(shops);
    for (const [shop, follower] of this.followers) {
      if (wanted.has(shop)) continue;
      follower.stop();
      this.followers.delete(shop);
    }
    for (const shop of wanted) {
      if (this.followers.has(shop)) continue;
      const follower = new Follower(shop, this.opts);
      this.followers.set(shop, follower);
      void follower.look();
    }
  }

  /** Lets these shops go at once: the person's place in them ended. */
  drop(shops: readonly string[]): void {
    for (const shop of shops) {
      this.followers.get(shop)?.stop();
      this.followers.delete(shop);
    }
  }

  /** Lets every shop go: the person signed out, or the runtime stopped. */
  stop(): void {
    for (const follower of this.followers.values()) follower.stop();
    this.followers.clear();
  }

  /** Where each followed shop's feed stands, by shop id. */
  states(): Record<string, FollowerState> {
    return Object.fromEntries([...this.followers].map(([shop, follower]) => [shop, follower.state]));
  }
}
