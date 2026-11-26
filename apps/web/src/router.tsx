import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

/// Six pages need no router package: the path is read from `location`, `navigate` pushes history, and
/// back and forward arrive as `popstate`. The owner's web app has a page of its own (app/index.html, `/app/`), and is
/// also drawn here for any other path under `/app/`, which the pages Worker answers with this page.

export type Route =
  | { name: "approve"; token: string }
  | { name: "delete"; token: string }
  | { name: "join"; token: string }
  | { name: "ops" }
  | { name: "app" }
  | { name: "home" }
  | { name: "notFound" };

export function matchRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/ops") return { name: "ops" };
  if (path === "/app" || path.startsWith("/app/")) return { name: "app" };
  // The three kinds of link with a token in their path: the owner's reply to approve, the owner's deletion of the
  // shop's data to confirm, and an invite for a helper to join the shop.
  const linked = /^\/(approve|delete|join)\/([^/]+)$/.exec(path);
  if (linked?.[1] && linked[2]) {
    try {
      const name = linked[1] === "approve" ? "approve" : linked[1] === "delete" ? "delete" : "join";
      return { name, token: decodeURIComponent(linked[2]) };
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
