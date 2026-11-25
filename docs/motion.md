# Motion

How the desktop app moves: the design canvas's Motion board (`BrandMotion`), built once in
`apps/desktop/src/theme/motion.css` (item 85a). "Things move to show what just changed, and for no other reason. One
springy curve and a handful of named moves."

The numbers and keyframes are the kit's own (`packages/ui-kit/app.css`, `tokens.json` "motion").
`src/theme/motion.test.ts` fails when motion.css drifts from them, and `src/theme/motionRule.test.ts` fails when any
other stylesheet types a move of its own. So a move changes on the board first, then in the kit, then in motion.css,
and every other stylesheet only names it.

## The rules

From the board, word for word:

- Nothing moves for decoration. If a move does not say what changed, remove it.
- Only work in progress may loop, and a team face that is waiting for you. Everything else plays once and stops.
- Keep it under a second. A person should never wait for an animation.
- Money, approvals and errors do not bounce. They appear and stay still.
- With reduced motion turned on, every move is switched off and the shimmer becomes plain grey text.

Where a choice is left open, restraint decides: slower in, quicker out; small distances; no scale above 1 but the
curve's own small overshoot; nothing that moves twice; nothing that moves because the pointer passed over it except
the Hover fade.

## The curve

| Token | Value | For |
| --- | --- | --- |
| `--aui-ease` | `cubic-bezier(.22, 1.25, .36, 1)` | Entrances, presses, the switch, a word rolling. It overshoots by about 2% and comes back |
| `--ease-plain` | `cubic-bezier(.22, 1, .36, 1)` | Fades, bars, meters, and anything that moves the layout (a panel, a column, a row), so no number, edge or line of text bounces |

## The moves

| Move | Time | Token to use | Where | Never |
| --- | --- | --- | --- | --- |
| Rise | 0.5 s, each item 50 ms after the last (at most four steps), 8px | `var(--anim-rise)`, `.mo-rise` with `--i` | Something arrives: chips, rows, cards, a toast, a run's boxes | On an ask, an error or a sum of money; on anything already on screen |
| Settle | 0.45 s | `var(--anim-settle)`, `.mo-settle` | A decision lands in its row; a thread's done mark | On the ask itself before it is decided |
| Fill | 0.9 s, plain ease | `var(--anim-fill)`, `.mo-fill` | A bar or a meter fills | On anything that is not a measure |
| Press | 0.2 s, 97% while held (the round send button 94%, as the kit's) | motion.css's Press list | Every button: primary, quiet, icon, send, a close × | Rows, chips, tabs, links: they answer with Hover only |
| Switch | 0.25 s on the curve; the track's fill fades in 0.2 s | `var(--tr-switch-thumb)`, `var(--tr-switch-track)`; `var(--tr-switch)` for a chevron turning | A switch's thumb; a disclosure chevron (as the kit's accordion) | |
| Hover | 0.15 s, plain ease, in only | Global `:hover` rule; `var(--tr-hover)`, `var(--tr-control)` | A fill, an edge or a text colour fading in under the pointer | A leaving fade: the fill goes at once when the pointer leaves |
| Shimmer | 2.4 s loop | `var(--anim-shimmer)`, `.mo-shimmer` | The working line | Anything not being worked on now |
| Pulse | 1.6 s loop | `var(--anim-pulse)`, `.mo-pulse` | The working dot (a run, a session starting, the microphone on, the typing dots in turn) | A dot that waits for the person (Needs you): it stays still |
| Roll | 12 s loop, five words | `var(--anim-roll)`, `.mo-roll` | The working words. One step of it (a line up, the old line leaving quicker) is the activity ticker | |
| Loading | 1.6 s loop | `var(--anim-loading)`, `.mo-loading` | A page, a picture or a list while it loads | |
| Spin | 0.8 s loop | `var(--anim-spin)`, `.mo-spin` | A busy spinner: the kit's `.spin`, the one loop the board does not draw | Anything that is done or waiting |

Overlays (a menu, a popover, a tooltip, the palette, a dialog) arrive with a short Rise and leave faster than they
came:

| Move | Time | Token | Notes |
| --- | --- | --- | --- |
| Arrive | 0.3 s on the curve (the kit's bulk-action bar), 4px | `var(--anim-arrive)` with `--rise-by: var(--arrive-by)` (from below) or `calc(var(--arrive-by) * -1)` (from above, a menu opening down) | With `--rise-by: 0px` it is a fade where it stands: for a backdrop, an ask (the update dialog, a remove confirmation, a terminal's request to type), which appears and stays still, and a tooltip, which the pointer brought |
| Leave | 0.15 s, plain ease, a fade where it stands | `var(--anim-leave)` | The shared popover (`src/ui/Popover.tsx`) and the palette stay drawn for it, inert and hidden from a screen reader (`src/ui/leave.ts`, `LEAVE_MS`); with reduced motion they go at once. An overlay its parent removes goes at once |

The focus ring appears and stays still: no transition may name `outline` or `all`.

## Reduced motion

One block in motion.css. Every animation ends at once in its end state (0.01 ms, one iteration, no delay) and no
transition runs. It ends moves rather than removing them, so a part that waits for a move's end (the ticker's old line,
a leaving overlay) still hears that it ended, and a loop stands on its still frame. The shimmer becomes plain grey
text. A stylesheet's own reduced-motion block may only say what that still frame looks like (the typing dots at rest,
no dash on a run's edges). A held button still shows its 97%, as the kit's does, since that is a state, not a move.

## The rule the tests keep

`src/theme/motionRule.test.ts` reads every stylesheet under `apps/desktop/src` but motion.css and fails on:

- a `cubic-bezier(` or `steps(` typed by hand;
- a time (`0.2s`, `80ms`) or a timing word (`ease`, `linear`, `ease-out`...) in a transition or an animation;
- a `@keyframes` or an animation that is not a named move (`rise`, `pop`, `grow`, `shim`, `pulse`, `roll6`, `spin`,
  `leave`);
- a move that plays once for longer than a second, or a delay longer than one;
- a loop of anything but Shimmer, Pulse, Roll, Loading or Spin;
- a transition of `outline` or `all`;
- a reduced-motion block that sets an animation or a transition;
- a class named like a button (`btn`, `ib`, `send`, `*-btn`, `*-ib`, `*-send`, `*-plus`, `*-x`) missing from the Press
  list, unless the test names it as a row (`me-btn`, `who-btn`).

Its own short list of exceptions, each with why: `ui-ring-turn` (the live ring's period is also `Live.tsx`'s
`ringDelay`), `bv-flow` (a dash on an SVG edge, the Shimmer's idea where a background shimmer cannot paint),
and the team faces' own moves as the kit draws them.

`e2e/motion-shots.spec.ts` shows the moves as a person sees them: a button's Hover and Press, the switch, the + menu,
the model popover and the palette, held still at the start, the middle and the end of each move, in light and dark,
and with reduced motion, where the first frame is already the last. `MOTION_SHOTS=<dir>` keeps the frames as PNGs.

## Adding or changing a move

1. Change the canvas's Motion board first (`BrandMotion`), and the kit's `app.css` and `tokens.json` with it.
2. Then motion.css: its time as a `--move-*` token, its keyframes word for word, and a ready `--anim-*` or `--tr-*`.
   motion.test.ts will say what still differs from the kit.
3. If it loops, add it to the loops in both tests; if it plays once, keep it under a second.
4. Use it from a stylesheet by its token, never by its numbers.

A move the board does not have is not added here. If a stylesheet truly needs one of its own, it goes in
motionRule.test.ts's list of exceptions with why, and on the board's list of open questions.
