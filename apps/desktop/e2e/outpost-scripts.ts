// The cases for the outpost's scripts, run by outpost-scripts.spec.ts (Chromium) and outpost-scripts-webkit.spec.ts
// (WebKit). The scripts (src-tauri/src/outpost/step.rs: READ, SET, PRESS and SENT, as `step::script` writes them) run
// against small test pages, as WKWebView's callAsyncJavaScript runs them: an async function with its arguments as
// strings, the repo's own script text evaluated in a test browser.
// The Rust tests stand a fake browser in for the page, so this is where the scripts themselves are seen to check the form
// and every field before typing anything, type every value exactly (text, a check box, a radio button, an editor that is
// not a form field, in the page or in an open shadow root), read each back before pressing once and only what may be
// pressed, and read the site's answer. Chromium here and in CI; WebKit, the macOS webview's engine, too on a Mac that has
// it. Every page is served by the spec itself: nothing reaches a real site. (The scripts run in the page's own world
// here, not in the outpost's content world.)
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const SRC = readFileSync(new URL("../src-tauri/src/outpost/step.rs", import.meta.url), "utf8");

/** A script's text as step.rs holds it. */
function raw(name: string): string {
  const found = new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`).exec(SRC);
  if (!found) throw new Error(`step.rs has no ${name}`);
  return found[1];
}
/** A script as it is run: `FIELDS`, `FIND` and `VISIBLE` written in, as `step::script` does. */
const script = (name: string) =>
  raw(name).replace("FIELDS", raw("FIELDS")).replace("FIND", raw("FIND")).replace("VISIBLE", raw("VISIBLE"));
const READ = script("READ");
const SET = script("SET");
const PRESS = script("PRESS");
const SENT = script("SENT");

const ORIGIN = "https://shop.test";
const o = JSON.stringify([ORIGIN]);
const v = (pairs: [string, string][]) => JSON.stringify(pairs);

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const PAGES: Record<string, string> = {
  // A chat: its button comes on once there is text, and sending empties the box, as a chat does.
  "/chat": html(`
    <form id="chat" onsubmit="event.preventDefault(); setTimeout(() => { document.querySelector('textarea').value = ''; }, 150);">
      <textarea name="reply"></textarea>
      <select id="reason"><option value="">-</option><option value="damaged">Damaged</option><option value="late" disabled>Late</option></select>
      <input id="order_ref">
      <input type="password" id="pw">
      <input type="hidden" id="secret" value="x">
      <input type="checkbox" id="agree">
      <button type="submit" id="send" disabled>Send</button>
    </form>
    <script>
      document.querySelector('textarea').addEventListener('input', (e) => { document.querySelector('#send').disabled = e.target.value === ''; });
    </script>`),
  // A chat whose button comes on a moment after the text is in.
  "/slow": html(`
    <form id="chat" onsubmit="event.preventDefault(); document.querySelector('textarea').value = '';">
      <textarea name="reply"></textarea><button type="submit" id="send" disabled>Send</button>
    </form>
    <script>
      document.querySelector('textarea').addEventListener('input', (e) => { setTimeout(() => { document.querySelector('#send').disabled = e.target.value === ''; }, 300); });
    </script>`),
  // A form that clears itself once it has taken what was sent.
  "/clears": html(`
    <form id="order" onsubmit="event.preventDefault(); setTimeout(() => this.reset(), 150);">
      <textarea name="note"></textarea>
      <select id="reason"><option value="">-</option><option value="damaged">Damaged</option></select>
      <button type="submit">Send</button>
    </form>`),
  // A refund the site refuses past 1,000: it keeps the form and marks the field as wrong. One it takes, it removes.
  "/refund": html(`
    <form id="refund" onsubmit="event.preventDefault(); const a = this.querySelector('[name=amount]'); if (Number(a.value) > 1000) { a.setAttribute('aria-invalid', 'true'); } else { this.remove(); }">
      <input name="amount" pattern="[0-9]+\\.[0-9][0-9]" required>
    </form>`),
  // A required field the write does not fill: the browser itself would refuse the form.
  "/required": html(`
    <form id="f" onsubmit="event.preventDefault(); this.remove();">
      <input name="note"><input name="phone" required><button type="submit">Send</button>
    </form>`),
  // A field the site writes again when it is left.
  "/reformat": html(`
    <form id="f" onsubmit="event.preventDefault();">
      <input name="amount" onblur="this.value = Number(this.value).toFixed(2)"><button type="submit">Save</button>
    </form>`),
  // A settings form that posts and moves to another page.
  "/settings": html(`<form id="shop" method="post" action="/save"><input name="hours" required><button type="submit">Save</button></form>`),
  "/saved": html(`<p>Saved</p>`),
  // A shop's hours drawn as a web component, its form in an open shadow root, and a note kept in a closed one.
  "/component": html(`
    <shop-hours></shop-hours>
    <div id="closed-host"></div>
    <script>
      customElements.define("shop-hours", class extends HTMLElement {
        connectedCallback() {
          const root = this.attachShadow({ mode: "open" });
          root.innerHTML = '<form id="hours"><input name="hours"><label><input type="checkbox" name="sunday"> Open on Sunday</label>'
            + '<div class="note" contenteditable="true"></div><button type="submit">Save</button></form>';
          root.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); e.target.remove(); });
        }
      });
      document.getElementById("closed-host").attachShadow({ mode: "closed" }).innerHTML =
        '<form id="secret"><input name="note"><button type="submit">Save</button></form>';
    </script>`),
  // Settings a person ticks and chooses, which the page saves where the test can read them, and one box the page will
  // not let be ticked (it unticks it again at once).
  "/choices": html(`
    <form id="prefs">
      <label><input type="checkbox" name="vacation" id="vacation"> Vacation mode</label>
      <label><input type="checkbox" name="cod" id="cod" checked> Cash on delivery</label>
      <label><input type="radio" name="ship" value="standard" checked> Standard</label>
      <label><input type="radio" name="ship" value="express" id="express"> Express</label>
      <label><input type="radio" name="ship" value="pickup" disabled> Pick up</label>
      <select id="lang"><option value="th">Thai</option><option value="en">English</option></select>
      <input type="checkbox" id="stubborn">
      <button type="submit">Save</button>
    </form>
    <script>
      window.heard = [];
      for (const el of document.querySelectorAll("input, select")) {
        for (const type of ["click", "input", "change"]) el.addEventListener(type, () => heard.push(type + ":" + (el.id || el.value)));
      }
      document.getElementById("stubborn").addEventListener("change", (e) => setTimeout(() => { e.target.checked = false; }, 0));
      document.getElementById("prefs").addEventListener("submit", (e) => {
        e.preventDefault();
        document.body.dataset.saved = JSON.stringify(Object.fromEntries(new FormData(e.target)));
      });
    </script>`),
  // Editors that are not form fields: a chat box that sends on Return, an editor with a line of its own per paragraph,
  // and one the page fills with lines as a rich editor keeps them.
  "/editors": html(`
    <form id="post">
      <div id="box" contenteditable="true" role="textbox"></div>
      <div id="paras" contenteditable="true"><p>old <b>words</b></p></div>
      <div id="drawn" contenteditable="true"></div>
      <button type="submit">Post</button>
    </form>
    <script>
      window.heard = [];
      for (const id of ["box", "paras"]) document.getElementById(id).addEventListener("input", (e) => heard.push(id + ":" + e.inputType));
      const post = document.getElementById("post");
      document.getElementById("box").addEventListener("beforeinput", (e) => {
        if (e.inputType === "insertParagraph") { e.preventDefault(); post.requestSubmit(); }
      });
      post.addEventListener("submit", (e) => {
        e.preventDefault();
        document.body.dataset.sent = document.getElementById("box").innerText;
        document.getElementById("box").textContent = "";
      });
    </script>`),
};

/** Serves the test pages at ORIGIN; a post is answered as a site that saved it answers, with a page that says so. */
async function serve(p: Page): Promise<void> {
  await p.route(`${ORIGIN}/**`, async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: PAGES["/saved"] });
    const body = PAGES[new URL(route.request().url()).pathname];
    return route.fulfill({ status: body ? 200 : 404, contentType: "text/html; charset=utf-8", body: body ?? html("<p>Not here</p>") });
  });
}

/** Runs a script in the page as callAsyncJavaScript does, and reads its answer. */
async function run(p: Page, body: string, args: Record<string, string>): Promise<Record<string, string>> {
  const answer = await p.evaluate(
    async ([body, args]) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (...a: string[]) => Promise<string>;
      return new AsyncFunction(...Object.keys(args), body)(...Object.values(args));
    },
    [body, args] as const,
  );
  return JSON.parse(answer);
}

