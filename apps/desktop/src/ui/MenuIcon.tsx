// A menu entry's lead (item 122, the owner's request of 26 Nov 2026: every menu led by an icon): one 16px slot before its
// words, holding an icon of the app's own set for the app's own action, or a product's own logo where the entry names that
// product (Open in Zed). The slot is there even when it holds nothing, so an entry's words never move when an icon comes or
// goes and every menu's words stand on one column. It is hidden from a screen reader: the words say what the entry does.
import { AgentIcon } from "./AgentIcon";
import { Icon, type IconName } from "./icons";

export function MenuIcon({ name, mark }: { name?: IconName | null; mark?: { id: string; title: string } | null }) {
  return (
    <span className="mi-ic" aria-hidden="true">
      {mark ? <AgentIcon id={mark.id} title={mark.title} size={16} /> : name ? <Icon name={name} /> : null}
    </span>
  );
}
