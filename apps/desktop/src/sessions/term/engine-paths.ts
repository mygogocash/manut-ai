// A file path in a terminal's output opens in the person's editor on Cmd+click (item 148): `path`, `path:line` and
// `path:line:col` (and the other forms agents and compilers print: `path(12,5)`, `File "path", line 3`, `path#L12`), across
// rows the terminal wrapped. The parser and its fallbacks are VS Code's as Paradev ported them (link-parsing.ts,
// link-fallbacks.ts); the detector and the xterm adapter below follow Paradev's `local-link-detector.ts`,
// `link-resolver.ts` and `link-detector-adapter.ts` (MIT, Copyright (c) 2025-2026 Superset Inc., `paradevai/paradev` at
// 2db3bbaf37ffbe24b78c8cdb974bf34632e6fb20), written again around what this app has: the shell checks the files.
//
// Only a file that exists inside the terminal's session folder is a link. The page asks the shell about the paths a line
// holds, and the shell answers for each with the file's place in the folder or none (`session_files_in_folder`, which reads
// the real path: a `..` that climbs out and a link that leads out are outside). A path outside, a folder and a path that is
// not there look the same to the page. The page also never asks about a path that reads as outside the folder, so a stand-in
// shell that said yes to everything would still make no link for it. The click opens through item 107's editor call
// (`openFileInEditor`): the editor is one the shell found on its fixed list, named by id; the file is named relative to the
// folder, which the shell checks again before it starts anything; and the line goes only to the editors whose own
// documentation says how.
//
// What is left of Paradev's: its fallback that tries every styled word and the whole line as a path (a stat for each hovered
// line), its search for a file by name, and its `bareWebUrl` (which needs the `tldts` package) are not here. A path that is not
// written as a path is not a link, and a web address is the web-links add-on's (engine-links.ts).
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { splitLineAnchor, type FileLocation } from "./file-location";
import { detectFallbackLinks, generateTrimmedCandidates } from "./link-fallbacks";
import { detectLinks, getCurrentOS, removeLinkSuffix, type IParsedLink, type OperatingSystem } from "./link-parsing";
import { convertLinkRangeToBuffer, getXtermLineContent } from "./link-buffer";
import { isMacPlatform, linkModifier, linkTip } from "./engine-links";
import { getHost } from "../host";
import { editorsOf, openFileInEditor, readEditorPref, resolveEditor } from "../../code/editor";
import { t } from "../../i18n";

/** A line longer than this, a path longer than this and more links in a line than this are not read. */
const MAX_LINE_LENGTH = 2000;
const MAX_PATH_LENGTH = 1024;
const MAX_LINKS_IN_LINE = 10;
/** The most paths one question to the shell holds (the shell refuses more). */
const MAX_CANDIDATES = 20;
/** How long the shell's answer for a path is kept (Paradev's resolver keeps 10 s), so moving over a line again asks nothing. */
const CACHE_MS = 10_000;

/** A file the shell found inside the folder, and where in the line it was written. */
export interface PathLink {
  /** the text of the link in the line, with its line and column */
  text: string;
  /** where it starts and ends in the line (0-based, the end excluded) */
  startIndex: number;
  endIndex: number;
  /** the file from the folder, as the shell found it */
  file: string;
  row?: number;
  col?: number;
}

/** The shell's answer for paths asked about: for each, its place in the folder, or null. */
export type PathCheck = (paths: string[]) => Promise<(string | null)[]>;

const normalize = (p: string): string => {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return `/${out.join("/")}`;
};

/** Whether `path`, as a terminal printed it, can name something inside `folder` once `.` and `..` are read: the page's own check
 *  before it asks the shell, which then reads the real path (a link that leads out is its to find). A `~` path is left to the
 *  shell, which knows the home, and so is a folder that is not a POSIX path. */
export function insideFolder(folder: string, path: string): boolean {
  if (!folder.startsWith("/") || path.startsWith("~")) return true;
  const root = normalize(folder);
  const full = normalize(path.startsWith("/") ? path : `${folder}/${path}`);
  return full.startsWith(root === "/" ? "/" : `${root}/`);
}