const value = (p: Page, selector: string) => p.$eval(selector, (el) => (el as HTMLInputElement).value);

/** What the write's scripts read a field as (`read` in FIELDS), run with the same parts the scripts are made of. */
const READ_BACK = `${raw("VISIBLE")}\n${raw("FIND")}\n${raw("FIELDS")}\nreturn JSON.stringify(read(find(s)));`;
const readBack = async (p: Page, s: string) => (await run(p, READ_BACK, { s })) as unknown as string;

/** A property of an element inside the open shadow root of the page's `shop-hours`. */
const inside = (p: Page, selector: string, key: "value" | "checked" | "innerText") =>
  p.evaluate(([s, k]) => (document.querySelector("shop-hours")!.shadowRoot!.querySelector(s) as unknown as Record<string, unknown>)[k],
    [selector, key] as const);

/** Every case, for a spec file to run in its browser. */
export function writeScriptCases(): void {
  test("checks the form and every field before typing anything, and types nowhere else", async ({ page: p }) => {
    await serve(p);
    await p.goto(`${ORIGIN}/chat`);
    const set = (f: string, pairs: [string, string][], origins = o) => run(p, SET, { o: origins, f, v: v(pairs) });
    expect(await set("form#chat", [["textarea[name=reply]", "Hi"], ["#nope", "x"]])).toEqual({ r: "field" });
    // the first field was not typed: nothing is, until every field is found
    expect(await value(p, "textarea")).toBe("");
    expect(await set("form#chat", [["#reason", "lost"]])).toEqual({ r: "field" });
    expect(await set("form#chat", [["#reason", "late"]])).toEqual({ r: "field" });
    // never a password field, a hidden one or a check box; never a selector that is not one
    for (const field of ["#pw", "#secret", "#agree", "textarea["]) expect(await set("form#chat", [[field, "x"]]), field).toEqual({ r: "field" });
    expect(await set("form#gone", [])).toEqual({ r: "form" });
    expect(await set("form#chat", [["textarea[name=reply]", "Hi"]], JSON.stringify(["https://elsewhere.test"]))).toEqual({ r: "origin" });
    expect(await value(p, "textarea")).toBe("");
  });

  test("types every value in order, exactly, presses once, and a chat that empties its box sent it", async ({ page: p }) => {
    await serve(p);
    await p.goto(`${ORIGIN}/chat`);
    const reply = "สวัสดีค่ะ  the parcel ships today\nThank you";
    const all = v([["textarea[name=reply]", reply], ["#reason", "damaged"], ["#order_ref", "RP-118_b"]]);
    expect(await run(p, SET, { o, f: "form#chat", v: all })).toEqual({ r: "set" });
    expect([await value(p, "textarea"), await value(p, "#reason"), await value(p, "#order_ref")]).toEqual([reply, "damaged", "RP-118_b"]);

    await p.goto(`${ORIGIN}/chat`);
    const pairs = v([["textarea[name=reply]", reply]]);
    expect(await run(p, SET, { o, f: "#send", v: pairs })).toEqual({ r: "set" });
    const pressed = await run(p, PRESS, { o, f: "#send", v: pairs });
    expect(pressed).toEqual({ r: "pressed", a: `${ORIGIN}/chat` });
    await expect.poll(async () => (await run(p, SENT, { o, a: pressed.a, f: "#send", v: pairs })).s).toBe("sent");
  });

  test("waits for a button the page turns on, and presses nothing the page or the browser would refuse", async ({ page: p }) => {
    await serve(p);
    await p.goto(`${ORIGIN}/slow`);
    const hi = v([["textarea[name=reply]", "Hi"]]);
    expect(await run(p, SET, { o, f: "#send", v: hi })).toEqual({ r: "set" });
    expect((await run(p, PRESS, { o, f: "#send", v: hi })).r).toBe("wait");
    await expect.poll(async () => (await run(p, PRESS, { o, f: "#send", v: hi })).r).toBe("pressed");

    // a value the field's own pattern refuses
    await p.goto(`${ORIGIN}/refund`);
    const bad = v([["input[name=amount]", "abc"]]);
    expect(await run(p, SET, { o, f: "form#refund", v: bad })).toEqual({ r: "set" });
    expect((await run(p, PRESS, { o, f: "form#refund", v: bad })).r).toBe("flagged");
    // a required field outside the write, whether a button or the form itself is pressed
    await p.goto(`${ORIGIN}/required`);
    const note = v([["input[name=note]", "Call first"]]);
    expect(await run(p, SET, { o, f: "button", v: note })).toEqual({ r: "set" });
    expect((await run(p, PRESS, { o, f: "button", v: note })).r).toBe("flagged");
    expect((await run(p, PRESS, { o, f: "form#f", v: note })).r).toBe("flagged");
    expect(await p.locator("form#f").count()).toBe(1);
    // a page that writes a value again once it is typed: what would go is not what was approved
    await p.goto(`${ORIGIN}/reformat`);
    const amount = v([["input[name=amount]", "500"]]);
    expect(await run(p, SET, { o, f: "button", v: amount })).toEqual({ r: "set" });
    expect((await run(p, PRESS, { o, f: "button", v: amount })).r).toBe("changed");
  });

  test("reads the site's answer: the form kept with an error, the form gone, cleared, or the page moved", async ({ page: p }) => {
    await serve(p);
    await p.goto(`${ORIGIN}/refund`);
    const big = v([["input[name=amount]", "2000.00"]]);
    expect(await run(p, SET, { o, f: "form#refund", v: big })).toEqual({ r: "set" });
    const refused = await run(p, PRESS, { o, f: "form#refund", v: big });
    expect(refused.r).toBe("pressed");
    await expect.poll(async () => (await run(p, SENT, { o, a: refused.a, f: "form#refund", v: big })).s).toBe("refused");

    await p.goto(`${ORIGIN}/refund`);
    const fine = v([["input[name=amount]", "500.00"]]);
    await run(p, SET, { o, f: "form#refund", v: fine });
    const took = await run(p, PRESS, { o, f: "form#refund", v: fine });
    await expect.poll(async () => (await run(p, SENT, { o, a: took.a, f: "form#refund", v: fine })).s).toBe("sent");

    await p.goto(`${ORIGIN}/clears`);
    const order = v([["textarea[name=note]", "Leave at the door"], ["#reason", "damaged"]]);
    await run(p, SET, { o, f: "form#order", v: order });
    const cleared = await run(p, PRESS, { o, f: "form#order", v: order });
    expect((await run(p, SENT, { o, a: cleared.a, f: "form#order", v: order })).s).toBe("pending");
    await expect.poll(async () => (await run(p, SENT, { o, a: cleared.a, f: "form#order", v: order })).s).toBe("sent");

    await p.goto(`${ORIGIN}/settings`);
    const hours = v([["input[name=hours]", "09:00-18:00"]]);
    expect(await run(p, SET, { o, f: "form#shop button", v: hours })).toEqual({ r: "set" });
    expect((await run(p, PRESS, { o, f: "form#shop button", v: hours })).r).toBe("pressed");
    await p.waitForURL(`${ORIGIN}/save`);
    expect((await run(p, SENT, { o, a: `${ORIGIN}/settings`, f: "form#shop button", v: hours })).s).toBe("sent");
    // off the step's origin it is away, whatever else the page shows
    expect((await run(p, SENT, { o: JSON.stringify(["https://elsewhere.test"]), a: `${ORIGIN}/settings`, f: "form", v: hours })).s).toBe("away");
  });

  test("reaches a form and its fields in an open shadow root, and nothing in a closed one", async ({ page: p }) => {
    await serve(p);
    await p.goto(`${ORIGIN}/component`);
    const pairs = v([["input[name=hours]", "09:00-18:00"], ["input[name=sunday]", "checked"], [".note", "Closed on\nholidays"]]);
    expect(await run(p, SET, { o, f: "form#hours", v: pairs })).toEqual({ r: "set" });
    expect(await inside(p, "input[name=hours]", "value")).toBe("09:00-18:00");
    expect(await inside(p, "input[name=sunday]", "checked")).toBe(true);
    expect(await readBack(p, ".note")).toBe("Closed on\nholidays");
    const pressed = await run(p, PRESS, { o, f: "form#hours", v: pairs });
    expect(pressed).toEqual({ r: "pressed", a: `${ORIGIN}/component` });
    await expect.poll(async () => (await run(p, SENT, { o, a: pressed.a, f: "form#hours", v: pairs })).s).toBe("sent");
    // A read's selector reaches into it as well.
    await p.goto(`${ORIGIN}/component`);
    expect((await run(p, READ, { o, s: "label", m: "100" })).t).toContain("Open on Sunday");
    // A closed shadow root cannot be reached from a script: its form and its field are not on the page, and nothing is
    // typed anywhere.
    expect(await run(p, SET, { o, f: "form#secret", v: v([]) })).toEqual({ r: "form" });
    expect(await run(p, SET, { o, f: "form#hours", v: v([["input[name=hours]", "x"], ["input[name=note]", "x"]]) })).toEqual({ r: "field" });
    expect(await inside(p, "input[name=hours]", "value")).toBe("");
    expect((await run(p, READ, { o, s: "input[name=note]", m: "100" }))).toEqual({ e: "selector" });
  });

  test("ticks check boxes and chooses radio buttons with a person's click, only when not already as asked", async ({ page: p }) => {
    await serve(p);
    await p.goto(`${ORIGIN}/choices`);
    const set = (pairs: [string, string][]) => run(p, SET, { o, f: "form#prefs", v: v(pairs) });
    const heard = () => p.evaluate(() => (window as unknown as { heard: string[] }).heard.splice(0));
    // What a check box, a radio button or a list cannot take is refused before anything is set.
    for (const pairs of [[["#vacation", "yes"]], [["#vacation", "on"]], [["input[name=ship]", "pickup"]],
      [["input[name=ship]", "overnight"]], [["#lang", "fr"]]] as [string, string][][]) {
      expect(await set(pairs), JSON.stringify(pairs)).toEqual({ r: "field" });
    }
    expect(await heard()).toEqual([]);
    const pairs: [string, string][] = [["#vacation", "checked"], ["#cod", "unchecked"], ["input[name=ship]", "express"], ["#lang", "en"]];
    expect(await set(pairs)).toEqual({ r: "set" });
    // A click each, which the page hears as a person's (click, then input and change), and the list as chosen.
    const first = await heard();
    for (const id of ["vacation", "cod", "express"]) {
      expect(first.filter((h) => h.endsWith(`:${id}`)), id).toEqual([`click:${id}`, `input:${id}`, `change:${id}`]);
    }
    expect(first.filter((h) => h.endsWith(":lang"))).toEqual(["input:lang", "change:lang"]);
    // Asked again, nothing already as asked is clicked: a second click would undo the first.
    expect(await set(pairs)).toEqual({ r: "set" });
    expect((await heard()).filter((h) => h.startsWith("click"))).toEqual([]);
    // Every one reads back as asked, so the form is pressed once, and the page has what was approved.
    const pressed = await run(p, PRESS, { o, f: "form#prefs", v: v(pairs) });
    expect(pressed.r).toBe("pressed");
    expect(JSON.parse(await p.evaluate(() => document.body.dataset.saved ?? "{}"))).toEqual({ vacation: "on", ship: "express" });
    // A radio button named by its own selector chooses from its group, the same way.
    await p.goto(`${ORIGIN}/choices`);
    expect(await set([["#express", "standard"]])).toEqual({ r: "set" });
    expect(await readBack(p, "#express")).toBe("standard");
    // A box the page unticks again: what would go is not what was approved, so nothing is pressed.
    await p.goto(`${ORIGIN}/choices`);
    const stubborn = v([["#stubborn", "checked"]]);
    expect(await run(p, SET, { o, f: "form#prefs", v: stubborn })).toEqual({ r: "set" });
    await expect.poll(async () => (await run(p, PRESS, { o, f: "form#prefs", v: stubborn })).r).toBe("changed");
    expect(await p.evaluate(() => document.body.dataset.saved)).toBeUndefined();
  });

  test("types into editors that are not form fields as typing does, and never as Return", async ({ page: p }) => {
    await serve(p);
    await p.goto(`${ORIGIN}/editors`);
    const reply = "สวัสดีค่ะ the parcel ships today\n\nThank you, Fon ";
    const pairs = v([["#box", reply], ["#paras", "first\nsecond"]]);
    expect(await run(p, SET, { o, f: "form#post", v: pairs })).toEqual({ r: "set" });
    // Typed through the browser's own editing, so the page heard typing; each line break as Shift and Return makes one,
    // so the chat box that sends on Return sent nothing while it was typed into.
    const heard = await p.evaluate(() => (window as unknown as { heard: string[] }).heard);
    expect(heard).toContain("box:insertText");
    expect(heard).toContain("box:insertLineBreak");
    expect(heard).toContain("paras:insertText");
    expect(heard.filter((h) => h.endsWith("insertParagraph"))).toEqual([]);
    expect(await p.evaluate(() => document.body.dataset.sent)).toBeUndefined();
    // Read back as a person reads it: what was there before is gone, the lines are the lines asked for.
    expect(await readBack(p, "#box")).toBe(reply);
    expect(await readBack(p, "#paras")).toBe("first\nsecond");
    const pressed = await run(p, PRESS, { o, f: "form#post", v: pairs });
    expect(pressed.r).toBe("pressed");
    expect(await p.evaluate(() => document.body.dataset.sent)).toContain("the parcel ships today");
    // The box emptied as a chat's does once it sent; the other editor kept its text, which a box given no words would
    // not have, so the answer is read from the box alone when it is the only one written to.
    const box = v([["#box", reply]]);
    await expect.poll(async () => (await run(p, SENT, { o, a: pressed.a, f: "form#post", v: box })).s).toBe("sent");
  });

  test("reads an editor's text as a person reads it, whatever the editor draws it with", async ({ page: p }) => {
    await serve(p);
    await p.goto(`${ORIGIN}/editors`);
    const drawn = async (html: string) => {
      await p.$eval("#drawn", (el, h) => { el.innerHTML = h; }, html);
      return readBack(p, "#drawn");
    };
    for (const [html, text] of [
      ["<p>two</p><p><br></p><p>blank</p>", "two\n\nblank"],
      ["two<br><br>blank", "two\n\nblank"],
      ["line one<div>line two</div>", "line one\nline two"],
      ["<div>line one</div><div>line two</div>", "line one\nline two"],
      ["two<div><br></div><div>blank</div>", "two\n\nblank"],
      ["trail<br><br>", "trail\n"],
      ["<p>x</p><p><br></p>", "x\n"],
      ["<p>x<br></p>", "x"],
      ["<br>", ""],
      ["", ""],
      ["&nbsp;both&nbsp;", " both "],
      ["a​b﻿", "ab"],
      ["<b>bold</b> and <i>slanted</i>", "bold and slanted"],
      ["<span style=\"display:none\">hidden</span>shown", "shown"],
      ["<ul><li>one</li><li>two</li></ul>", "one\ntwo"],
    ] as [string, string][]) {
      expect(await drawn(html), html).toBe(text);
    }
    // A list, a check box and a text field read as the write compares them.
    await p.goto(`${ORIGIN}/choices`);
    expect([await readBack(p, "#vacation"), await readBack(p, "#cod"), await readBack(p, "input[name=ship]"), await readBack(p, "#lang")])
      .toEqual(["unchecked", "checked", "standard", "th"]);
  });
}
