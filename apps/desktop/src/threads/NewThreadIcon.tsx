// A speech bubble with a plus: start a new chat. The brand set's drawing (src/ui/icons.tsx, item 85i).
import { Icon } from "../ui/icons";

export function NewThreadIcon({ size }: { size?: number }) {
  return <Icon name="message-plus" size={size} className="nt-ic" />;
}
