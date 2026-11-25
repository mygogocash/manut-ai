// The one segmented switch: Home's 28px pill (the design canvas's .modes and .mode, packages/ui-kit/app.css), drawn
// once by ui.css's .ui-modes and .ui-mode. Settings' choices use it here, as radios in a radiogroup so a screen reader
// says which of how many is chosen; Home's ask box draws the same classes on its pressed buttons (HomePage.tsx), as
// the canvas's ask box does. It replaced Settings' own 22px rectangles (`Seg`, which stays only in the chat's model
// menu) in item 85h.

export interface ModesProps {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  /** what is being chosen, read out for the group */
  label: string;
  disabled?: boolean;
  testId?: string;
}

export function Modes({ value, options, onChange, label, disabled, testId }: ModesProps) {
  return (
    <div className="ui-modes" role="radiogroup" aria-label={label} data-testid={testId}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            className="ui-mode"
            disabled={disabled}
            onClick={() => !on && onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
