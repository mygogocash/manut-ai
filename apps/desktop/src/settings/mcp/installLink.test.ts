// Installing skills from a link (installLink.ts, item 84): a link is taken only on the artifact origin the API named, so any other
// is refused on the page before the shell is asked to fetch anything (the shell checks again: src-tauri/src/skill_links.rs); and
// each refusal of the shell is said in words, naming a skill that is already there.
import { beforeEach, describe, expect, it } from "vitest";
import { setLang, t } from "../../i18n";
import { installWords, linkOnOrigin } from "./installLink";

const ORIGIN = "https://links.manut-pages.example";
const KEY = `${"S".repeat(43)}.${"k".repeat(32)}`;

beforeEach(() => setLang("en"));

describe("a link to install from", () => {
  it("is taken only on the artifact origin, as a link and nothing more", () => {
    expect(linkOnOrigin(`${ORIGIN}/a/${KEY}`, ORIGIN)).toBe(true);
    expect(linkOnOrigin(`  ${ORIGIN}/a/${KEY}.json `, ORIGIN)).toBe(true);
    expect(linkOnOrigin(`https://LINKS.manut-pages.example/a/${KEY}`, ORIGIN)).toBe(true);
    for (const other of [
      `https://evil.example/a/${KEY}`,
      `https://links.manut-pages.example.evil.example/a/${KEY}`,
      `http://links.manut-pages.example/a/${KEY}`,
      `https://links.manut-pages.example:8443/a/${KEY}`,
      `https://me@links.manut-pages.example/a/${KEY}`,
      `${ORIGIN}/a/${KEY}?x=1`,
      `${ORIGIN}/a/${KEY}#x`,
      `${ORIGIN}/v1/artifacts`,
      `${ORIGIN}/a/../v1/x`,
      "not a link",
    ]) {
      expect(linkOnOrigin(other, ORIGIN), other).toBe(false);
    }
    // with no origin, no link is taken
    expect(linkOnOrigin(`${ORIGIN}/a/${KEY}`, null)).toBe(false);
  });

  it("says each refusal of the shell in words", () => {
    expect(installWords("other_host")).toBe(t("skl.in.otherHost"));
    expect(installWords("not_found")).toBe(t("skl.in.notFound"));
    expect(installWords("exists:promptpay", "codex")).toBe("Codex already has a skill named “promptpay”. Nothing was installed: rename or remove yours first.");
    expect(installWords("bad_bundle:dot_file")).toBe(t("skl.in.badBundle"));
    expect(installWords("bad_bundle:bad_path")).toBe(t("skl.in.badBundle"));
    expect(installWords("link_root")).toContain("nothing is written through a link");
    expect(installWords("something new")).toBe(t("skl.in.unavailable"));
  });

  it("names the file and the setting when the shell refuses a skill that would act by itself", () => {
    expect(installWords("acts_alone:field:promptpay/SKILL.md:allowed-tools"))
      .toBe("Cannot be installed: “promptpay/SKILL.md” sets “allowed-tools”, which a coding agent acts on without asking first.");
    expect(installWords("acts_alone:command:promptpay/references/more.md"))
      .toBe("Cannot be installed: “promptpay/references/more.md” runs a command when the skill loads, without asking first.");
    expect(installWords("acts_alone:unreadable:promptpay/SKILL.md")).toBe(t("skl.in.actsUnreadable", { file: "promptpay/SKILL.md" }));
    // a code this page does not know is never read as installable
    expect(installWords("acts_alone:new_kind:promptpay/SKILL.md")).toBe(t("skl.in.actsUnreadable", { file: "promptpay/SKILL.md" }));
  });
});
