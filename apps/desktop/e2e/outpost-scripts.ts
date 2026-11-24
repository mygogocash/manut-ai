// The cases for the outpost's write scripts, run by outpost-scripts.spec.ts (Chromium) and outpost-scripts-webkit.spec.ts
// (WebKit). The scripts (src-tauri/src/outpost/step.rs: SET, PRESS and SENT, as `step::script` writes them) run against
// small test pages, as WKWebView's callAsyncJavaScript runs them: an async function with its arguments as strings, the
// repo's own script text evaluated in a test browser.
// The Rust tests stand a fake browser in for the page, so this is where the scripts themselves are seen to check the form
// and every field before typing anything, type every value exactly, press once and only what may be pressed, and read the
// site's answer. Chromium here and in CI; WebKit, the macOS webview's engine, too on a Mac that has it. Every page is
// served by the spec itself: nothing reaches a real site. (The scripts run in the page's own world here, not in the
// outpost's content world.)
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const SRC = readFileSync(new URL("../src-tauri/src/outpost/step.rs", import.meta.url), "utf8");

/** A script's text as step.rs holds it. */
function raw(name: string): string {
  const found = new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`).exec(SRC);
  if (!found) throw new Error(`step.rs has no ${name}`);
  return found[1];
}
/** A script as it is run: `FIELDS` and `VISIBLE` written in, as `step::script` does. */
const script = (name: string) => raw(name).replace("FIELDS", raw("FIELDS")).replace("VISIBLE", raw("VISIBLE"));
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
}
