import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

/// Three pages need no router package: the path is read from `location`, `navigate` pushes history, and
/// back and forward arrive as `popstate`.

export type Route =
  | { name: "approve"; token: string }
  | { name: "ops" }
  | { name: "home" }
  | { name: "notFound" };

export function matchRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/ops") return { name: "ops" };
  const approve = /^\/approve\/([^/]+)$/.exec(path);
  if (approve?.[1]) {
    try {
      return { name: "approve", token: decodeURIComponent(approve[1]) };
    } catch {
      return { name: "notFound" };
    }
  }
  return { name: "notFound" };
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => "/",
  );
}

export function navigate(to: string): void {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/// An in-app link: a plain click moves without a reload; a modified click opens a tab as usual.
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
