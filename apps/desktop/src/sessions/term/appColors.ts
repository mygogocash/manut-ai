// The terminal colours the app's theme brings (item 99b): a VS Code theme imported with its `terminal.*` keys carries
// them, and while that theme is picked they are what manut's own terminal theme means under the kinds it has. A person who
// picked another terminal theme in Settings › Terminal keeps it: the app theme only stands in for the default pick.
// theme/apply.ts sets them whenever the picked theme changes; this module stays small and holds no palettes, as it is on
// the app's first page while the terminals load later.
import type { TermCustomKey } from "./settings";
import { touchTermSettings } from "./settings";

export interface AppTermColors {
  /** The app theme's name, which the terminal's preview and its list show for the default pick while it stands in. */
  name: string;
  kinds: readonly ("dark" | "light")[];
  colors: Partial<Record<TermCustomKey, string>>;
}

let current: AppTermColors | null = null;

export const appTermColors = (): AppTermColors | null => current;

const same = (a: AppTermColors | null, b: AppTermColors | null) => JSON.stringify(a) === JSON.stringify(b);

/** The colours the picked app theme brings, or null for none. Every open terminal takes its look again when they change. */
export function setAppTermColors(next: AppTermColors | null): void {
  if (same(current, next)) return;
  current = next;
  touchTermSettings();
}
