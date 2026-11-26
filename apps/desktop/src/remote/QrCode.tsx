// The pairing code drawn as a QR code: one SVG path with the four-module quiet zone scanners expect, lifted from the web
// app's own (apps/web/src/ops/QrCode.tsx) on the same encoder, `qrcode` 1.5.4 (MIT, soldair/node-qrcode), which draws
// nothing and reaches no network: only its `create` is used, which returns the modules. It stays dark on white in both
// themes, because a phone's camera cannot read it inverted.
import { create } from "qrcode";
import { useMemo } from "react";

export function QrCode({ text, label, size = 200 }: { text: string; label: string; size?: number }) {
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
    <svg className="rm-qr" role="img" aria-label={label} viewBox={`0 0 ${total} ${total}`} width={size} height={size} shapeRendering="crispEdges" data-testid="remote-qr">
      <rect width={total} height={total} fill="#FFFFFF" />
      <path d={path} fill="#111110" />
    </svg>
  );
}