/** The path a `file://` address names, else the text as it is. */
function plainPath(text: string): string {
  if (!text.startsWith("file://")) return text;
  try {
    return decodeURIComponent(new URL(text).pathname);
  } catch {
    return text.replace(/^file:\/\//, "");
  }
}

/** A web address is the web-links add-on's, not a path: the text of a link that is one (`https://example.com/x:3`), and a path the
 *  pattern read from the `//` of one. A `file://` address is a path. */
const isAddress = (path: string): boolean => /^(?!file:\/\/)[a-z][a-z0-9+.-]*:\/\//i.test(path);
const partOfAddress = (text: string, index: number): boolean =>
  (text.startsWith("//", index) && /[a-z][a-z0-9+.-]*:$/i.test(text.slice(0, index))) || // from the `//` of `https://`
  (text[index - 1] === ":" && /^\d{1,5}\//.test(text.slice(index))); // from the port of `localhost:5173/x`

/** The parser reads a word and a number (`here, 3`, `Compiled 3 files`) as a path and its line, as VS Code's does, and checks the
 *  disk for each. Here a path is written with a `/`, or ends in an extension: nothing else is asked about, so a line of plain words
 *  never reaches the shell. */
const looksLikePath = (path: string): boolean => path.includes("/") || /\.[A-Za-z0-9]{1,12}$/.test(path);

interface Plan {
  start: number;
  end: number;
  /** what the link's own end loses when a trimmed spelling is the one found */
  options: { path: string; trim: number }[];
  row?: number;
  col?: number;
}

function planOf(link: IParsedLink, text: string): Plan | null {
  if (link.path.text.length > MAX_PATH_LENGTH || isAddress(link.path.text) || partOfAddress(text, link.path.index)) return null;
  const anchor: FileLocation | null = link.suffix ? null : splitLineAnchor(link.path.text);
  const clean = plainPath(removeLinkSuffix(anchor?.path ?? link.path.text));
  if (!clean) return null;
  const options = [{ path: clean, trim: 0 }, ...generateTrimmedCandidates(clean).map((c) => ({ path: c.path, trim: c.trimAmount }))].filter((o) => looksLikePath(o.path));
  if (options.length === 0) return null;
  return {
    start: link.prefix?.index ?? link.path.index,
    end: link.suffix ? link.suffix.suffix.index + link.suffix.suffix.text.length : link.path.index + link.path.text.length,
    options,
    row: link.suffix?.row ?? anchor?.row,
    col: link.suffix?.col ?? anchor?.col,
  };
}

/** The file links of one line of text: the paths it holds, the ones the shell finds inside `folder` (asked about together), with
 *  the line and column written after each. `os` is the parser's way of reading paths. */
export async function detectPathLinks(text: string, folder: string, check: PathCheck, os: OperatingSystem = getCurrentOS()): Promise<PathLink[]> {
  if (!text || text.length > MAX_LINE_LENGTH) return [];
  const plans = detectLinks(text, os)
    .map((l) => planOf(l, text))
    .filter((p): p is Plan => !!p)
    .slice(0, MAX_LINKS_IN_LINE);
  // a line the parser found no path in may still be a compiler's or an interpreter's error line (`File "x", line 3`)
  const fallback = plans.length === 0 ? detectFallbackLinks(text) : [];
  const asked = new Set<string>();
  const want = (path: string) => {
    if (insideFolder(folder, path) && asked.size < MAX_CANDIDATES) asked.add(path);
  };
  for (const p of plans) for (const o of p.options) want(o.path);
  for (const f of fallback) if (f.link.length <= MAX_PATH_LENGTH && looksLikePath(plainPath(f.path))) want(plainPath(f.path));
  if (asked.size === 0) return [];
  const list = [...asked];
  const answers = await check(list);
  const found = new Map(list.map((p, i) => [p, answers[i] ?? null]));
  const links: PathLink[] = [];
  for (const p of plans) {
    const hit = p.options.find((o) => found.get(o.path));
    if (!hit) continue;
    const end = p.end - hit.trim;
    links.push({ text: text.slice(p.start, end), startIndex: p.start, endIndex: end, file: found.get(hit.path)!, row: p.row, col: p.col });
  }
  if (links.length === 0) {
    for (const f of fallback) {
      const file = found.get(plainPath(f.path));
      if (file) links.push({ text: f.link, startIndex: f.index, endIndex: f.index + f.link.length, file, row: f.line, col: f.col });
    }
  }
  return links;
}

/** What the engine needs to make links for a terminal: where it works, the shell's check, and what a click does. Tests give their own. */
export interface PathDeps {
  /** the terminal's session folder now, or null (a terminal with no folder of its own has no file links) */
  folder: () => string | null;
  check: (folder: string, paths: string[]) => Promise<(string | null)[]>;
  /** an editor is installed to open a file in */
  canOpen: () => Promise<boolean>;
  open: (folder: string, link: PathLink) => Promise<void>;
  mac: () => boolean;
}

const folders = new WeakMap<object, () => string | null>();
/** Tell the engine which folder the terminal in `el` works in (read when the pointer is over a line, so it follows a change). The
 *  element outlives a parked terminal made again. */
export function setTermFolder(el: HTMLElement, folder: () => string | null): void {
  folders.set(el, folder);
}

const appDeps = (el: HTMLElement): PathDeps => ({
  folder: () => folders.get(el)?.() ?? null,
  check: async (folder, paths) => {
    const host = getHost();
    return host.filesInFolder ? host.filesInFolder(folder, paths) : paths.map(() => null);
  },
  canOpen: async () => !!resolveEditor(readEditorPref(), await editorsOf(getHost())),
  open: (folder, l) => openFileInEditor(getHost(), folder, { path: l.file, row: l.row, col: l.col }),
  mac: isMacPlatform,
});

/** How many characters of rows around the one under the pointer are read to find a path the terminal wrapped. */
const MAX_CONTEXT = 500;

/** The provider xterm asks for the links of the row under the pointer (Paradev's adapter): the wrapped rows around it make one
 *  line of text, which is read as above, and each link is put back on the rows it covers (wide characters counted). */
export function pathLinkProvider(term: Terminal, deps: PathDeps, onActivate: (e: MouseEvent, link: PathLink) => void, onHover: (e: MouseEvent) => void, onLeave: () => void): ILinkProvider {
  const cache = new Map<string, { at: number; value: string | null }>();
  const check = async (folder: string, paths: string[]): Promise<(string | null)[]> => {
    const now = Date.now();
    const fresh = (p: string) => {
      const c = cache.get(`${folder}\0${p}`);
      return c && now - c.at < CACHE_MS ? c : undefined;
    };
    const missing = paths.filter((p) => !fresh(p));
    if (missing.length) {
      const got = await deps.check(folder, missing).catch(() => missing.map(() => null));
      missing.forEach((p, i) => cache.set(`${folder}\0${p}`, { at: now, value: got[i] ?? null }));
    }
    return paths.map((p) => cache.get(`${folder}\0${p}`)?.value ?? null);
  };
  const active = new Map<number, Promise<ILink[]>>();
  const read = async (y: number): Promise<ILink[]> => {
    const folder = deps.folder();
    if (!folder || !(await deps.canOpen())) return [];
    const buffer = term.buffer.active;
    const cols = term.cols;
    let startLine = y - 1;
    let endLine = startLine;
    const current = buffer.getLine(startLine);
    if (!current) return [];
    const lines = [current];
    const around = Math.ceil(Math.max(MAX_CONTEXT, cols) / cols);
    const minStart = Math.max(startLine - around, 0);
    const maxEnd = Math.min(endLine + around, buffer.length);
    while (startLine >= minStart && buffer.getLine(startLine)?.isWrapped) {
      const before = buffer.getLine(startLine - 1);
      if (!before) break;
      lines.unshift(before);
      startLine--;
    }
    while (endLine < maxEnd && buffer.getLine(endLine + 1)?.isWrapped) {
      const next = buffer.getLine(endLine + 1);
      if (!next) break;
      lines.push(next);
      endLine++;
    }
    const text = getXtermLineContent(buffer, startLine, endLine, cols);
    const found = await detectPathLinks(text, folder, (paths) => check(folder, paths));
    const out: ILink[] = [];
    for (const l of found) {
      const range = convertLinkRangeToBuffer(lines, cols, { startColumn: l.startIndex + 1, startLineNumber: 1, endColumn: l.endIndex + 1, endLineNumber: 1 }, startLine);
      // only the links that cover the row asked about
      if (range.end.y < y || range.start.y > y) continue;
      out.push({ range, text: l.text, activate: (e) => onActivate(e, l), hover: (e) => onHover(e), leave: () => onLeave() });
    }
    return out;
  };
  return {
    provideLinks(y, callback) {
      // xterm asks again for the same row as the pointer moves along it: one answer is shared while it is awaited
      let request = active.get(y);
      if (!request) {
        request = read(y);
        active.set(y, request);
      }
      request.then(
        (links) => {
          active.delete(y);
          callback(links.length ? links : undefined);
        },
        () => {
          active.delete(y);
          callback(undefined);
        },
      );
    },
  };
}

/** File links for one terminal (called once it is open, again for one made again after parking); returns what undoes it. A
 *  click with the link key held (Cmd on macOS, Ctrl elsewhere) opens the file; any other click only selects, as for an address. */
export function attachPathLinks(term: Terminal, el: HTMLElement, deps: PathDeps = appDeps(el)): () => void {
  const tip = linkTip(term);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const activate = (e: MouseEvent, link: PathLink) => {
    if (!linkModifier(e, deps.mac())) return;
    const folder = deps.folder();
    if (!folder) return;
    deps.open(folder, link).catch((err: unknown) => {
      // the words are the app's own (code/editor.ts `editorWhy`), said beside the link for a moment
      tip.show(e, err instanceof Error && err.message ? err.message : t("editor.fail.other"));
      if (timer) clearTimeout(timer);
      timer = setTimeout(tip.hide, 4000);
    });
  };
  const reg = term.registerLinkProvider(pathLinkProvider(term, deps, activate, (e) => tip.show(e), tip.hide));
  return () => {
    if (timer) clearTimeout(timer);
    tip.hide();
    try {
      reg.dispose();
    } catch {
      /* already gone with the terminal */
    }
  };
}
