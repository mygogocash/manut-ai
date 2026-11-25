// Settings › Artifacts (item 83): whether this Mac offers publishing an HTML or Markdown page as a public link at all. Saved on this
// computer in `localStorage`, like Settings › Source control's choices (`lib/sourceControl.ts`).
//
// Off by default. A link can be opened by anyone who has it, so a person turns this on knowing that. While it is off, the Artifacts
// page offers nothing and the runtime sends nothing about links (src/runtime/http/artifacts.ts), neither a read nor a change: links
// made before stay open until they are removed, which needs the switch on again. With it on, every publish and every removal is
// still asked first (src/runtime/artifactAsks.ts): the switch never publishes anything by itself.
import { useSyncExternalStore } from "react";

export interface ArtifactSettings {
  /** Allow publishing public artifact links. */
  publish: boolean;
}

export const ARTIFACT_DEFAULTS: ArtifactSettings = { publish: false };

const KEY = "manut.artifacts";

function read(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The saved settings; anything that is not exactly `true` is off. */
export function parseArtifactSettings(text: string | null): ArtifactSettings {
  try {
    const v: unknown = text ? JSON.parse(text) : {};
    return { publish: !!v && typeof v === "object" && (v as Record<string, unknown>).publish === true };
  } catch {
    return ARTIFACT_DEFAULTS;
  }
}

const listeners = new Set<() => void>();
let cache: { text: string | null; value: ArtifactSettings } | null = null;

export function artifactSettings(): ArtifactSettings {
  const text = read();
  if (!cache || cache.text !== text) cache = { text, value: parseArtifactSettings(text) };
  return cache.value;
}

export function setArtifactSettings(patch: Partial<ArtifactSettings>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...artifactSettings(), ...patch }));
  } catch {
    /* no storage: the switch stays as it was */
  }
  listeners.forEach((l) => l());
}

export function useArtifactSettings(): ArtifactSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    artifactSettings,
    artifactSettings,
  );
}
