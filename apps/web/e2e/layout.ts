import type { Page } from "@playwright/test";

// What the specs measure on a page, and how they make its text bigger. Both run inside the page, because only the
// browser knows where its engine put each box. Everything is in CSS pixels, so a 3x phone and a 2x phone read the same.

/// The text sizes tried, as a multiple of the page's own: its normal size, then what a phone set to a larger text size
/// shows. 1.25 and 1.5 are the steps the brief asked for; a phone's largest setting is bigger still, so a page that
/// holds at 1.5 has room to spare at the settings people actually use.
export const TEXT_SCALES = [1, 1.25, 1.5] as const;

export function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/// Makes every piece of text on the page `factor` times its normal size, the way a phone's text-size setting does,
/// and stops if that did not happen.
///
/// Why not set the root font size to 125% or 150%? The page sizes its text in px, and its stylesheet pins the root to
/// 14px: with the root at 150% the root grows to 24px and every heading, button and paragraph stays exactly as big,
/// so a spec that did that would pass whatever the layout did. A phone's own setting scales px text too (Safari's
/// text size, Chrome's text scaling on Android), so this does the same: it multiplies each font size the page declares,
/// in its stylesheets and in its inline styles, by one CSS variable. Boxes keep the sizes they were given, so a fixed
/// height or width that cannot take bigger text shows up, as it would on the phone. A size in em or % follows its
/// parent, so it scales with it.
///
/// It is safe to call again with another factor: the rewriting happens once per page, and a watcher rewrites text
/// the page adds later (a state change after a tap).
export async function setTextScale(page: Page, factor: number): Promise<void> {
  const seen = await page.evaluate((factor) => {
    const holder = window as unknown as { __textScaleBase?: number };
    const measure = () => parseFloat(getComputedStyle(document.querySelector("main") ?? document.body).fontSize);
    const pixels = /^(\d*\.?\d+)px$/;
    const rewrite = (style: CSSStyleDeclaration) => {
      const match = pixels.exec(style.getPropertyValue("font-size").trim());
      if (match) {
        style.setProperty("font-size", `calc(${match[1]}px * var(--text-scale, 1))`, style.getPropertyPriority("font-size"));
      }
    };
    const rewriteRules = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) rewrite(rule.style);
        else if ("cssRules" in rule) rewriteRules((rule as CSSGroupingRule).cssRules);
      }
    };
    const rewriteInline = (root: Element | Document) => {
      if (root instanceof HTMLElement || root instanceof SVGElement) rewrite(root.style);
      for (const element of Array.from(root.querySelectorAll<HTMLElement | SVGElement>("[style*='font-size']"))) {
        rewrite(element.style);
      }
    };

    if (holder.__textScaleBase === undefined) {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          rewriteRules(sheet.cssRules);
        } catch {
          // A sheet from another origin cannot be read, and the page has none that matters.
        }
      }
      rewriteInline(document);
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "attributes" && record.target instanceof HTMLElement) rewrite(record.target.style);
          for (const added of Array.from(record.addedNodes)) {
            if (!(added instanceof Element)) continue;
            rewriteInline(added);
            if (added instanceof HTMLStyleElement && added.sheet) rewriteRules(added.sheet.cssRules);
          }
        }
      }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
      // The size before any scaling: the variable is not set yet, so the rewritten rules still give the old sizes.
      holder.__textScaleBase = measure();
    }
    document.documentElement.style.setProperty("--text-scale", String(factor));
    return { base: holder.__textScaleBase, now: measure() };
  }, factor);

  if (Math.abs(seen.now - seen.base * factor) > 0.1) {
    throw new Error(
      `Text at ${percent(factor)} should measure ${seen.base * factor}px here and measures ${seen.now}px: the text-size emulation did not take effect, so a pass would mean nothing.`,
    );
  }
}

