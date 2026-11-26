// Drags onto the open terminal (src/sessions/splitDrag.ts), with the mouse as a person does: a TERMINALS row from the
// sidebar, or a split pane's grip. The drop zone (`split-drop`) shows on the side of the target pane the pointer is
// nearest; letting go there splits it.
import { expect, type Page } from "@playwright/test";

export type Side = "left" | "right" | "up" | "down";

/** Why a spec does not drag a TERMINALS row onto an open terminal. The list left the sidebar for the Code page, which
 *  takes the main column the terminal fills, so a row and a pane are never on screen together. */
export const NO_ROW_DRAG =
  "a TERMINALS row can no longer be dragged onto an open terminal: the list is on the Code page, which replaces the terminal in the main column, so a row and a pane are never on screen together (the sidebar's list left with the side menu)";

/** The box a session shows in: its split pane, else its terminal. */
const paneBox = async (page: Page, id: string) => (await page.locator(`[data-testid="split-pane"][data-session="${id}"], [data-testid="terminal"][data-session="${id}"]`).first().boundingBox())!;

/** Press at `from`, move onto `onto`'s `side` part, check the drop zone (shown there, or none with `drop` false), let go
 *  (or press Escape first with `esc`). */
async function dragFrom(page: Page, from: { x: number; y: number }, onto: string, side: Side, o: { drop?: boolean; esc?: boolean } = {}) {
  const b = await paneBox(page, onto);
  const [cx, cy] = [b.x + b.width / 2, b.y + b.height / 2];
  const to = { left: [b.x + b.width * 0.08, cy], right: [b.x + b.width * 0.92, cy], up: [cx, b.y + b.height * 0.08], down: [cx, b.y + b.height * 0.92] }[side];
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 12 });
  const shade = page.getByTestId("split-drop");
  if (o.drop === false) {
    await page.waitForTimeout(100);
    await expect(shade).toHaveCount(0);
  } else {
    await expect(shade).toHaveAttribute("data-side", side);
    await expect(shade).toHaveAttribute("data-session", onto);
  }
  if (o.esc) {
    await page.keyboard.press("Escape");
    await expect(shade).toHaveCount(0);
  }
  await page.mouse.up();
  await expect(shade).toHaveCount(0);
}

/** Drag TERMINALS row `id` onto the `side` part of `onto`'s pane. */
export async function dragRowOnto(page: Page, id: string, onto: string, side: Side, o: { drop?: boolean; esc?: boolean } = {}) {
  // the TERMINALS list scrolls inside its share of the sidebar: a lower row is scrolled to before it is pressed
  const open = page.getByTestId(`session-${id}`).locator(".ss-open");
  await open.scrollIntoViewIfNeeded();
  const r = (await open.boundingBox())!;
  await dragFrom(page, { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 }, onto, side, o);
}

/** Put session `add` in a new pane on the `side` of `at`'s pane, as a row dropped there does: the same store action
 *  (src/sessions/SplitView.tsx `splitWith`) that the drop calls. A row cannot be dragged onto an open terminal any more
 *  (the list is on the Code page, which takes the main column the terminal fills), so a spec whose subject is not the
 *  drop builds its split with this instead, and says so where it does. */
export async function splitBeside(page: Page, at: string, add: string, side: Side = "right") {
  await page.evaluate(
    async ([a, b, s]) => {
      const m = (await import(/* @vite-ignore */ "/src/sessions/SplitView.tsx" as string)) as { splitWith(at: string, add: string, dir: Side): void };
      m.splitWith(a, b, s);
    },
    [at, add, side] as const,
  );
}

/** Drag split pane `id` by its grip onto the `side` part of `onto`'s pane. */
export async function dragGripOnto(page: Page, id: string, onto: string, side: Side, o: { drop?: boolean; esc?: boolean } = {}) {
  await page.locator(`[data-testid="split-pane"][data-session="${id}"]`).hover();
  const g = (await page.locator(`[data-testid="split-grip"][data-session="${id}"]`).boundingBox())!;
  await dragFrom(page, { x: g.x + g.width / 2, y: g.y + g.height / 2 }, onto, side, o);
}
