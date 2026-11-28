// File paths in a terminal's output (engine-paths.ts): which are links, what a click does, and that a path outside the session's
// folder, or one that is not there, is never one. The parser's own tests are Paradev's, ported (link-parsing.test.ts and others).
import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { openFileInEditor, type EditorHost } from "../../code/editor";
import { attachPathLinks, detectPathLinks, insideFolder, pathLinkProvider, type PathDeps, type PathLink } from "./engine-paths";
import { OperatingSystem } from "./link-parsing";

const FOLDER = "/home/you/code/web-app";
const MAC = OperatingSystem.Macintosh;

/** A stand-in for the shell: the files of the folder (from it) answer with their place, anything else with none. */
const shell = (files: string[]) =>
  vi.fn(async (paths: string[]) =>
    paths.map((p) => {
      const rel = (p.startsWith(`${FOLDER}/`) ? p.slice(FOLDER.length + 1) : p).replace(/^\.\//, "");
      return files.includes(rel) ? rel : null;
    }),
  );
/** A shell that says yes to every path: only the page's own check stands between a path and a link. */
const lax = () => vi.fn(async (paths: string[]) => paths.map((p) => p));

const FILES = ["src/app.ts", "src/checkout/cart.ts", "README.md"];
const find = (text: string, check = shell(FILES)) => detectPathLinks(text, FOLDER, check, MAC);
const brief = (l: PathLink) => [l.text, l.file, l.row, l.col];

describe("the links of a line", () => {
  it("path:line:col and path:line, with the line and column, in the text they were written in", async () => {
    expect((await find("error in src/app.ts:12:5 here")).map(brief)).toEqual([["src/app.ts:12:5", "src/app.ts", 12, 5]]);
    expect((await find("src/app.ts:12")).map(brief)).toEqual([["src/app.ts:12", "src/app.ts", 12, undefined]]);
    const [l] = await find("at  src/checkout/cart.ts:42:7!");
    expect([l.startIndex, l.endIndex]).toEqual([4, 4 + "src/checkout/cart.ts:42:7".length]);
  });

  it("a path with no line is a link too, and the other forms of a line are read", async () => {
    expect((await find("open README.md now")).map(brief)).toEqual([]); // no `/`: the parser reads a file name alone as no path
    expect((await find("open ./src/app.ts now")).map(brief)).toEqual([["./src/app.ts", "src/app.ts", undefined, undefined]]);
    expect((await find("src/app.ts(12,5): error TS2322")).map(brief)).toEqual([["src/app.ts(12,5)", "src/app.ts", 12, 5]]);
    expect((await find("src/app.ts#L12")).map(brief)).toEqual([["src/app.ts#L12", "src/app.ts", 12, undefined]]);
    expect((await find('  File "src/app.ts", line 3, in <module>')).map(brief)).toEqual([['"src/app.ts", line 3', "src/app.ts", 3, undefined]]);
  });

  it("an absolute path inside the folder, and a file:// address of one, are links, named from the folder", async () => {
    expect((await find(`${FOLDER}/src/app.ts:7`)).map(brief)).toEqual([[`${FOLDER}/src/app.ts:7`, "src/app.ts", 7, undefined]]);
    expect((await find(`see file://${FOLDER}/src/app.ts please`)).map((l) => l.file)).toEqual(["src/app.ts"]);
  });

  it("punctuation after a path is not part of the link", async () => {
    const [l] = await find("see src/app.ts.");
    expect(l.text).toBe("src/app.ts");
    expect(l.endIndex).toBe("see src/app.ts".length);
  });

  it("a path the shell does not find, or finds a folder or an outside file for, is no link", async () => {
    expect(await find("src/nope.ts:1:1")).toEqual([]);
    expect(await find("src/app.ts:1", shell([]))).toEqual([]);
  });

  it("asks the shell about all the paths of the line at once, and not again for none", async () => {
    const check = shell(FILES);
    const links = await find("src/app.ts:1 and src/checkout/cart.ts:2 and src/nope.ts:3", check);
    expect(links.map((l) => l.file)).toEqual(["src/app.ts", "src/checkout/cart.ts"]);
    expect(check).toHaveBeenCalledTimes(1);
    const none = shell(FILES);
    expect(await find("nothing to see here, 3 of 4 done", none)).toEqual([]);
    expect(none).not.toHaveBeenCalled();
  });

  it("a web address is not read as a path, a long line is not read, and the paths asked about are capped", async () => {
    const check = shell(FILES);
    expect(await find("https://example.com/src/app.ts:3 and http://localhost:5173/src/app.ts", check)).toEqual([]);
    expect(check).not.toHaveBeenCalled();
    expect(await find(`${"x".repeat(2100)} src/app.ts:1`, check)).toEqual([]);
    expect(check).not.toHaveBeenCalled();
    // more than ten links in a line are not all read, and the question is never longer than twenty paths
    const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts:1`).join(" ");
    const big = lax();
    await find(many, big);
    expect(big.mock.calls[0][0].length).toBeLessThanOrEqual(20);
  });
});

describe("a path outside the session's folder is not a link, whatever the shell says", () => {
  const OUT = ["/etc/passwd:1", "../secret.ts:2", "src/../../x.ts:3", "/home/you/code/web-app2/src/app.ts:4", "../web-app2/src/app.ts:5", "/home/you/.ssh/config:6", "file:///etc/hosts"];

  it("makes no link for one and never asks the shell about it", async () => {
    for (const line of OUT) {
      const check = lax();
      expect(await find(`error: ${line} failed`, check), line).toEqual([]);
      expect(check, line).not.toHaveBeenCalled();
    }
  });

  it("still links the files of the folder on the same line", async () => {
    const check = lax();
    const links = await find("/etc/passwd:1 then src/app.ts:2 then ../secret.ts:3", check);
    expect(links.map((l) => l.file)).toEqual(["src/app.ts"]);
    expect(check.mock.calls.flat().flat()).not.toContain("/etc/passwd");
    expect(check.mock.calls.flat().flat()).not.toContain("../secret.ts");
  });
});

describe("insideFolder", () => {
  it("is what reads inside the folder once . and .. are read", () => {
    for (const ok of ["src/a.ts", "./src/a.ts", "src/../src/a.ts", `${FOLDER}/x`, `${FOLDER}/a/../b`, "a", "~/x"]) expect(insideFolder(FOLDER, ok), ok).toBe(true);
    for (const no of ["/etc/passwd", "../x", "src/../../x", `${FOLDER}2/x`, "../web-app2/x", FOLDER, `${FOLDER}/..`, "/", "../../../../etc/passwd"]) expect(insideFolder(FOLDER, no), no).toBe(false);
  });
  it("leaves a ~ path and a folder that is not a POSIX path to the shell, and a folder at the root holds every path", () => {
    expect(insideFolder("C:\\proj", "src\\a.ts")).toBe(true);
    expect(insideFolder("/", "etc/passwd")).toBe(true);
  });
});

/** A real xterm, unopened, with `text` printed in it, and a provider over it. */
async function provider(text: string, o: Partial<PathDeps> = {}, cols = 40) {
  const term = new Terminal({ cols, rows: 6, allowProposedApi: true });
  await new Promise<void>((r) => term.write(text, r));
  const check = shell(FILES);
  const deps: PathDeps = {
    folder: () => FOLDER,
    check: (_f, paths) => check(paths),
    canOpen: async () => true,
    open: vi.fn(async () => undefined),
    mac: () => true,
    ...o,
  };
  const onActivate = vi.fn();
  const p = pathLinkProvider(term, deps, onActivate, vi.fn(), vi.fn());
  const links = (y: number) => new Promise<ILink[] | undefined>((r) => p.provideLinks(y, r));
  return { links, deps, check, onActivate };
}

describe("the links of a terminal's rows", () => {
  it("a link is put on the row it is on, one column to a character", async () => {
    const t = await provider("ok\r\nsee src/app.ts:12:5 now");
    expect(await t.links(1)).toBeUndefined();
    const [l] = (await t.links(2))!;
    expect(l.text).toBe("src/app.ts:12:5");
    expect(l.range).toEqual({ start: { x: 5, y: 2 }, end: { x: 19, y: 2 } });
  });

  it("a path the terminal wrapped is one link over both rows, found from either", async () => {
    const t = await provider("see src/checkout/cart.ts:42:7 now", {}, 20);
    for (const y of [1, 2]) {
      const [l] = (await t.links(y))!;
      expect(l.text, `row ${y}`).toBe("src/checkout/cart.ts:42:7");
      expect([l.range.start.y, l.range.end.y]).toEqual([1, 2]);
    }
  });

  it("with no folder, or no editor installed, a row has no link and the shell is not asked", async () => {
    const none = await provider("src/app.ts:1", { folder: () => null });
    expect(await none.links(1)).toBeUndefined();
    const noEditor = await provider("src/app.ts:1", { canOpen: async () => false });
    expect(await noEditor.links(1)).toBeUndefined();
    expect(none.check).not.toHaveBeenCalled();
    expect(noEditor.check).not.toHaveBeenCalled();
  });

  it("a shell that cannot answer is no link, not an error", async () => {
    const t = await provider("src/app.ts:1", {
      check: async () => {
        throw new Error("shell gone");
      },
    });
    expect(await t.links(1)).toBeUndefined();
  });

  it("moving over a row again within a few seconds asks the shell nothing more", async () => {
    const t = await provider("src/app.ts:1");
    await t.links(1);
    await t.links(1);
    expect(t.check).toHaveBeenCalledTimes(1);
  });

  it("a path outside the folder in a terminal's row makes no link", async () => {
    const t = await provider("see /etc/passwd:1 and ../secret.ts:2", { check: (_f, paths) => lax()(paths) });
    expect(await t.links(1)).toBeUndefined();
  });
});

/** The adapter xterm gets (`attachPathLinks`) over a real xterm, with the provider it registers taken out to ask it. */
async function attached(text: string, o: Partial<PathDeps> = {}) {
  const term = new Terminal({ cols: 60, rows: 6, allowProposedApi: true });
  await new Promise<void>((r) => term.write(text, r));
  let registered: ILinkProvider | undefined;
  vi.spyOn(term, "registerLinkProvider").mockImplementation((p) => ((registered = p), { dispose() {} }));
  const check = shell(FILES);
  const deps: PathDeps = { folder: () => FOLDER, check: (_f, paths) => check(paths), canOpen: async () => true, open: vi.fn(async () => undefined), mac: () => true, ...o };
  const undo = attachPathLinks(term, {} as HTMLElement, deps);
  const links = (y: number) => new Promise<ILink[] | undefined>((r) => registered!.provideLinks(y, r));
  return { links, deps, undo };
}

describe("a click on a link", () => {
  const click = (o: Partial<MouseEvent> = {}) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o }) as MouseEvent;

  it("opens the file at its line and column through item 107's editor call, with the key held, in an editor from the shell's list", async () => {
    const openInEditor = vi.fn(async () => undefined);
    const host: EditorHost = { editors: async () => [{ id: "vscode", label: "Visual Studio Code" }, { id: "zed", label: "Zed" }], openInEditor };
    const t = await attached("see src/checkout/cart.ts:42:7 now", { open: (folder, l) => openFileInEditor(host, folder, { path: l.file, row: l.row, col: l.col }, "auto") });
    const [l] = (await t.links(1))!;
    l.activate(click({ metaKey: true }), l.text);
    await vi.waitFor(() => expect(openInEditor).toHaveBeenCalledTimes(1));
    expect(openInEditor).toHaveBeenCalledWith(FOLDER, "vscode", { path: "src/checkout/cart.ts", row: 42, col: 7 });
    t.undo();
  });

  it("a plain click, the wrong key and a held Shift or Alt open nothing: they only select", async () => {
    const t = await attached("src/app.ts:12");
    const [l] = (await t.links(1))!;
    for (const e of [click(), click({ ctrlKey: true }), click({ metaKey: true, shiftKey: true }), click({ metaKey: true, altKey: true })]) l.activate(e, l.text);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.deps.open).not.toHaveBeenCalled();
    l.activate(click({ metaKey: true }), l.text);
    expect(t.deps.open).toHaveBeenCalledTimes(1);
    expect(t.deps.open).toHaveBeenCalledWith(FOLDER, expect.objectContaining({ file: "src/app.ts", row: 12 }));
    t.undo();
  });

  it("Ctrl is the key off macOS, and a refused open says nothing outside the terminal's own hint", async () => {
    const t = await attached("src/app.ts:12", { mac: () => false, open: vi.fn(async () => Promise.reject(new Error("No editor was found on this computer, so nothing was opened."))) });
    const [l] = (await t.links(1))!;
    l.activate(click({ metaKey: true }), l.text); // Cmd is not the key there
    expect(t.deps.open).not.toHaveBeenCalled();
    l.activate(click({ ctrlKey: true }), l.text);
    expect(t.deps.open).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 20)); // the rejection is taken, not left unhandled
    t.undo();
  });
});
