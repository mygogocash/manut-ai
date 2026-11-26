// New project on the Code page (item 100b, part 2): each step drawn, the folder's refusals in words, and Make it on GitHub too only
// through the ask: the shell's plan shown whole, private unless chosen, settled once through approval-core before the shell hears a
// Yes. The folder rules and the plan itself are the shell's, with their tests in src-tauri/src/new_project.rs and review.rs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { askRepo, expandHome, nameFor, NewProjectView, projectWhy, tildeOf, type NewProjectViewProps, type NewStep } from "./NewProject";
import { answerReviewAsk, resetReviewAsks } from "./reviewAsk";
import type { NewProjectMade, RepoAsk } from "./source";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const HOME = "/home/you";
const MADE: NewProjectMade = { folder: "/home/you/code/shop-site", name: "shop-site", existed: false };
const ASK: RepoAsk = { id: "a".repeat(32), kind: "repo", repo: "shop-site", folder: MADE.folder, visibility: "private", remote: "origin", plan: "gh repo create shop-site --private --source /home/you/code/shop-site --remote origin" };

function draw(step: NewStep, over: Partial<NewProjectViewProps> = {}) {
  return renderToString(
    <NewProjectView step={step} home={HOME} onPath={noop} onChoose={noop} onMake={noop} onGithub={noop} onName={noop} onPublic={noop} onAsk={noop} onYes={noop} onNo={noop} onChange={noop} onClose={noop} onOpenUrl={noop} {...over} />,
  );
}

afterEach(() => {
  setLang("en");
  resetReviewAsks();
});

describe("the steps", () => {
  it("the folder: a path from the home folder, Choose, and Make the project", () => {
    const html = draw({ at: "form", path: "~/code/shop-site", busy: false, why: null });
    expect(html).toContain('value="~/code/shop-site"');
    expect(words(html)).toContain(t("proj.choose"));
    expect(words(html)).toContain(t("proj.make"));
    // the home folder itself is not a project
    expect(draw({ at: "form", path: "~/", busy: false, why: null })).toMatch(/<button[^>]*disabled=""[^>]*data-testid="np-make"/);
  });

  it("what was made, with Make it on GitHub too beside it and no ask yet", () => {
    const html = draw({ at: "made", made: MADE });
    expect(words(html)).toContain(t("proj.made", { name: "shop-site" }));
    expect(html).toContain('data-testid="np-github"');
    expect(html).not.toContain('data-testid="np-ask"');
    expect(words(draw({ at: "made", made: { ...MADE, existed: true } }))).toContain(t("proj.madeExisted", { name: "shop-site" }));
  });

  it("GitHub's step is private unless the person picks public, each said plainly", () => {
    const html = draw({ at: "repo", made: MADE, name: "shop-site", isPublic: false, busy: false, why: null });
    expect(html).toMatch(/<input [^>]*data-testid="np-private"[^>]*checked=""/);
    expect(html).not.toMatch(/<input [^>]*data-testid="np-public"[^>]*checked=""/);
    expect(words(html)).toContain(t("proj.private"));
    expect(words(html)).toContain(t("proj.public"));
  });

  it("the ask shows the exact command whole, who can see it, and that nothing is pushed", () => {
    const html = draw({ at: "ask", made: MADE, ask: ASK, busy: false, why: null });
    expect(html).toContain(`<pre class="rv-text" data-testid="np-plan">${ASK.plan}</pre>`);
    expect(words(html)).toContain(t("proj.ask.h", { name: "shop-site" }));
    expect(words(html)).toContain(t("proj.private"));
    expect(words(html)).toContain("~/code/shop-site");
    expect(words(html)).toContain(t("proj.ask.never"));
    for (const id of ["np-yes", "np-no", "np-change"]) expect(html).toContain(`data-testid="${id}"`);
    const pub = draw({ at: "ask", made: MADE, ask: { ...ASK, visibility: "public", plan: ASK.plan.replace("--private", "--public") }, busy: false, why: null });
    expect(words(pub)).toContain(t("proj.public"));
    expect(pub).toContain("--public");
  });

  it("what a Yes did, and a failure in the CLI's own words, masked", () => {
    const made = draw({ at: "done", made: MADE, done: { outcome: "created", pushed: false, url: "https://github.com/you/shop-site", number: 0, step: "", error: "" } });
    expect(words(made)).toContain(t("proj.created", { repo: "you/shop-site" }));
    const failed = draw({ at: "done", made: MADE, done: { outcome: "failed", pushed: false, url: "", number: 0, step: "create", error: "name already exists ghp_abcdefghijklmnopqrstuvwxyz0123456789" } });
    expect(words(failed)).toContain("name already exists");
    expect(failed).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(words(draw({ at: "done", made: MADE, done: { outcome: "failed", pushed: false, url: "", number: 0, step: "check", error: "changed" } }))).toContain(t("proj.check"));
  });
});

