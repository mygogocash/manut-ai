// The quiet line above the account row that says which runtime the app runs on: "Practice mode" for the demo team
// inside the app, or "Connected to dev.manut.xyz" and how that link stands (signed out, offline, not answering). It
// opens Settings › Developer, where the choice is made. A WebSocket runtime, which only the e2e suite configures, is
// neither, so the line is not drawn for it.
import { t } from "../i18n";
import { useModeLine } from "../runtime/link";

export function ModeLine({ onOpen }: { onOpen: () => void }) {
  const line = useModeLine();
  if (!line) return null;
  return (
    <button type="button" className="sb-mode" title={t("mode.open")} onClick={onOpen} data-testid="mode-line">
      {t(line.key, line.vars)}
    </button>
  );
}
