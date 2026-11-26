// Open a folder in the person's editor (item 107): the saved choice, which editor an open uses, the words a failure is said in,
// and that every call goes to the host it is given and carries only an id from the fixed list and the folder.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { MockHost, type MockCall } from "../sessions/host";
import { editorsOf, editorWhy, EDITOR_IDS, openFolderInEditor, readEditorPref, resolveEditor, setEditorPref, type EditorHost, type EditorInfo } from "./editor";

const VS = { id: "vscode", label: "Visual Studio Code" };
const CUR = { id: "cursor", label: "Cursor" };
const ZED = { id: "zed", label: "Zed" };

function storage() {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}

/** A stand-in for the shell: says which editors are installed, records each open and may refuse. */
function fake(installed: EditorInfo[], refuse?: string) {
  const opened: [string, string][] = [];
  let asked = 0;
  const host: EditorHost = {
    async editors() {
      asked++;
      return installed;
    },
    async openInEditor(cwd, editor) {
      opened.push([cwd, editor]);
      if (refuse) throw new Error(refuse);
    },
  };
  return { host, opened, asked: () => asked };
}

beforeEach(() => {
  storage();
  setLang("en");
});
afterEach(() => setLang("en"));

describe("the saved choice", () => {
  it("is Automatic until an editor of the list is named, and a damaged or unknown value is Automatic", () => {
    expect(readEditorPref()).toBe("auto");
    setEditorPref("zed");
    expect(readEditorPref()).toBe("zed");
    setEditorPref("auto");
    expect(readEditorPref()).toBe("auto");
    // a command or a path is not an editor: nothing is saved for it
    for (const bad of ["/usr/bin/code", "code --wait", "idea", "", "vscode; rm -rf ~"]) {
      setEditorPref(bad);
      expect(readEditorPref(), bad).toBe("auto");
    }
    (globalThis as { localStorage: Storage }).localStorage.setItem("manut.editor", "/bin/sh");
    expect(readEditorPref()).toBe("auto");
    expect([...EDITOR_IDS]).toEqual(["vscode", "cursor", "windsurf", "zed", "xcode"]);
  });
});

describe("which editor opens", () => {
  it("is the one named when it is installed, else the first installed, else none", () => {
    expect(resolveEditor("auto", [VS, CUR])).toBe(VS);
    expect(resolveEditor("cursor", [VS, CUR])).toBe(CUR);
    // the named one was removed since: the first installed
    expect(resolveEditor("zed", [VS, CUR])).toBe(VS);
    expect(resolveEditor("auto", [])).toBeNull();
    expect(resolveEditor("cursor", [])).toBeNull();
  });
});

describe("opening a folder", () => {
  it("sends the folder and the id of the editor chosen, to the host it was given", async () => {
    const a = fake([VS, CUR]);
    const b = fake([ZED]);
    await openFolderInEditor(a.host, "/w/shop", "auto");
    await openFolderInEditor(a.host, "/w/shop", "cursor");
    await openFolderInEditor(b.host, "/w/other");
    expect(a.opened).toEqual([["/w/shop", "vscode"], ["/w/shop", "cursor"]]);
    expect(b.opened).toEqual([["/w/other", "zed"]]);
  });

  it("asks the host which are installed once, and again when asked to", async () => {
    const a = fake([VS]);
    await openFolderInEditor(a.host, "/w", "auto");
    await openFolderInEditor(a.host, "/w", "auto");
    expect(a.asked()).toBe(1);
    await editorsOf(a.host, true);
    expect(a.asked()).toBe(2);
  });

  it("reads the saved choice when none is given", async () => {
    const a = fake([VS, CUR]);
    setEditorPref("cursor");
    await openFolderInEditor(a.host, "/w");
    expect(a.opened).toEqual([["/w", "cursor"]]);
  });

  it("opens nothing, and says so plainly, when no editor is installed or the host cannot open", async () => {
    const none = fake([]);
    await expect(openFolderInEditor(none.host, "/w")).rejects.toThrow("No editor was found on this computer, so nothing was opened.");
    expect(none.opened).toEqual([]);
    const old: EditorHost = { editors: async () => [VS] };
    await expect(openFolderInEditor(old, "/w")).rejects.toThrow("No editor was found");
    expect(await editorsOf({})).toEqual([]);
  });

  it("says why in the app's own words, never the shell's text", async () => {
    const cases: [string, string][] = [
      ["the folder is not there", "The folder is not there any more, so it was not opened."],
      ["not a folder", "That is not a folder, so it was not opened."],
      ["the editor is not installed", "No editor was found on this computer, so nothing was opened."],
      ["the editor did not start: No such file or directory (os error 2) /Users/x/secret", "The editor did not open. Nothing was changed."],
    ];
    for (const [shell, plain] of cases) {
      const a = fake([VS], shell);
      await expect(openFolderInEditor(a.host, "/w"), shell).rejects.toThrow(new RegExp(plain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      expect(editorWhy(shell)).toBe(plain);
    }
    expect(editorWhy(undefined)).toBe("The editor did not open. Nothing was changed.");
  });

  it("is said in every language", () => {
    for (const lang of ["ja", "ko", "zh"] as const) {
      setLang(lang);
      for (const text of ["the folder is not there", "not a folder", "not installed", "boom"]) expect(editorWhy(text), `${lang} ${text}`).not.toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("the mock host", () => {
  it("records the open and lists two editors unless a spec says otherwise, and can refuse in the shell's words", async () => {
    const g: Record<string, unknown> = {};
    const host = new MockHost(g);
    expect((await host.editors()).map((e) => e.id)).toEqual(["vscode", "cursor"]);
    await openFolderInEditor(host, "/w/shop");
    expect((g.__manutSessionCalls as MockCall[]).filter((c) => c.op === "editor")).toEqual([{ op: "editor", cwd: "/w/shop", editor: "vscode" }]);
    g.__manutEditorFails = "the folder is not there";
    await expect(openFolderInEditor(host, "/w/shop")).rejects.toThrow("not there any more");
    g.__manutEditors = [];
    expect(await host.editors()).toEqual([]);
  });
});
