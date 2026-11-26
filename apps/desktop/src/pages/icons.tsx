// The icons of the Automations and Plugins pages and their chat cards, drawn from the brand's one set (src/ui/icons.tsx,
// item 85i): a plugin's tile shows its catalog category. No emoji: they render unevenly.
import { Icon, type IconName } from "../ui/icons";

type Sized = { size?: number };
export const ClockIcon = ({ size }: Sized) => <Icon name="clock" size={size} />;
export const PlugIcon = ({ size }: Sized) => <Icon name="plug" size={size} />;
export const DotsIcon = ({ size }: Sized) => <Icon name="dots" size={size} />;

/** Which drawing of the set stands for each catalog category. */
const CATEGORY: Record<string, IconName> = {
  automation: "bolt",
  tools: "wrench",
  memory: "database",
  voice: "mic",
  web: "globe",
  desktop: "monitor",
  models: "chip",
  platform: "message",
  general: "cube",
};

/** The tile icon for a plugin of `category` (a box for anything the catalog does not name). */
export const CategoryIcon = ({ category, size }: { category: string; size?: number }) => <Icon name={CATEGORY[category] ?? "cube"} size={size} />;