describe("the folder's refusals", () => {
  it("each code has words, in every language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      for (const code of ["bad_path", "outside_home", "not_empty", "not_a_folder", "link", "bad_repo_name", "has_origin", "not_a_repository", "not_signed_in", "not_installed"]) {
        expect(projectWhy(code), `${lang} ${code}`).not.toBe(code);
      }
      expect(projectWhy("init_failed:fatal: cannot mkdir")).toContain("fatal: cannot mkdir");
    }
  });
});

describe("Make it on GitHub too is only ever the ask", () => {
  it("the shell's ask is opened in approval-core and a Yes reaches the shell once, by its id alone", async () => {
    const repoAsk = vi.fn(async () => ASK);
    const reviewSettle = vi.fn(async () => ({ outcome: "created" as const, pushed: false, url: "https://github.com/you/shop-site", number: 0, step: "", error: "" }));
    const got = await askRepo({ repoAsk }, MADE.folder, "  shop-site ", false);
    expect(got).toBe(ASK);
    expect(repoAsk).toHaveBeenCalledWith(MADE.folder, "shop-site", false);
    // asking made nothing: only the answer reaches the shell
    expect(reviewSettle).not.toHaveBeenCalled();
    const yes = await answerReviewAsk({ reviewSettle }, ASK.id, true);
    expect(yes).toEqual({ ok: true, done: expect.objectContaining({ outcome: "created" }) });
    expect(reviewSettle.mock.calls).toEqual([[ASK.id, true]]);
    // a second answer is refused by approval-core and the shell hears nothing
    const again = await answerReviewAsk({ reviewSettle }, ASK.id, true);
    expect(again.ok).toBe(false);
    expect(reviewSettle).toHaveBeenCalledTimes(1);
  });

  it("a shell that refuses the ask opens nothing", async () => {
    const reviewSettle = vi.fn();
    await expect(askRepo({ repoAsk: async () => Promise.reject(new Error("not_signed_in")) }, MADE.folder, "x", false)).rejects.toThrow("not_signed_in");
    await expect(askRepo({}, MADE.folder, "x", false)).rejects.toThrow("no_shell");
    expect((await answerReviewAsk({ reviewSettle }, ASK.id, true)).ok).toBe(false);
    expect(reviewSettle).not.toHaveBeenCalled();
  });
});

describe("paths and names", () => {
  it("reads ~ as the home folder and shows the home folder as ~", () => {
    expect(expandHome("~/code/site", HOME)).toBe("/home/you/code/site");
    expect(expandHome(" /srv/x ", HOME)).toBe("/srv/x");
    expect(expandHome("~/x", null)).toBe("~/x");
    expect(tildeOf("/home/you/code/site", HOME)).toBe("~/code/site");
    expect(tildeOf("/home/yours/site", HOME)).toBe("/home/yours/site");
  });

  it("GitHub's name starts as the folder's when GitHub takes it", () => {
    expect(nameFor(MADE)).toBe("shop-site");
    expect(nameFor({ ...MADE, name: "café" })).toBe("");
    expect(nameFor({ ...MADE, name: "my site" })).toBe("");
  });
});
