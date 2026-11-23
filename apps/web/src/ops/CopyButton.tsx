import { useEffect, useRef, useState } from "react";

/// Copies `text` and says so for two seconds. Where the clipboard is blocked it says that instead, so the
/// operator knows to copy the link by hand.
export function CopyButton({ text, label = "Copy", what }: { text: string; label?: string; what: string }) {
  const [result, setResult] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    setResult(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), 2000);
  }

  return (
    <>
      <button
        type="button"
        className="btn"
        aria-label={result === "copied" ? "Copied" : `${label} ${what}`}
        onClick={() => void copy()}
      >
        {result === "copied" ? "Copied" : label}
      </button>
      {result === "failed" && (
        <span className="help err" role="alert">
          Could not copy. Select the link and copy it by hand.
        </span>
      )}
    </>
  );
}
