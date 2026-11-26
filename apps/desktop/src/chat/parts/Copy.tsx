// A quiet copy control: an icon that shows on hover of its row (CSS), copies its text, and says "Copied" for a
// moment. Used on an answer, on a message the person sent, and on each code block, in the bot chat and SESSIONS
// chats alike.
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import "./copy.css";
import { Icon } from "../../ui/icons";

const CopyIcon = () => (
  <Icon name="copy" />
);
const CheckIcon = () => (
  <Icon name="check" />
);

/** Copies `text` (a function: read when clicked, so a code block's text is never held twice). */
export function CopyButton({ text, className, testId }: { text: () => string; className?: string; testId?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const label = done ? t("copy.done") : t("copy.copy");
  return (
    <button
      type="button"
      className={`copy-btn${done ? " done" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text()).then(
          () => {
            setDone(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setDone(false), 1400);
          },
          () => {},
        );
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
