// Settings › Source control, drawn with react-dom/server: git and the two CLIs in each state the shell can answer, the accounts
// by name only, how to sign in said in the CLI's own words, and the words in every language. The shell's answer is read before
// it is believed (`readTools`).
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { readTools, type SourceTools } from "../code/source";
import { accountNames, SourceControlView } from "./SourceControlPage";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const noop = () => {};

const ALL: SourceTools = readTools({
  git: { installed: true, version: "2.54.0" },
  github: { installed: true, version: "2.104.0", signed_in: true, accounts: [{ name: "ana", host: "ghe.shop.co", active: false }, { name: "octocat", host: "", active: true }] },
  gitlab: { installed: true, version: "1.52.0", signed_in: false, accounts: [] },
});

function draw(tools: SourceTools | null, failed = false) {
  setLang("en");
  return renderToString(<SourceControlView tools={tools} failed={failed} onCheck={noop} />);
}

afterEach(() => setLang("en"));

describe("Settings › Source control", () => {
  it("shows git's version, and each CLI's version and who is signed in, by name only", () => {
    const text = words(draw(ALL));
    for (const k of ["set.source", "src.vcs", "src.providers", "src.git", "src.github", "src.gitlab", "src.never"] as const) expect(text, k).toContain(t(k));
    expect(text).toContain("On this computer, version 2.54.0.");
    // the account in use first, another host named
    expect(text).toContain("gh version 2.104.0, signed in as octocat, ana (ghe.shop.co).");
    // signed out: how to sign in, in the CLI's own words, in a terminal
    expect(text).toContain("glab version 1.52.0 is here but not signed in. Sign in with glab auth login in a terminal.");
    // Automatically pull: off until the person turns it on, with what it does and never does
    const html = draw(ALL);
    expect(html).toMatch(/aria-checked="false"[^>]*data-testid="src-auto-pull"|data-testid="src-auto-pull"[^>]*aria-checked="false"/);
    expect(text).toContain(t("src.pull.hint"));
    expect(t("src.pull.hint")).toMatch(/never a merge, a rebase or a stash, and never in a lane's folder/);
  });

  it("says where to get a missing program and never offers to install or sign in from here", () => {
    const none = readTools({ git: { installed: false }, github: { installed: false }, gitlab: { installed: false } });
    const html = draw(none);
    const text = words(html);
    expect(text).toContain(t("src.git.missing"));
    expect(text).toContain("gh is not on this computer. Install it from cli.github.com, then sign in with gh auth login in a terminal.");
    expect(text).toContain("glab is not on this computer.");
    expect(html).toContain('data-testid="src-git-state" data-ok="false"');
    // the buttons read again or are the page's own switches: none installs or signs in
    expect(html.match(/data-testid="src-[a-z-]+"/g)?.filter((m) => !m.endsWith('-state"'))).toEqual(['data-testid="src-providers"', 'data-testid="src-auto-pull"', 'data-testid="src-check"']);
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it("reads the shell's answer field by field: anything else is not shown", () => {
    const odd = readTools({ git: { installed: true, version: "2.54.0; rm -rf /" }, github: { installed: true, signed_in: "yes", accounts: [{ name: "" }, { name: "x", token: "ghp_SECRET" }, "nope"] }, gitlab: null });
    expect(odd.git.version).toBe("");
    expect(odd.github.signedIn).toBe(false);
    expect(odd.github.accounts).toEqual([{ name: "x", host: "", active: false }]);
    expect(JSON.stringify(odd)).not.toContain("SECRET");
    expect(odd.gitlab).toEqual({ installed: false, version: "", signedIn: false, accounts: [] });
    expect(readTools(null).git.signedIn).toBeNull();
    expect(accountNames(ALL.github)).toBe("octocat, ana (ghe.shop.co)");
  });

  it("says it is reading, and that it cannot read where there is no shell", () => {
    expect(words(draw(null))).toContain(t("src.reading"));
    expect(words(draw(null, true))).toContain(t("src.failed"));
  });

  it("is written in every language, with Git, GitHub and GitLab kept as they are", () => {
    for (const l of LANGS) {
      setLang(l);
      const text = words(renderToString(<SourceControlView tools={ALL} onCheck={noop} />));
      expect(text, l).toContain(t("set.source"));
      for (const name of ["Git", "GitHub", "GitLab", "glab auth login", "octocat"]) expect(text, `${l} ${name}`).toContain(name);
    }
  });
});
