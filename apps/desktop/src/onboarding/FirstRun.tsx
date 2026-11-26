// One quiet line under an empty sidebar section, from the fork ("Each bot is a Hermes profile. Add one with + above.").
// Nothing draws it since the side menu replaced the fork's sidebar. The first-run setup is Onboarding.tsx: it fills the
// window on a first run, in the system's language (i18n `readLang`), which its Welcome and Settings › General change.
import "./firstrun.css";

/** One muted line under an empty sidebar section. */
export function FirstRunHint({ text, testId }: { text: string; testId: string }) {
  return (
    <div className="onb-hint" data-testid={testId}>
      {text}
    </div>
  );
}
