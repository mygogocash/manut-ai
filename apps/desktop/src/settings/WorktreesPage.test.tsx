// Settings › Worktrees, drawn with react-dom/server: each row with its one-line explanation, the refusals in words, and the
// words in every language.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { WORKTREE_DEFAULTS } from "../lib/worktrees";
import { rootWords, WorktreesView, type WorktreesViewProps } from "./WorktreesPage";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const noop = () => {};

function draw(over: Partial<WorktreesViewProps> = {}) {
  setLang("en");
  return renderToString(
    <WorktreesView saved={WORKTREE_DEFAULTS} prefixText="kit/" rootError={null} onChoose={noop} onReset={noop} onRemote={noop} onPrefixText={noop} onPrefixSave={noop} onDeleted={noop} onMerged={noop} {...over} />,
  );
}

afterEach(() => setLang("en"));

describe("Settings › Worktrees", () => {
  it("draws the five rows with their defaults and a line each", () => {
    const html = draw();
    const text = words(html);
    for (const k of ["set.worktrees", "worktrees.where.title", "worktrees.where.hint", "worktrees.remote.title", "worktrees.remote.hint", "worktrees.prefix.title", "worktrees.prefix.hint", "worktrees.cleanup", "worktrees.deleted.title", "worktrees.deleted.hint", "worktrees.merged.title", "worktrees.merged.hint"] as const) {
      expect(text, k).toContain(t(k));
    }
    expect(text).toContain("Default: ~/.manut/lanes");
    // remote start off, deleted chat on, merged off
    expect(html).toMatch(/data-testid="worktrees-remote"[^>]*aria-checked="false"|aria-checked="false"[^>]*data-testid="worktrees-remote"/);
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="worktrees-deleted"|data-testid="worktrees-deleted"[^>]*aria-checked="true"/);
    expect(html).toMatch(/aria-checked="false"[^>]*data-testid="worktrees-merged"|data-testid="worktrees-merged"[^>]*aria-checked="false"/);
    expect(html).not.toContain("worktrees-reset");
  });

  it("shows the chosen folder with a way back to the default", () => {
    const html = draw({ saved: { ...WORKTREE_DEFAULTS, root: "/Users/fon/lanes" } });
    expect(words(html)).toContain("/Users/fon/lanes");
    expect(html).toContain("worktrees-reset");
  });

  it("says why a folder was refused, in words and never as a code", () => {
    for (const code of ["bad_root", "root_too_broad", "root_in_checkout", "root_unwritable"]) {
      const text = words(draw({ rootError: code }));
      expect(text, code).toContain(rootWords(code));
      expect(text, code).not.toContain(code);
    }
    expect(rootWords("root_in_checkout")).toContain("inside a project's own files");
    // anything else is shown as the shell said it
    expect(rootWords("disk on fire")).toBe("disk on fire");
  });

  it("holds Save until the prefix is changed and fine, and says what is wrong with one that is not", () => {
    expect(draw()).toMatch(/disabled=""[^>]*data-testid="worktrees-prefix-save"|data-testid="worktrees-prefix-save"[^>]*disabled=""/);
    expect(words(draw({ prefixText: "Team" }))).toContain(t("worktrees.prefix.slash"));
    expect(words(draw({ prefixText: "Team/" }))).toContain(t("worktrees.prefix.form"));
    expect(words(draw({ prefixText: "" }))).toContain(t("worktrees.prefix.empty"));
    const ok = draw({ prefixText: "team/ana/" });
    expect(ok).not.toMatch(/disabled=""[^>]*data-testid="worktrees-prefix-save"/);
  });

  it("is written in every language, with the page's name left as the setting's", () => {
    for (const l of LANGS) {
      setLang(l);
      const html = renderToString(<WorktreesView saved={WORKTREE_DEFAULTS} prefixText="kit/" rootError="root_in_checkout" onChoose={vi.fn()} onReset={vi.fn()} onRemote={vi.fn()} onPrefixText={vi.fn()} onPrefixSave={vi.fn()} onDeleted={vi.fn()} onMerged={vi.fn()} />);
      expect(words(html), l).toContain(t("worktrees.root.root_in_checkout"));
      expect(t("set.worktrees")).toBe("Worktrees");
    }
  });
});
