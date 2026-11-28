// The line forms agents write after a path (`path:12`, `path:12:3`, `path:12-20`, `path#L12`, `path#L12-L20`). Lifted from Paradev (MIT, Copyright (c) 2025-2026 Superset Inc., `paradevai/paradev` at
// 2db3bbaf37ffbe24b78c8cdb974bf34632e6fb20): `apps/desktop/src/renderer/lib/fileLocation/fileLocation.ts`, with its tests ported to vitest.
export interface FileLocation {
  path: string;
  row?: number;
  col?: number;
}

const LINE_ANCHOR = /#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/;
const LINE_SUFFIX = /:(\d+)(?::(\d+))?(?:-\d+(?::\d+)?)?$/;

/**
 * Splits `path:12`, `path:12:3`, `path:12-20`, `path#L12` and `path#L12-L20`
 * into the path and where it points. A range keeps its start.
 */
export function splitFileLocation(text: string): FileLocation {
  const match = text.match(LINE_ANCHOR) ?? text.match(LINE_SUFFIX);
  if (!match) return { path: text };
  return {
    path: text.slice(0, match.index),
    row: Number(match[1]),
    ...(match[2] ? { col: Number(match[2]) } : {}),
  };
}

export function splitLineAnchor(text: string): FileLocation | null {
  return LINE_ANCHOR.test(text) ? splitFileLocation(text) : null;
}
