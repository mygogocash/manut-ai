// Kit's folders kept on this computer (KeptLanes.tsx), drawn with react-dom/server from props, and its buttons read from the
// elements it returns (the view uses no hooks). The folders are the canvas's baanmali-preorder's lanes.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import { KeptLanesView, askOf, type KeptLanesProps, type KeptOpen } from "./KeptLanes";
import type { KeptLane } from "./laneBranch";

const HOME = "/Users/fon";
const kept = (over: Partial<KeptLane> = {}): KeptLane => ({
  worktree: `${HOME}/.manut/lanes/baanmali-preorder/promptpay-qr`,
  dir: `${HOME}/.manut/lanes/baanmali-preorder/promptpay-qr`,
  branch: "kit/promptpay-qr",
  base: "main",
  made: 1,
  exists: true,
  changed: 3,
  ahead: 2,
  unpushed: 0,
  ...over,
});
const opened = (over: Partial<KeptOpen> = {}): KeptOpen => ({ worktree: kept().worktree, changed: 3, ahead: 2, branch: false, busy: false, why: null, ...over });

function props(over: Partial<KeptLanesProps> = {}): KeptLanesProps {
  return { rows: [kept()], home: HOME, open: null, notice: null, onShow: vi.fn(), onRemove: vi.fn(), onBranch: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), ...over };
}

function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const byId = (p: KeptLanesProps, id: string) => drawn(KeptLanesView(p)).filter((e) => e.props["data-testid"] === id);
const html = (p: KeptLanesProps) => renderToString(createElement(KeptLanesView, p));
const press = (p: KeptLanesProps, id: string) => (byId(p, id)[0].props.onClick as () => void)();

afterEach(() => setLang("en"));

describe("Kit's folders kept", () => {
  it("draws nothing while no folder is kept", () => {
    expect(KeptLanesView(props({ rows: [] }))).toBeNull();
  });

  it("names each kept folder by its branch, with what is in it and where it is", () => {
    const out = html(props({ rows: [kept(), kept({ worktree: "/x/1", branch: "kit/thai-date", changed: 1 }), kept({ worktree: "/x/2", branch: "kit/a", changed: 0 }), kept({ worktree: "/x/3", branch: "kit/b", changed: null }), kept({ worktree: "/x/4", branch: "kit/c", exists: false })] }));
    expect(out).toContain("Kit&#x27;s folders kept");
    expect(byId(props(), "kept-line")[0].props.children).toBe("3 changed files in it are not on the branch.");
    for (const words of ["1 changed file in it is not on the branch.", "Everything in it is on the branch.", "Could not read what is in it.", "The folder is gone."]) expect(out).toContain(words);
    expect(out).toContain('title="~/.manut/lanes/baanmali-preorder/promptpay-qr"');
  });

  it("shows a folder that is there, and opens Remove's panel for it", () => {
    const p = props();
    press(p, "kept-show");
    expect(p.onShow).toHaveBeenCalledWith(kept());
    press(p, "kept-remove");
    expect(p.onRemove).toHaveBeenCalledWith(kept());
    // a folder that is gone has nothing to show
    expect(byId(props({ rows: [kept({ exists: false })] }), "kept-show")).toHaveLength(0);
  });

  it("says in Remove's panel what goes with the folder, and that the branch stays unless it is ticked", () => {
    const p = props({ open: opened() });
    const out = html(p);
    expect(out).toContain("Remove Kit&#x27;s folder for kit/promptpay-qr?");
    expect(out).toContain("~/.manut/lanes/baanmali-preorder/promptpay-qr");
    expect(byId(p, "kept-lose")[0].props.children).toBe("3 changed files in it go with it.");
    expect(byId(p, "kept-ahead")[0].props.children).toBe("The branch stays, with its commits.");
    expect(byId(p, "kept-branch")[0].props.checked).toBe(false);
    expect(byId(props({ open: opened({ changed: 1 }) }), "kept-lose")[0].props.children).toBe("1 changed file in it goes with it.");
    expect(byId(props({ open: opened({ changed: 0 }) }), "kept-lose")).toHaveLength(0);
  });

  it("says how many commits go with a ticked branch, and when it cannot tell", () => {
    const ahead = (a: number | null) => byId(props({ open: opened({ branch: true, ahead: a }) }), "kept-ahead")[0].props.children;
    expect(ahead(2)).toBe("2 commits on it are not on main. They go with the branch.");
    expect(ahead(1)).toBe("1 commit on it is not on main. It goes with the branch.");
    expect(ahead(0)).toBe("Everything on it is on main.");
    expect(ahead(null)).toBe("Could not tell whether its commits are on main. Any that are not go with the branch.");
  });

  it("ticks the branch, presses Remove, and cancels", () => {
    const p = props({ open: opened() });
    (byId(p, "kept-branch")[0].props.onChange as (e: { currentTarget: { checked: boolean } }) => void)({ currentTarget: { checked: true } });
    expect(p.onBranch).toHaveBeenCalledWith(true);
    press(p, "kept-confirm-remove");
    expect(p.onConfirm).toHaveBeenCalled();
    // the row's Remove closes an open panel
    press(p, "kept-remove");
    expect(p.onCancel).toHaveBeenCalled();
    expect(byId(props({ open: opened({ busy: true }) }), "kept-confirm-remove")[0].props.disabled).toBe(true);
  });

  it("says when what is in it changed since, when it could not be removed, and when the branch stayed", () => {
    expect(html(props({ open: opened({ why: "changed" }) }))).toContain("What is in it changed since. Nothing was removed: look again.");
    expect(html(props({ open: opened({ why: "failed", error: "fatal: cannot remove" }) }))).toContain("Could not remove it: fatal: cannot remove");
    expect(html(props({ rows: [], notice: "The folder is gone. The branch stays: error: cannot delete" }))).toContain("The branch stays");
  });

  it("asks for exactly the numbers the person saw", () => {
    expect(askOf(opened({ branch: true }))).toEqual({ changed: 3, branch: true, ahead: 2 });
    expect(askOf(opened({ changed: 0, ahead: null }))).toEqual({ changed: 0, branch: false, ahead: null });
  });

  it("says its words in Korean, Japanese and Chinese", () => {
    for (const [lang, words] of [
      ["ko", "남겨 둔 Kit의 폴더"],
      ["ja", "残してある Kit のフォルダ"],
      ["zh", "保留的 Kit 文件夹"],
    ] as const) {
      setLang(lang);
      expect(html(props({ open: opened() }))).toContain(words);
    }
  });
});

