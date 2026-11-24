# The owner's pages on phones

An owner answers a reply, or a request to delete their shop's data, from a link in a LINE message, on a phone. The link
opens the approval page (`/approve/<token>`) or the deletion page (`/delete/<token>`) of `apps/web`, often inside LINE's
own browser. This page says what CI checks about them at phone sizes, what it cannot check, and the ten-minute check the
owner makes on a real phone. It is December item 35 in `docs/plan.md`.

## What the CI pass covers

The job "Web on phones" (`.github/workflows/ci.yml`) runs the Playwright specs in `apps/web/e2e` on every push and pull
request. Playwright starts the vite dev server in practice mode (no `VITE_API_ORIGIN`, so the pages run on the in-memory
fake and need no backend) and opens the pages in real browser engines on four screens:

| Phone | Engine | Screen, in CSS pixels |
| --- | --- | --- |
| iPhone 17 | WebKit | 402 by 681 |
| iPhone SE (3rd generation) | WebKit | 375 by 667 |
| Pixel 8 | Chromium | 412 by 839 |
| Android, 360 by 740 (a Galaxy S8's size) | Chromium | 360 by 740 |

Each has touch input, its own pixel density and its own user agent, taken from Playwright's device list.

**Every state, 27 of them.** Each demo link on the practice home page (`/`), and the states an owner only reaches by
pressing a button, reached by pressing it.

- Approval page: a reply waits; the one-time permission step; a send under way; a send that failed; a send nobody can
  confirm; already sent; already declined; nobody answered in time; a link that expired; a link that does not work; a
  request that cannot be loaded. Also a long Thai message and reply, and a long order id and link in a customer's
  one-word name, each on the waiting card, the permission step and a send under way.
- Deletion page: waiting; being deleted; deleted; kept; nobody answered in time; a link that expired; a link that does
  not work; a request that cannot be loaded; a shop with a long Thai name and counts in the millions.

`apps/web/e2e/states.ts` is the list. A spec fails when a demo link on the home page is not in it, so a new state cannot
ship without being opened on a phone.

**Every state is opened in light and in dark, and measured at its normal text size, at 125% and at 150%.** A failure
names the state, the screen and the text size, and says what it found:

- the page scrolls sideways, or something reaches past the screen's edge;
- text sticks out of the box that holds it, is cut off by a box that clips, or overlaps other text; anything inside a
  card or a banner crosses its edge;
- a button is under 44 by 44 CSS pixels, cannot be scrolled fully into view, or has something on top of it where a thumb
  would press.

**Tapping.** Buttons are pressed with touch events (`taps.spec.ts`): Approve; the permission step (Not now goes back,
Allow sends); No; Keep my data; Delete everything; Try again. Each ends on the words it promises.

**On its side, with a notch.** `landscape.spec.ts` turns the two Chromium phones on their side and gives them a notch's
insets (60px at each side, through the DevTools protocol). The waiting reply, the long Thai reply and the deletion
question must stay clear of them. The pages do not pad for a safe area, though `index.html` asks for the whole screen
(`viewport-fit=cover`): they stay clear because the column is centred and at most 560px wide, which leaves 139px at each
side of an 839px landscape screen. WebKit cannot be given insets, so the iPhones skip this spec.

**Thai and words that cannot break.** Customers write in Thai and the drafts answer in Thai, so the practice fake has a
message and reply a paragraph long (`demo-long-thai`), a long order id and tracking link, and a customer name with no
space in it (`demo-long-link`). They are sample data, not copy. Thai wraps at word boundaries in both engines; the
order id, the link and the name break at the card's edge.

**Larger text.** The specs multiply every font size the page declares by 1.25 and by 1.5 (`setTextScale` in
`e2e/layout.ts`), which is what a phone's text-size setting does to text sized in px, and boxes keep their size. They do
not set the root font size, which is the obvious first try: this page sizes its text in px and pins the root to 14px, so a
root of 150% changed none of its text in any of the four engines (the heading stayed 17px, the buttons 13px), and a spec
built that way would have passed whatever the layout did. The helper stops the test if the text did not grow by the factor.

**The checks check themselves.** `harness.spec.ts` puts a known defect on a real page (a box wider than the screen, a long
word, a button wider than its card, clipped text, overlapping lines, a short button, a covered button, and a fixed-height
box that holds its text at 100% and cuts it off at 150%) and expects each one to be named, on every phone.

**Running it here.**

```sh
pnpm --filter @manut/web exec playwright install chromium webkit    # once; both are free downloads
pnpm --filter @manut/web e2e                                         # all four phones
pnpm --filter @manut/web e2e --project="Android 360x740 (Chromium)" --workers=1    # one phone, one test at a time
```

The server takes port 5417 and will not reuse one, so a second run never tests another checkout. If a killed run left it
behind, find it with `lsof -nP -iTCP:5417 -sTCP:LISTEN` and stop it. A failing test leaves its screenshot in
`apps/web/test-results/`. In CI the job summary lists the failing states with the phones they failed on, and the job keeps
the JSON report (artifact `web-phones-results`) and, when something failed, those screenshots (`web-phones-failures`) for
seven days. The first run on one of GitHub's runners took 6 minutes 41 seconds in all, 5 minutes of it the specs (300
tests at two workers: 294 passed and 6 skipped, the iPhones' landscape ones), so it stays one job. The browser install
downloads from Ubuntu's package mirror, and once it crawled for 25 minutes; its step has a limit of 10 minutes, and the
job can be run again.

## What it cannot cover

- **A real phone.** How a button feels under a thumb, real touch and scrolling, the real screen and its brightness.
- **The fonts.** The pages ask Google Fonts for Geist and IBM Plex Sans Thai. The specs refuse that request, so a run never
  waits on the network, and measure each engine's own fallback fonts. Playwright's WebKit is also not iOS Safari: the same
  engine core, with another platform's fonts and settings.
- **LINE's own browser, on iPhone and on Android.** The bars and buttons it puts around a page, whether it pads for the
  notch, its own zoom, text-size and dark-mode behaviour, and how it opens a link. Neither engine here is that browser.
- **The phone's text-size settings** (Dynamic Type and Safari's text size on an iPhone, font size on an Android). The specs
  approximate them by scaling the page's px text. Whether a system setting reaches a page inside LINE's browser at all is
  something only the real phone can tell.
