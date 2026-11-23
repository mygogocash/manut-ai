import { create } from "qrcode";
import { useMemo } from "react";

/// A QR code drawn as one SVG path, with the four-module quiet zone scanners expect. It stays dark on white
/// in both themes, because a bank app cannot read it inverted; those two colours are the light theme's own
/// ink and surface.
export function QrCode({ text, label, size = 224 }: { text: string; label: string; size?: number }) {
  const { path, total } = useMemo(() => {
    const modules = create(text, { errorCorrectionLevel: "M" }).modules;
    const quiet = 4;
    let d = "";
    for (let row = 0; row < modules.size; row += 1) {
      for (let col = 0; col < modules.size; col += 1) {
        if (modules.get(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`;
      }
    }
    return { path: d, total: modules.size + quiet * 2 };
  }, [text]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      style={{ display: "block", borderRadius: "var(--rad)", border: "1px solid var(--line)" }}
    >
      <rect width={total} height={total} fill="#FFFFFF" />
      <path d={path} fill="#111110" />
    </svg>
  );
}
