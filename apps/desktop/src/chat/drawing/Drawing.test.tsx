// Where a drawing is offered, and where never (Markdown.tsx, Bubble.tsx, Drawing.tsx): Show drawing under a finished
// answer's html or svg block in a chat's timeline, the size cap's words instead of the button, the four languages, and
// the guards that keep a drawing out of an ask, an approval card, Needs you, a task, a run and the phone, and keep the app
// deaf to a frame. The card itself reads the drawing with the browser's parser, so it is walked in e2e/chat-drawing.ts.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import { Markdown } from "../parts/Markdown";
import { DRAWING_MAX_BYTES } from "./drawingDoc";

const fence = (lang: string, body: string) => "Here it is:\n\n```" + lang + "\n" + body + "\n```\n";
const CHART = '<svg viewBox="0 0 100 50"><rect width="40" height="30" fill="#4DA3FF"/></svg>';
const html = (md: string, by?: string) => renderToStaticMarkup(<Markdown text={md} drawingsBy={by} />);

describe("which blocks offer a drawing", () => {
  afterEach(() => setLang("en"));

  it("an html or an svg block of an answer in a chat's timeline offers Show drawing under it, and keeps its code and Copy", () => {
    for (const lang of ["html", "svg"]) {
      const out = html(fence(lang, CHART), "Kami");
      expect(out, lang).toContain('data-testid="drawing-show"');
      expect(out).toContain("Show drawing");
      expect(out).toContain('aria-expanded="false"');
      expect(out).toContain('data-testid="copy-code"');
      expect(out).toContain("&lt;svg viewBox");
      // nothing is drawn until the person presses Show
      expect(out).not.toContain("<iframe");
      expect(out).not.toContain('data-testid="drawing-card"');
    }
  });

  it("no other block does, and no block at all where no chat's timeline asked", () => {
    for (const lang of ["js", "xml", "tsx", "", "text"]) expect(html(fence(lang, CHART), "Kami"), lang).not.toContain("drawing-show");
    expect(html(fence("html", CHART))).not.toContain("drawing-show");
    expect(html(fence("html", CHART), "")).not.toContain("drawing-show");
    // inline HTML in prose is text, as before
    expect(html(`a ${CHART} b`, "Kami")).not.toContain("drawing-show");
  });

  it("a block over 256 KiB says it is too large instead of offering Show", () => {
    const big = html(fence("html", "<p>" + "x".repeat(DRAWING_MAX_BYTES) + "</p>"), "Kami");
    expect(big).toContain('data-testid="drawing-too-big"');
    expect(big).toContain("Too large to show as a drawing (over 256 KB).");
    expect(big).not.toContain("drawing-show");
  });

  it("speaks ko, ja and zh", () => {
    for (const [lang, show] of [
      ["ko", "그림 보기"],
      ["ja", "図を表示"],
      ["zh", "显示图"],
    ] as const) {
      setLang(lang);
      expect(html(fence("svg", CHART), "Kami"), lang).toContain(show);
    }
  });
});

const SRC = join(__dirname, "../..");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe("where a drawing never appears", () => {
  it("only a chat's timeline names who drawings are by, and only a finished answer's bubble passes it on", () => {
    const passing = files(SRC)
      .filter((f) => /drawingsBy=/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f))
      .sort();
    // asks and approval cards (chat/cards), Needs you, tasks, runs, the agent-to-agent chat and the phone (apps/web) render
    // markdown without it
    expect(passing).toEqual(["chat/parts/Bubble.tsx", "chat/parts/Timeline.tsx"]);
    const bubble = readFileSync(join(SRC, "chat/parts/Bubble.tsx"), "utf8");
    expect(bubble).toContain("<Markdown text={shown} drawingsBy={streaming ? undefined : drawingsBy} />");
    expect(readFileSync(join(SRC, "chat/parts/Markdown.tsx"), "utf8")).toContain("if (!drawingsBy || !drawableFence(fenceOf(node))) return block;");
  });

  it("the drawing's parts never listen to a frame or send it anything", () => {
    for (const f of ["Drawing.tsx", "live.ts", "sanitize.ts", "drawingDoc.ts"]) {
      const text = readFileSync(join(__dirname, f), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*\*[\s\S]*?\*\//g, "");
      expect(text, f).not.toMatch(/addEventListener\(\s*["']message|onmessage|postMessage|contentWindow|contentDocument|\.eval\(|new Function/);
    }
  });
});
