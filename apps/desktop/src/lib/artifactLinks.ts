// Settings › Artifacts (item 83): whether this Mac offers publishing an HTML or Markdown page as a public link at all. Saved on this
// computer in `localStorage`, like Settings › Source control's choices (`lib/sourceControl.ts`).
//
// Off by default. A link can be opened by anyone who has it, so a person turns this on knowing that. While it is off, the Artifacts
// page offers nothing and the runtime sends nothing about links (src/runtime/http/artifacts.ts), neither a read nor a change: links
// made before stay open until they are removed, which needs the switch on again. With it on, every publish and every removal is
// still asked first (src/runtime/artifactAsks.ts): the switch never publishes anything by itself.
//
// A second switch, Allow sharing skills by link (item 84), also off by default, covers skills: publishing a bundle of the person's
// own skills as a link, and installing skills from someone else's link (Settings › MCP and Skills). A skill tells a coding agent
// what to do, so sharing pages does not turn it on: while it is off no bundle is read, published or fetched.
import { useSyncExternalStore } from "react";

export interface ArtifactSettings {
  /** Allow publishing public artifact links. */
  publish: boolean;
  /** Allow sharing skills by link: publishing skills and installing skills from a link. */
  skills: boolean;
}

export const ARTIFACT_DEFAULTS: ArtifactSettings = { publish: false, skills: false };

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
    const saved = !!v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    return { publish: saved.publish === true, skills: saved.skills === true };
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