describe("what a clean-up left, said where the kept folders are listed", () => {
  const text = (p: KeptLanesProps) => byId(p, "kept-clean").map((e) => e.props.children);

  it("says a clean folder is kept for commits on no remote", () => {
    expect(text(props({ rows: [kept({ changed: 0, unpushed: 1 })] }))).toEqual(["1 commit on its branch is on no remote, so a clean-up leaves it."]);
    expect(text(props({ rows: [kept({ changed: 0, unpushed: 4 })] }))).toEqual(["4 commits on its branch are on no remote, so a clean-up leaves it."]);
    // nothing to say of a folder with changes (its own line says it) or one with nothing unpushed
    expect(text(props({ rows: [kept({ changed: 2, unpushed: 4 }), kept({ worktree: "/x/1", branch: "kit/a", changed: 0, unpushed: 0 })] }))).toEqual([]);
  });

  it("gives the reason the clean-up left each folder, by branch", () => {
    const p = props({ rows: [kept(), kept({ worktree: "/x/1", branch: "kit/a", changed: 0 }), kept({ worktree: "/x/2", branch: "kit/b", changed: 0 })], why: { "kit/promptpay-qr": "changes", "kit/a": "not_in_default", "kit/b": "open" } });
    expect(text(p)).toEqual(["It has changes of its own, so the clean-up left it.", "Its pull request merged, but its commits are not in the default branch yet.", "Its pull request has not merged."]);
  });

  it("names the files git ignores that a clean-up left a folder for, and says Remove takes them", () => {
    const files = [".env.local", "data/", "dev.db"];
    expect(text(props({ rows: [kept({ changed: 0, ignored: files })] }))).toEqual(["It holds files git ignores that may be yours (.env.local, data/, dev.db), so a clean-up leaves it. Remove takes them with it."]);
    expect(text(props({ rows: [kept({ changed: 0, ignored: files })], why: { "kit/promptpay-qr": "ignored" } }))[0]).toContain(".env.local, data/, dev.db");
    // the merged clean-up's reason alone, before the list read the folder
    expect(text(props({ rows: [kept({ changed: 0 })], why: { "kit/promptpay-qr": "ignored" } }))).toEqual(["It holds files git ignores that may be yours, so the clean-up left it."]);
    // more than five are cut, and the Remove panel names them as going too
    const many = ["a", "b", "c", "d", "e", "f"].map((x) => `${x}.db`);
    expect(text(props({ rows: [kept({ changed: 0, ignored: many })] }))[0]).toContain("a.db, b.db, c.db, d.db, e.db, …");
    expect(String(byId(props({ rows: [kept({ ignored: files })], open: opened() }), "kept-lose-ignored")[0].props.children)).toBe("Files git ignores in it go with it too: .env.local, data/, dev.db.");
    expect(byId(props({ rows: [kept()], open: opened() }), "kept-lose-ignored")).toHaveLength(0);
  });

  it("says it could not tell, and why, even with no folder to list", () => {
    for (const [code, words] of [["no_remote", "remote is not on GitHub or GitLab"], ["not_installed", "gh or glab is not installed"], ["not_signed_in", "gh or glab is not signed in"]]) {
      const p = props({ rows: [kept()], cannot: code });
      expect(String(byId(p, "kept-cannot")[0].props.children)).toContain(words);
    }
    expect(byId(props({ rows: [], cannot: "not_signed_in" }), "kept-cannot")).toHaveLength(1);
    // the project's own git config names a program: which setting, and that the app runs none of it by itself
    expect(String(byId(props({ rows: [kept()], cannot: "config", setting: "credential.helper" }), "kept-cannot")[0].props.children)).toBe(
      "Did not clean up: this project's own git settings name a program for git to run, or another address to fetch from (credential.helper). The app does not run those by itself.",
    );
    expect(text(props({ rows: [kept({ changed: null })], why: { "kit/promptpay-qr": "config" } }))).toEqual(["This project's own git settings name a program for git to run, so the clean-up did nothing here."]);
  });

  it("is written in every language", () => {
    for (const l of ["ko", "ja", "zh"] as const) {
      setLang(l);
      expect(html(props({ rows: [kept({ changed: 0, unpushed: 2 })], why: { "kit/promptpay-qr": "busy" }, cannot: "no_remote" }))).not.toContain("clean-up");
      expect(html(props({ rows: [kept({ changed: 0, ignored: [".env.local"] })], open: opened() }))).not.toMatch(/clean-up|go with it/);
    }
  });
});

