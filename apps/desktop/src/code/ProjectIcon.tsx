// A project's own icon (item 100b, part 1), for the Code page's project rows: the picture the project's folder keeps in one of a
// few known places (`public/favicon.svg`, `favicon.ico`, `app/icon.png`, ...), read only by the shell
// (src-tauri/src/project_icon.rs: never through a link, never outside the folder, at most 64 KiB, kept by size and modified time).
// Without one, the row keeps what it showed before.
//
// The shell answers a `data:` address of an SVG, a PNG or an ICO, and it is drawn here only as an `<img>`: an SVG drawn as an image
// runs none of its scripts and loads none of its links, which it would if its markup were put into the page. An answer that is not
// such an address is not drawn at all.
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { SessionHost } from "../sessions/host";

/** The addresses an icon may come as: a picture's type, base64 and nothing else. */
const PICTURE = /^data:image\/(svg\+xml|png|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Whether `url` is an icon the page may draw. */
export const isIconAddress = (url: unknown): url is string => typeof url === "string" && url.length <= 96 * 1024 && PICTURE.test(url);

/** The last answer for each folder this run (null: it keeps none), so a row draws at once while the shell is asked again. */
const known = new Map<string, string | null>();
const asking = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Asks `host` for folder `cwd`'s icon, once at a time per folder, and keeps the answer. */
export async function readProjectIcon(host: Pick<SessionHost, "projectIcon">, cwd: string): Promise<string | null> {
  if (!cwd || !host.projectIcon || asking.has(cwd)) return known.get(cwd) ?? null;
  asking.add(cwd);
  try {
    const got = await host.projectIcon(cwd).catch(() => null);
    const icon = isIconAddress(got) ? got : null;
    if (known.get(cwd) !== icon) {
      known.set(cwd, icon);
      version++;
      listeners.forEach((l) => l());
    }
    return icon;
  } finally {
    asking.delete(cwd);
  }
}

/** Folder `cwd`'s icon as last read, read again through `host` when the row first shows. */
export function useProjectIcon(host: Pick<SessionHost, "projectIcon">, cwd: string): string | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    void readProjectIcon(host, cwd);
  }, [host, cwd]);
  return known.get(cwd) ?? null;
}

/** Tests: forget every answer. */
export function resetProjectIcons(): void {
  known.clear();
  asking.clear();
  version++;
  listeners.forEach((l) => l());
}

/** The icon `icon` drawn as a 16px picture, or `fallback` (what the row showed before) when there is none. */
export function ProjectIconView({ icon, fallback = null }: { icon: string | null; fallback?: ReactNode }) {
  if (!isIconAddress(icon)) return <>{fallback}</>;
  return <img className="proj-ic" src={icon} alt="" aria-hidden="true" width={16} height={16} draggable={false} data-testid="project-icon" />;
}

/** Folder `cwd`'s own icon, read through `host`, or `fallback`. */
export function ProjectIcon({ host, cwd, fallback = null }: { host: Pick<SessionHost, "projectIcon">; cwd: string; fallback?: ReactNode }) {
  return <ProjectIconView icon={useProjectIcon(host, cwd)} fallback={fallback} />;
}
