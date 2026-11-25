// The popover arrives and leaves by the Motion board (ui.css, leave.ts): open, it is drawn as before, never as leaving;
// closed from the start, it is not drawn at all. Its fade out, inert, and the reduced-motion case that skips it are
// browser behaviour, checked in e2e/motion-shots.spec.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Popover } from "./Popover";

const close = () => {};

describe("Popover", () => {
  it("draws an open popover as it always did, and nothing in it marked as leaving", () => {
    const html = renderToStaticMarkup(
      <Popover open onClose={close} side="top" align="left" label="Menu">
        <button type="button">Pick</button>
      </Popover>,
    );
    expect(html).toContain('class="ui-pop ui-pop-top ui-pop-left"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain("<button");
    expect(html).not.toMatch(/data-leaving|inert|aria-hidden/);
  });

  it("draws nothing while it has never been open", () => {
    expect(renderToStaticMarkup(<Popover open={false} onClose={close}>x</Popover>)).toBe("");
  });
});
