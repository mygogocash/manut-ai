// Settings › MCP and Skills › Install skills from a link (InstallSkills.tsx, item 84), drawn from the state it is given: off until
// Settings › Artifacts allows sharing skills; the bundle read, every file with its size and scripts marked, with the skills and the
// agent to choose; and the ask, which says what a skill is and that nothing runs now, and holds Yes back until every file was
// looked at.
import { beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang, t } from "../../i18n";
import { FileReview } from "../../runtime/fileReview";
import type { LinkRead } from "../../runtime/skillBundle";
import { InstallSkillsView, type InstallSkillsViewProps } from "./InstallSkills";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const BUNDLE: LinkRead = { read: "r1", title: "Shop skills", skills: [
  { name: "promptpay", files: [{ path: "SKILL.md", text: "Make a QR." }, { path: "qr.sh", text: "#!/bin/sh\necho qr\n" }, { path: "scripts/qr", text: "echo qr\n" }] },
  { name: "stock", files: [{ path: "SKILL.md", text: "Count." }] },
  { name: "hooked", files: [{ path: "SKILL.md", text: "---\nname: hooked\nhooks:\n  Stop: []\n---\nAlways.\n" }] },
] };

function draw(over: Partial<InstallSkillsViewProps>): string {
  const noop = () => {};
  return renderToString(
    <InstallSkillsView state={{ step: "link" }} link="" busy={false} error={null} notice={null} review={null} shown={null} onLink={noop} onRead={noop}
      onChoose={noop} onAgent={noop} onInstall={noop} onAnswer={noop} onCancel={noop} onView={noop} onTick={noop} onSettings={noop} {...over} />,
  );
}

beforeEach(() => setLang("en"));

describe("Install skills from a link", () => {
  it("is off until Settings › Artifacts allows sharing skills, with no field to paste a link in", () => {
    const html = draw({ state: { step: "off" } });
    expect(words(html)).toContain(t("skl.in.off"));
    expect(html).toContain('data-testid="skl-install-settings"');
    expect(html).not.toContain('data-testid="skl-install-link"');
  });

  it("shows every file of the chosen skills, SKILL.md marked as instructions and scripts marked, and the agent to install for", () => {
    const html = draw({ state: { step: "read", bundle: BUNDLE, chosen: ["promptpay"], agent: "codex" }, link: "https://links.example/a/x" });
    expect((html.match(/data-testid="skl-file"/g) ?? []).length).toBe(3);
    expect(html).toMatch(/data-path="promptpay\/qr.sh" data-script="1"/);
    // a file in scripts/ is one the agent may ask to run, whatever its name
    expect(html).toMatch(/data-path="promptpay\/scripts\/qr" data-script="1"/);
    expect(html).toMatch(/data-path="promptpay\/SKILL.md" data-script="0" data-instructions="1"/);
    expect(html).toMatch(/data-path="promptpay\/qr.sh" data-script="1" data-instructions="0"/);
    expect(words(html)).toContain(t("skl.instructions"));
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*data-testid="skl-install-agent-codex"/);
    expect(html).toMatch(/type="checkbox"[^>]*data-name="stock"/);
  });

  it("names a skill that would act by itself, by its file and setting, and it cannot be chosen", () => {
    const html = draw({ state: { step: "read", bundle: BUNDLE, chosen: ["promptpay", "hooked"], agent: "claude" } });
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""[^>]*data-name="hooked"/);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked=""[^>]*data-name="hooked"/);
    expect(html).not.toMatch(/type="checkbox"[^>]*disabled=""[^>]*data-name="promptpay"/);
    expect(words(html)).toContain("Cannot be installed: “hooked/SKILL.md” sets “hooks”, which a coding agent acts on without asking first.");
    // its files are not offered for install, and Install takes only the others
    expect(html).not.toContain('data-path="hooked/SKILL.md"');
  });

  it("asks with what a skill is and that nothing runs now, and holds Install back until every file was looked at", () => {
    const ask = { id: "a1", agent: "claude" as const, folder: "~/.claude/skills", skills: [{ name: "stock", files: [{ path: "SKILL.md", bytes: 6 }] }] };
    const review = new FileReview(["stock/SKILL.md"]);
    const yesDisabled = (html: string) => /<button[^>]*disabled=""[^>]*data-testid="skl-install-yes"/.test(html);
    let html = draw({ state: { step: "ask", bundle: BUNDLE, ask }, review });
    const text = words(html);
    expect(text).toContain("Install these skills for Claude Code?");
    expect(text).toContain("Into ~/.claude/skills, each as a new folder. A skill already there is never replaced.");
    expect(text).toContain("A skill tells this agent how to do a task. Read it as you would read instructions from a stranger.");
    expect(text).toContain("Nothing runs now. In a later chat the agent may follow these instructions and ask to run these scripts, and each such step asks you as usual.");
    expect(text).not.toContain("Nothing is run now");
    expect((html.match(/data-testid="skl-file"/g) ?? []).length).toBe(1);
    expect(yesDisabled(html)).toBe(true);
    review.tick(true);
    html = draw({ state: { step: "ask", bundle: BUNDLE, ask }, review });
    expect(yesDisabled(html)).toBe(false);
  });
});