- **A slow or lost network.** Practice mode never touches the network. The page for a request that cannot be loaded is
  measured, but the real wait, the loading skeleton on a slow connection, web fonts that arrive late (the page links them
  after it appears, and they swap in) and a send that stops answering are not.
- **The notch on an iPhone, and LINE's bars.** Chromium is given a notch's insets on its side (above); WebKit cannot be.
  Where LINE's browser draws the page under its own top or bottom bar, and what a portrait iPhone's top and bottom insets
  do there, only the real phone shows.
- **The live backend.** Practice mode runs sample data and a fake whose timing is its own; real names, real replies and the
  real approval link from LINE are not in it.
- **Assistive technology** (VoiceOver, TalkBack) and the browser's own zoom.

## The owner's real-phone check, in ten minutes

You need a phone people use (an iPhone, and an Android if you have one), LINE on it, and the Mac and the phone on the same
Wi-Fi. Write down the phone, its system version, and LINE's version.

1. **One minute, on the Mac.** In the repository run `pnpm --filter @manut/web dev --host`. It prints a line such as
   `Network: http://192.168.1.20:5173/`. Open that address in the phone's browser (Safari or Chrome). The page "Manut AI
   pilot" lists a link for every state. Nothing sent from it is real: it is practice mode. "Reset the sample data" at the
   bottom starts the practice over after you have pressed Approve or Delete.
2. **Four minutes, the pages as they are.** Open these links one after another. For each, ask: can I drag the page
   sideways (it should not move)? Can I read all of it without zooming? Is anything hidden under the phone's top or bottom
   bars? Is each button easy to press with a thumb, and does it do what it says?
   - "Waiting for you, with the one-time permission step": press Approve, then Allow and send this reply, and watch the
     send finish (about five seconds). Then go back and press Not now once, and No once.
   - "Approve, then the send fails" and "Approve, then nobody can tell if it was sent": press Approve and wait.
   - "A long Thai message and reply" and "A long order id and link": read to the end of both. Does every line stay inside
     the card?
   - "No connection": press Try again.
   - "Delete a shop's data: waiting for you": press Keep my data. Open it again and press Delete everything. Then
     "a long Thai shop name and counts in the millions".
3. **Two minutes, bigger text.** Set the phone's text size to the largest it offers (iPhone: Settings, Display and
   Brightness, Text Size; Android: Settings, Display, Font size, whose name varies by maker). Reopen the waiting reply,
   the long Thai one and the deletion page. Did the text get bigger at all? Does everything still fit and still press?
   Put the setting back.
4. **One minute, dark.** Switch the phone to dark appearance and look at the same three pages.
5. **One minute, landscape.** On an iPhone with a notch or a Dynamic Island, turn the phone on its side and open the waiting
   reply. Is any of the text or a button under the notch or the home bar? (The specs check this only in Chromium, with an
   emulated notch.)
6. **Two minutes, inside LINE.** Send yourself the links for the waiting reply, the long Thai one and the deletion page in
   a LINE chat (your Keep, or a chat with a helper), and open them from there, so they open in LINE's own browser. Look
   for everything in step 2, and for LINE's own bar covering the top of the page. If LINE will not open an address that
   starts `http://`, say so: it needs the practice pages served over https, and that is a decision to make then.
7. **Later, with the first real link.** When the first real approval link has come from a real LINE push in the dev
   environment, repeat steps 2 and 6 with it, then switch the phone to airplane mode after the page has loaded and press
   Approve. The page should say "Your answer did not get through. Nothing was sent. Try again." and nothing should be
   sent; reconnect and press again.

Write down every problem with the phone, where you opened it (Safari, Chrome or LINE), the link or state, and a
screenshot. Each one becomes a state or a check in `apps/web/e2e`, so it cannot come back.
