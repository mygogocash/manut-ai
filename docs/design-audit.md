# The look, page by page, beside the canvas (25 Nov 2026)

The owner asked for an app that feels premium, classic and quiet. A reviewer photographed every page of the side
menu and of Settings in light and dark, at 1280 and at 900 wide (140 pictures), rendered 21 boards of the design
canvas, and measured the styles on each screen. Home and the side menu are close to their boards; the further a page
is from Home, the more it still looks like the project this app was forked from. Nothing was changed by the review.
The fixes are items 85e to 85i in `docs/plan.md`; the motion is items 85a to 85c and `docs/motion.md`.

## What "quiet luxury" means here, as rules

- **Colour:** one black main button a view, and colour only for its four meanings (working, needs you, checked,
  failed). No accent for the person to pick.
- **Type:** sizes only from the scale, nothing under 12px. Weight 600 is the only emphasis: no capitals, no
  letter-spacing. Anything read at length is serif.
- **Rhythm:** rows 44px, buttons 34px, fields 40px, 16 to 24px between groups, text never wider than 696px. Space is
  left empty rather than filled.
- **Grouping:** grey bands and space group things. A card is only for a decision, and there is one shadow, only for
  things that float.
- **What shows:** no vendor logos, model names, file paths or raw errors on everyday pages. They live under "Under the
  hood".

## Findings

"Seen" means in a picture; "measured" means from the styles; "code" means read, not seen.

### Leftovers of the fork

1. **Faces, on every page that shows a member.** They are the other project's pink and purple mascots, not the drawn
   silhouettes on team-colour grounds (the Colour board's team colours, `KitFaces`). `src/ui/Avatar.tsx`. Seen.
2. **The chat.** Replies are 13px sans in grey bubbles on both sides. The Chat board sets Buddy's answer in 17px serif
   with no bubble, and only the person's message has one. The serif is not bundled (`theme/fonts.css`), `--font-read`
   is used only in `pages/mission.css`, and `--fs-msg` starts at 13px. Seen, and code. *Item 85f (26 Nov):* the answer
   is on the page in `--font-read` at 17px / 1.65 in a 696px column, the person's message alone in a bubble at 15px,
   and Settings › Appearance's text size moves both a step along the scale. The serif, Source Serif 4, is bundled
   for Latin text; Thai and the CJK languages read in the stack's next serif until theirs are bundled.
3. **Languages.** Settings and the palette offer English, Korean, Japanese and Chinese, and no Thai. The Type board
   treats Thai as a first language. Not changed: the owner said on 25 Nov that the first release speaks those four and
   Thai waits.
4. **Settings** is the other project's: a second list 168px wide with the developer pages (Terminal, Providers,
   Worktrees, Source control, MCP and Skills, Developer) beside the everyday ones. The Settings board is one quiet
   column. Smallest change: the developer pages under one "Under the hood" entry, as the Voice board names it. Seen.
5. **Code** opens on the old TERMINALS section with other companies' logos on an otherwise empty page. The Code board
   shows lanes, the conversation and a diff: at least a grey Lanes band and `StatesCode`'s empty state. Seen.
6. **The foot of the side menu** shows three small squares for each coding tool's use, and "You". The board has the
   budget pill and the person's name with their shop. Seen.
7. **The chat's header** shows a maker's logo with a model and effort, and "3 other places" with two other companies'
   logos. The board has Answer, Used and Steps, and a cost line. Seen. *Item 85f (26 Nov):* the header holds the
   member's name, the places in words and the panel button; the model and its effort are in the chat box. The Answer,
   Used and Steps tabs and the cost line wait for runtimes that say what an answer used and what a chat cost.

### The same thing drawn two ways

8. **An approval's card in the chat** has three 24px tinted buttons (red, blue, amber) and a red bar down its left.
   By the Colour board blue is never a button, amber means Needs you, red means failed, each view has one black main
   button, and a button is 34px. `chat/cards/cards.css`. Seen in both themes. Rebuilt in item 85g (26 Nov): the kit's
   card, Allow once the one black button, no tints and no rail (`e2e/ask-cards.spec.ts` pictures every kind).
9. **Two icon sets.** The side menu's is the brand's (16px, a 1.4 line). Pages use `ui/icons.tsx` (9 to 15px, a 1.8 to
   2.6 line): 257 of the icons measured are 14px with a 2px line. Measured.
10. **Two segmented switches.** Home's is a 28px pill; Settings' (`.mseg`) are 22px rectangles with 11.5px text. Seen.
11. **Two greys for second-line text.** `--quiet` (the placeholder's colour) is text in 219 rules beside `--muted`. On
    grey bands, the side menu and hovered rows it measures 4.0 to 4.3 to 1, under the 4.5 the Contrast board asks.
    Measured.
12. **Team's Pause everyone** is a red outlined button. Pausing can be undone, so red is wrong. Seen.

### Density and rhythm

13. **Text below the scale.** The commonest sizes on the pages are 11.5, 11, 12.5 and 10.5px; the board's smallest is
    12px for tags and 14px for body. Settings is worst (`settings/settings.css`: `.st-k b`, `.st-k span`, `.st-note`,
    and the uppercase 10.5px `.st-sh` and `.st-gh` labels, which should be grey bands in sentence case). Measured.
14. **The side menu is 248px wide** where the board says 196 (`--side-w`). Seen.
15. **The command palette's** rows are 32px with no icons, and its groups are in capitals. The board's menu rows are
    34px with an icon and its word. Seen.
16. **Needs you** has thin rows, a grey "Approve" tag that looks like a button, and two times. The board has one card a
    decision, a 17px line saying what follows, and Approve on the card. Seen. Rebuilt in item 85g (26 Nov): one card a
    decision, the 17px line, one time and the kind as an amber mark; Approve stays on Home and the chat's card, by the
    decision of 24 Nov that an owner reads the card before approving.

### Empty, loading and error states

17. **Customize and the activity log** print a raw error as body text when a read fails. The system-states board says
    "This page did not load. Nothing was changed. Try again." Seen; a real failure would read the same.
18. The empty states of Needs you, Artifacts and History are good and alike: the pattern for the others.

### Dark, and narrow

19. **Dark, Settings, General:** in the Appearance preview a chip is white text on a near-white ground
    (`settings/settings.css`, a hand-typed `#fff`). Seen.
20. **At 900 wide,** Team's and Customize's right panel drops under a half-height list and leaves a blank strip, and
    Settings shows three columns with 485px left for the page. Seen.

### Words

21. Technical words where the Voice board is plain (`i18n/en.ts`): "Bots", "Automations" beside "Routines", "Plugins",
    "Idle", "New session", "Deny", "Allow for session", "Waiting for approval", "Profile ID", "Reasoning", "Providers",
    "Worktrees". The board says team member, Routines, Needs you, Under the hood. Seen.

## The order of work

1. The brand's faces in place of the mascots (1).
2. Serif, unbubbled replies at 15 and 17px (2).
3. The approval card and Needs you rebuilt from the canvas, with one black button (8, 16).
4. Settings as one column with the developer pages under "Under the hood", and its text on the scale (4, 13).
5. One icon set, one grey, a 196px menu and the menu's foot (6, 9, 11, 14), then the rest.

## What the review could not reach

People (off under the tests' stand-in), Automations and Plugins (the clicks timed out), a job's page, and the first
run. Memory, routines and the activity log returned no rows under the stand-in. The serif's absence, the contrast
figures and the other companies' logos in the real app are from code and measurement, not from a picture.
