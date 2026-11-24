/**
 * Finds the address a dev server says it serves on, in the lines it printed, for the code editor's preview.
 * Text in, value out: nothing here opens a connection or reads a file.
 */

export interface DevUrl {
  /** The address with the machine's own names shown as `localhost`. */
  url: string;
  port: number;
  /** 1-based number of the line it was found on. */
  line: number;
}

// Colours, cursor moves and window titles that servers print around their addresses. Removed first, so
// `\x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/` reads as one address.
const ESCAPES = new RegExp(
  [
    String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`, // OSC, ended by BEL or ST
    String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, // CSI
    String.raw`\u001b[@-Z\\-_]`, // two-character escapes
  ].join("|"),
  "g",
);

// The part of a word that follows the scheme, up to where an address ends in prose or in a URL.
const ADDRESS = /\bhttps?:\/\/[^\s/?#)"'<>]+/gi;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"]);

/** Reads one `http://host[:port]` word; `null` unless it names this machine on a valid port. */
function readAddress(word: string): { url: string; port: number } | null {
  const secure = word.toLowerCase().startsWith("https");
  let authority = word.slice(secure ? 8 : 7);
  // A trailing full stop, comma or semicolon belongs to the sentence, not the address.
  authority = authority.replace(/[.,;:]+$/, "");
  // `http://localhost:3000@evil.example` is a sign-in name, not this machine.
  if (authority.includes("@")) return null;

  let host: string;
  let portText: string | undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return null;
    host = authority.slice(0, end + 1);
    const rest = authority.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return null;
      portText = rest.slice(1);
    }
  } else {
    const colon = authority.indexOf(":");
    host = colon < 0 ? authority : authority.slice(0, colon);
    if (colon >= 0) portText = authority.slice(colon + 1);
  }

  host = host.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return null;

  let port: number;
  if (portText === undefined) {
    port = secure ? 443 : 80;
  } else {
    if (!/^\d{1,5}$/.test(portText)) return null;
    port = Number(portText);
  }
  if (port < 1 || port > 65535) return null;

  const shown = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::]" ? "localhost" : host;
  const scheme = secure ? "https" : "http";
  const isDefault = (secure && port === 443) || (!secure && port === 80);
  return { url: `${scheme}://${shown}${isDefault && portText === undefined ? "" : `:${port}`}/`, port };
}

/**
 * The first address in the output that is on this machine, or `null`. A network address
 * (`Network: http://192.168.1.5:5173/`) or any other host is never answered; when a line holds several
 * addresses the local one wins.
 */
export function findDevUrl(lines: readonly string[]): DevUrl | null {
  for (let i = 0; i < lines.length; i += 1) {
    const text = (lines[i] ?? "").replace(ESCAPES, "");
    for (const match of text.matchAll(ADDRESS)) {
      const found = readAddress(match[0]);
      if (found) return { url: found.url, port: found.port, line: i + 1 };
    }
  }
  return null;
}
