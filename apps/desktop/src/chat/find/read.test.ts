// Find in a chat (item 150): what it reads of the page. The walk is given small trees of plain objects, as the page's own
// DOM would give it, and a `look` that says how the browser draws an element.
import { describe, expect, it } from "vitest";
import { MASK, maskSecrets } from "../../lib/secrets";
import { readBlocks, sameBlocks, type ElLike, type Look, type TextLike } from "./read";
import { findAll } from "./text";

type Kid = TextLike | ElLike | string;
const text = (data: string): TextLike => ({ nodeType: 3, data });
const el = (tag: string, attrs: Record<string, string> = {}, ...kids: Kid[]): ElLike => ({
  nodeType: 1,
  tagName: tag.toUpperCase(),
  childNodes: kids.map((k) => (typeof k === "string" ? text(k) : k)),
  hasAttribute: (n) => n in attrs,
  getAttribute: (n) => attrs[n] ?? null,
});
const row = (id: string, kind: string, ...kids: Kid[]) => el("div", { "data-row": id, "data-kind": kind, class: `row row-${kind}` }, ...kids);
const runs = (root: ElLike, env?: Parameters<typeof readBlocks>[1]) => readBlocks(root, env).map((b) => [b.key, b.text, b.fold]);

/** A chat as the timeline draws it: the question, a turn's folded steps (drawn hidden while a bar is open) and the answer. */
function chat(steps: Kid[] = []) {
  return el(
    "div",
    { class: "thread" },
    el("div", { class: "tl-anchor", "data-find-skip": "" }, el("button", {}, "Jump to bottom")),
    row("u1", "user", el("div", { class: "msg u" }, el("div", { class: "b" }, "Why is the total wrong?"))),
    row(
      "t1",
      "activity",
      el(
        "div",
        { class: "act" },
        el("button", { class: "act-h" }, el("span", {}, "Worked for 3s · 2 steps")),
        el("div", { class: "act-det", hidden: "", "data-find-folded": "", "data-fold": "kami\u0001t1" }, ...steps),
      ),
    ),
    row("a1", "assistant", el("div", { class: "msg a" }, el("div", { class: "b md" }, el("p", {}, "It adds the ", el("strong", {}, "shipping"), " twice."), el("p", {}, "Fixed in checkout.tsx.")))),
  );
}
const step = (verb: string, detail: string) => el("div", { class: "act-step" }, el("span", { class: "k" }, verb), el("code", { class: "v" }, detail), el("span", { class: "s" }, "0.4s"));

describe("reading a chat", () => {
  it("reads each message and each step in the order the page draws them, a run to a paragraph and to a field of a step", () => {
    const root = chat([step("Ran", "pnpm test checkout"), step("Read", "src/checkout.tsx")]);
    expect(runs(root, { look: undefined })).toEqual([
      ["u1:0", "Why is the total wrong?", null],
      ["t1:0", "Worked for 3s · 2 steps", null],
      // the folded group, read though it is hidden: each step's words and its time are runs of their own only with `look`
      ["t1:1", "Ranpnpm test checkout0.4s", "kami\u0001t1"],
      ["t1:2", "Readsrc/checkout.tsx0.4s", "kami\u0001t1"],
      ["a1:0", "It adds the shipping twice.", null],
      ["a1:1", "Fixed in checkout.tsx.", null],
    ]);
  });

  it("with the browser's own look, a flex item ends a run: Ran, its command and its time are three runs, not one word", () => {
    const flex: Look = { display: "block", visibility: "visible" };
    const inline: Look = { display: "inline", visibility: "visible" };
    const look = (e: ElLike) => (e.getAttribute("class") === "act-step" ? flex : ["k", "v", "s"].includes(e.getAttribute("class") ?? "") ? { ...flex } : inline);
    const root = chat([step("Ran", "pnpm test")]);
    const blocks = readBlocks(root, { look });
    expect(blocks.filter((b) => b.fold).map((b) => b.text)).toEqual(["Ran", "pnpm test", "0.4s"]);
    // so "Ran pnpm" is not a phrase of the page, and a word of the command is
    expect(findAll(blocks, "Ran pnpm").matches).toHaveLength(0);
    expect(findAll(blocks, "pnpm").matches).toHaveLength(1);
  });

  it("keeps inline markup in one run: a match can cross strong, em, code and a link", () => {
    const p = el("p", {}, "see ", el("a", { href: "x" }, "the ", el("em", {}, "docs")), " for ", el("code", {}, "retry()"));
    const root = el("div", {}, row("a1", "assistant", p));
    expect(runs(root)).toEqual([["a1:0", "see the docs for retry()", null]]);
  });

  it("gives a run the same key each time the chat is read, whatever rows come before it", () => {
    const first = readBlocks(chat()).map((b) => b.key);
    const root = chat();
    const rows = Array.from(root.childNodes) as ElLike[];
    const later = el("div", { class: "thread" }, row("u0", "user", "an earlier question"), ...rows);
    const second = readBlocks(later).map((b) => b.key);
    expect(second.slice(1)).toEqual(first);
  });

  it("names a row with no id of its own by the row before it, so a day line keeps its key", () => {
    const root = el("div", {}, row("u1", "user", "hello"), el("div", { class: "day" }, "Today"), row("a1", "assistant", "hi"));
    expect(runs(root)).toEqual([["u1:0", "hello", null], ["u1+1:0", "Today", null], ["a1:0", "hi", null]]);
  });
});