/// Everything wrong with the page as it stands, in words a person can act on. Empty means the page is fine at this
/// size. `screenWidth` is the phone's screen width, taken from the project and never from the page: when a page is
/// too wide, Chromium widens `window.innerWidth` to match it, so asking the page how wide the screen is would
/// always agree with the page.
///
/// What it looks for, and where it stops:
///  - the page scrolls sideways, and which boxes reach past the screen's edge;
///  - text that sticks out of the box holding it (a label wider than its button, a long word through a card's edge),
///    and text that an ancestor with `overflow` hidden or scroll cuts off;
///  - text drawn on top of other text, a button on top of a button, text under a button;
///  - anything inside a card or a banner that crosses the edge of it;
///  - every button: at least 44 by 44 CSS pixels, able to scroll fully into view, and not covered by anything where a
///    thumb would press it.
/// It skips what is there for a screen reader (`.vh`) and what is drawn for nobody to read (`aria-hidden`: the team
/// faces and icons). It looks at the page's `main`; a state with a button must also be one `states.ts` lists.
export async function findProblems(page: Page, screenWidth: number): Promise<string[]> {
  return page.evaluate((screen) => {
    // CSS pixels of slack: layout rounds to 1/64 px, and a hairline border is not a defect.
    const SLACK = 1;
    const problems: string[] = [];
    const round = (n: number) => Math.round(n * 10) / 10;
    const root = document.querySelector("main") ?? document.body;
    // Every box below is read at the top of the page, so they all share one origin.
    window.scrollTo(0, 0);

    const nameOf = (element: Element): string => {
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      const classes = typeof element.className === "string" && element.className.trim()
        ? `.${element.className.trim().split(/\s+/).join(".")}`
        : "";
      return `<${element.tagName.toLowerCase()}${classes}> "${text.length > 40 ? `${text.slice(0, 40)}...` : text}"`;
    };
    const drawn = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const unread = (element: Element | null): boolean => element?.closest(".vh, [aria-hidden='true']") != null;
    const few = (items: string[]): string =>
      `${items.slice(0, 4).join("; ")}${items.length > 4 ? `; and ${items.length - 4} more` : ""}`;

    // 1. Sideways scroll.
    const doc = document.documentElement;
    if (doc.scrollWidth > screen + SLACK) {
      problems.push(`The page scrolls sideways: it is ${doc.scrollWidth}px wide on a ${screen}px screen.`);
    }
    const past: string[] = [];
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (unread(element) || !drawn(element)) continue;
      const box = element.getBoundingClientRect();
      if (box.right > screen + SLACK) past.push(`${nameOf(element)} ends at ${round(box.right)}px`);
      else if (box.left < -SLACK) past.push(`${nameOf(element)} starts at ${round(box.left)}px`);
    }
    if (past.length > 0) problems.push(`Reaches past the ${screen}px screen: ${few(past)}`);

    // 2. Text: where each word of each text node was drawn, one piece for each line a word is on. Words, not the whole
    // text: a space at the end of a line of `white-space: pre-wrap` text hangs past the box's edge, which nobody sees,
    // and measuring it would call that a defect (it did, in WebKit, by 4.5px).
    type Piece = { left: number; right: number; top: number; bottom: number };
    const texts: { node: Text; parent: Element; pieces: Piece[] }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      const parent = text.parentElement;
      if (!parent || !text.data.trim() || unread(parent) || getComputedStyle(parent).visibility === "hidden") continue;
      const pieces: Piece[] = [];
      for (const word of text.data.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(text, word.index ?? 0);
        range.setEnd(text, (word.index ?? 0) + word[0].length);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width > 0 && rect.height > 0) pieces.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        }
      }
      if (pieces.length > 0) texts.push({ node: text, parent, pieces });
    }

    const sticking: string[] = [];
    const cut: string[] = [];
    for (const { parent, pieces } of texts) {
      const left = Math.min(...pieces.map((piece) => piece.left));
      const right = Math.max(...pieces.map((piece) => piece.right));
      const top = Math.min(...pieces.map((piece) => piece.top));
      const bottom = Math.max(...pieces.map((piece) => piece.bottom));

      // The box that holds the text: the nearest ancestor that is not inline. Only sideways is judged here: a line's
      // glyph box may stand a pixel or two above or below its line box when the font is tall (Thai), and that is not a
      // defect. Cutting off, in any direction, is judged against the ancestors that clip.
      let holder: Element | null = parent;
      while (holder && ["inline", "contents"].includes(getComputedStyle(holder).display)) holder = holder.parentElement;
      if (holder) {
        const box = holder.getBoundingClientRect();
        if (right > box.right + SLACK || left < box.left - SLACK) {
          sticking.push(`${nameOf(parent)} runs from ${round(left)} to ${round(right)}px in a box from ${round(box.left)} to ${round(box.right)}px`);
        }
      }
      for (let up: Element | null = parent; up && up !== document.body && up !== doc; up = up.parentElement) {
        const style = getComputedStyle(up);
        const clipsX = style.overflowX !== "visible";
        const clipsY = style.overflowY !== "visible";
        if (!clipsX && !clipsY) continue;
        const box = up.getBoundingClientRect();
        const inner = {
          left: box.left + up.clientLeft,
          right: box.left + up.clientLeft + up.clientWidth,
          top: box.top + up.clientTop,
          bottom: box.top + up.clientTop + up.clientHeight,
        };
        if ((clipsX && (left < inner.left - SLACK || right > inner.right + SLACK)) ||
          (clipsY && (top < inner.top - SLACK || bottom > inner.bottom + SLACK))) {
          cut.push(`${nameOf(parent)} runs outside ${nameOf(up)}`);
        }
      }
    }
    if (sticking.length > 0) problems.push(`Text sticks out of its box: ${few(sticking)}`);
    if (cut.length > 0) problems.push(`Text is cut off: ${few(cut)}`);

    // 3. Overlap. Two words of different text overlap when they share real area, not a hair's width of leading: more
    // than 2px across, and more than 40% of the shorter word's height.
    const lines = texts.flatMap(({ node, pieces }) => pieces.map((piece) => ({ node, ...piece })));
    const stacked: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i]!;
        const b = lines[j]!;
        if (a.node === b.node) continue;
        const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (across > 2 && down > 0.4 * Math.min(a.bottom - a.top, b.bottom - b.top)) {
          stacked.push(`"${(a.node.data.trim()).slice(0, 24)}" over "${(b.node.data.trim()).slice(0, 24)}"`);
        }
      }
    }
    if (stacked.length > 0) problems.push(`Text overlaps other text: ${few(stacked)}`);

    // 4. A card or a banner is a box with a visible edge: nothing inside it may cross that edge, even when it stays on
    // the screen (a label that cannot wrap, wider than the card it is in, would only show as a card with a button
    // sticking out of its side).
    const crossing: string[] = [];
    for (const frame of Array.from(root.querySelectorAll(".box, .banner"))) {
      const edge = frame.getBoundingClientRect();
      for (const inside of Array.from(frame.querySelectorAll("*"))) {
        if (unread(inside) || !drawn(inside)) continue;
        const box = inside.getBoundingClientRect();
        if (box.right > edge.right + SLACK || box.left < edge.left - SLACK) {
          crossing.push(`${nameOf(inside)} is ${round(box.left)} to ${round(box.right)}px in ${nameOf(frame)}, which is ${round(edge.left)} to ${round(edge.right)}px`);
        }
      }
    }
    if (crossing.length > 0) problems.push(`Crosses the edge of its card: ${few(crossing)}`);

    // 5. Buttons. First what can be judged where everything stands now (all the boxes above were read at one scroll
    // position, so these are too), then, one button at a time, scrolling to it as a thumb would.
    const buttons = Array.from(root.querySelectorAll<HTMLElement>("button, a[href], [role='button']"))
      .filter((element) => drawn(element) && !unread(element));
    buttons.forEach((button, index) => {
      const box = button.getBoundingClientRect();
      if (box.height < 44 - 0.01) problems.push(`${nameOf(button)} is ${round(box.height)}px tall; a button a thumb presses needs 44px`);
      if (box.width < 44 - 0.01) problems.push(`${nameOf(button)} is ${round(box.width)}px wide; a button a thumb presses needs 44px`);
      for (const other of buttons.slice(index + 1)) {
        const o = other.getBoundingClientRect();
        const across = Math.min(box.right, o.right) - Math.max(box.left, o.left);
        const down = Math.min(box.bottom, o.bottom) - Math.max(box.top, o.top);
        if (across > 2 && down > 2) problems.push(`${nameOf(button)} overlaps ${nameOf(other)}`);
      }
      for (const line of lines) {
        if (button.contains(line.node)) continue;
        const across = Math.min(box.right, line.right) - Math.max(box.left, line.left);
        const down = Math.min(box.bottom, line.bottom) - Math.max(box.top, line.top);
        if (across > 2 && down > 0.2 * (line.bottom - line.top)) {
          problems.push(`Text "${line.node.data.trim().slice(0, 24)}" runs under ${nameOf(button)}`);
        }
      }
    });
    for (const button of buttons) {
      button.scrollIntoView({ block: "center", inline: "nearest" });
      const seen = button.getBoundingClientRect();
      if (seen.top < -SLACK || seen.bottom > doc.clientHeight + SLACK) {
        problems.push(`${nameOf(button)} cannot be scrolled fully into view`);
      }
      const hit = document.elementFromPoint(seen.left + seen.width / 2, seen.top + seen.height / 2);
      if (!hit || !(hit === button || button.contains(hit))) {
        problems.push(`${nameOf(button)} is covered by ${hit ? nameOf(hit) : "nothing"} where a thumb would press it`);
      }
    }
    window.scrollTo(0, 0);
    return problems;
  }, screenWidth);
}
