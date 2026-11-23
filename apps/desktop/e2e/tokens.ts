// The theme's colour tokens as the page resolves them (src/theme/tokens.css). The fork restyled Oh My Hermes' screens
// with the design tokens of packages/ui-kit, so a spec that checks a colour compares it with the token the screen
// should use, read from the page, rather than with a value copied from the theme it was written against.
import type { Page } from "@playwright/test";

/** `token` (for example `--danger`) as a computed colour, `rgb(...)`, in the page's current theme. */
export const tokenColor = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