describe("what it does not read", () => {
  it("skips what the page does not show: hidden, aria-hidden, a find skip, scripts, styles, fields and pictures", () => {
    const root = el(
      "div",
      {},
      row(
        "a1",
        "assistant",
        el("p", {}, "shown"),
        el("p", { hidden: "" }, "hidden attribute"),
        el("p", { "aria-hidden": "true" }, "aria hidden"),
        el("div", { "data-find-skip": "" }, "pinned copy"),
        el("script", {}, "var secret = 1"),
        el("style", {}, ".a{}"),
        el("textarea", {}, "a draft the person is typing"),
        el("svg", {}, el("text", {}, "icon")),
        el("p", {}, "also shown"),
      ),
    );
    expect(runs(root)).toEqual([["a1:0", "shown", null], ["a1:1", "also shown", null]]);
  });

  it("skips what the stylesheet hides: display none and visibility hidden, and the same under an element that is not", () => {
    const hide: Record<string, Look> = {
      gone: { display: "none", visibility: "visible" },
      unseen: { display: "block", visibility: "hidden" },
    };
    const look = (e: ElLike) => hide[e.getAttribute("class") ?? ""] ?? { display: "block", visibility: "visible" };
    const root = el("div", {}, row("a1", "assistant", el("p", { class: "ok" }, "ok"), el("p", { class: "gone" }, "gone"), el("div", { class: "gone" }, el("p", {}, "inside gone")), el("p", { class: "unseen" }, "unseen")));
    expect(runs(root, { look }).map((r) => r[1])).toEqual(["ok"]);
  });

  it("does not take a row for hidden because it is rising in (opacity 0 at the first frame of its arrival)", () => {
    const look = (e: ElLike) => ({ display: "block", visibility: "visible", ...(e.getAttribute("class") === "row row-assistant" ? { opacity: "0" } : {}) });
    const root = el("div", {}, row("a1", "assistant", el("p", {}, "just arrived")));
    expect(runs(root, { look }).map((r) => r[1])).toEqual(["just arrived"]);
  });

  it("reads a closed <details> as its summary and nothing else, and an open one whole", () => {
    const closed = el("details", { class: "msg-ctx" }, el("summary", {}, "Context from another chat"), el("pre", {}, "the body"));
    const open = el("details", { open: "" }, el("summary", {}, "More"), el("pre", {}, "the open body"));
    const root = el("div", {}, row("u1", "user", closed, open));
    expect(runs(root).map((r) => r[1])).toEqual(["Context from another chat", "More", "the open body"]);
  });

  it("reads the page, not the store: a key the chat shows masked is masked here, and the key itself is nowhere to be found", () => {
    const KEY = "sk-FAKE0000000000000000TEST";
    const said = `Set PROMPTPAY_KEY=${KEY} in .env`;
    // what the diff view draws of that line (chat/activity/Work.tsx masks at render): the mask, never the key
    const drawn = maskSecrets(said);
    expect(drawn).toContain(MASK);
    // the raw text can sit in the page's attributes and in hidden parts (a title, a copy button's closure); none is read
    const root = el("div", {}, row("t1", "activity", el("div", { "data-find-folded": "", "data-fold": "f", title: said, hidden: "" }, el("div", { class: "dv-l" }, drawn)), el("div", { hidden: "", "data-raw": said }, said), el("button", { title: said })));
    const blocks = readBlocks(root);
    expect(blocks.map((b) => b.text)).toEqual([drawn]);
    expect(findAll(blocks, KEY).matches).toEqual([]);
    expect(findAll(blocks, "PROMPTPAY_KEY=").matches).toHaveLength(1);
    expect(findAll(blocks, MASK).matches).toHaveLength(1);
  });
});

describe("a folded group", () => {
  it("is read though it is hidden, and its runs carry the group's name; nothing else does", () => {
    const blocks = readBlocks(chat([step("Ran", "pnpm test")]));
    expect(blocks.filter((b) => b.fold).map((b) => b.fold)).toEqual(["kami\u0001t1"]);
    expect(blocks.filter((b) => !b.fold).map((b) => b.key)).toEqual(["u1:0", "t1:0", "a1:0", "a1:1"]);
  });

  it("is read as often as the page draws it, shown or hidden: once the group is open it is the same runs in the same nodes", () => {
    const steps = [step("Ran", "pnpm test")];
    const root = chat(steps);
    const before = readBlocks(root);
    // opening the group takes `hidden` off; it is the same elements and the same text nodes
    const act = (root.childNodes[2] as ElLike).childNodes[0] as ElLike;
    const det = act.childNodes[1] as ElLike;
    (det as { hasAttribute: ElLike["hasAttribute"] }).hasAttribute = (n) => n !== "hidden" && (n === "data-find-folded" || false);
    const after = readBlocks(root);
    expect(sameBlocks(before, after)).toBe(true);
  });
});

describe("the same runs", () => {
  it("are the same while their text and nodes are; a changed word, a new run or another node is not", () => {
    const a = readBlocks(chat([step("Ran", "pnpm test")]));
    expect(sameBlocks(a, readBlocks(chat([step("Ran", "pnpm test")])))).toBe(false); // new nodes, though the same words
    expect(sameBlocks(a, a)).toBe(true);
    expect(sameBlocks(a, a.slice(1))).toBe(false);
    const b = a.map((x, i) => (i === 0 ? { ...x, text: x.text + "!" } : x));
    expect(sameBlocks(a, b)).toBe(false);
  });
});
