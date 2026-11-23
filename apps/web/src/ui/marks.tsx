import { useEffect, useState, type ReactNode } from "react";

/// The brand mark, at 28px in the side menu as on the canvas. Its two colours are the only literal colours
/// AUTHORING.md allows besides the avatar pastels.
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      style={{ display: "block", borderRadius: size / 4, flex: "none" }}
    >
      <rect width="512" height="512" fill="#E3E1DB" />
      <path
        fill="#1F2022"
        d="M186 168 C180 196 176 208 170 226 C162 244 146 256 138 270 C134 278 142 284 160 286 C164 292 158 298 158 304 C158 310 168 310 168 314 C168 320 158 322 160 330 C162 338 170 338 170 346 C172 366 178 386 204 392 C222 396 240 392 252 388 C258 410 256 430 246 444 C216 456 150 468 122 512 L512 512 L512 372 C470 366 428 356 404 330 C438 334 462 306 446 280 C478 268 482 222 452 208 C476 184 462 140 428 138 C432 104 392 76 362 92 C342 64 296 62 280 86 C252 70 212 84 208 116 C188 124 180 148 186 168 Z"
      />
      <path
        fill="none"
        stroke="#E3E1DB"
        strokeWidth="28"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M192 232 L206 246 L232 216"
      />
    </svg>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      {children}
    </svg>
  );
}

export const CheckIcon = () => (
  <Icon>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
);
export const ClockIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </Icon>
);
export const BrokenLinkIcon = () => (
  <Icon>
    <path d="M6.5 9.5l-1.8 1.8a2 2 0 01-2.8-2.8L3.7 6.7M9.5 6.5l1.8-1.8a2 2 0 012.8 2.8l-1.8 1.8M2.5 2.5l11 11" />
  </Icon>
);
export const CloudOffIcon = () => (
  <Icon>
    <path d="M4.5 12.5h7a2.5 2.5 0 00.4-5A4 4 0 004.2 6.6 3 3 0 004.5 12.5zM2.5 2.5l11 11" />
  </Icon>
);
export const ChatIcon = () => (
  <Icon>
    <path d="M3 4.5A1.5 1.5 0 014.5 3h7A1.5 1.5 0 0113 4.5v5a1.5 1.5 0 01-1.5 1.5H7l-3 2.5V11h.5" />
  </Icon>
);
export const QrIcon = () => (
  <Icon>
    <rect x="2.5" y="2.5" width="4" height="4" rx="0.5" />
    <rect x="9.5" y="2.5" width="4" height="4" rx="0.5" />
    <rect x="2.5" y="9.5" width="4" height="4" rx="0.5" />
    <path d="M9.5 9.5h1.5v1.5M13.5 9.5v1M9.5 13.5h4" />
  </Icon>
);
export const StoreIcon = () => (
  <Icon>
    <path d="M2.5 6.5L3.5 3h9l1 3.5M3 6.5v6.5h10V6.5M2.5 6.5a1.8 1.8 0 003.6 0 1.8 1.8 0 003.8 0 1.8 1.8 0 003.6 0M6.5 13v-3h3v3" />
  </Icon>
);
/// A flag on its pole: the gate a phase has to pass.
export const FlagIcon = () => (
  <Icon>
    <path d="M3.5 14V2.5M3.5 3h8l-1.75 2.75L11.5 8.5h-8" />
  </Icon>
);

/// A page of lines: the record of who did what.
export const AuditIcon = () => (
  <Icon>
    <path d="M4.5 2.5h7a1 1 0 011 1v9a1 1 0 01-1 1h-7a1 1 0 01-1-1v-9a1 1 0 011-1zM6 6h4M6 8.5h4M6 11h2.5" />
  </Icon>
);

/// A bookmark: what the team keeps to remember.
export const MemoryIcon = () => (
  <Icon>
    <path d="M4.5 2.5h7a1 1 0 011 1v10L8 10.2 3.5 13.5v-10a1 1 0 011-1z" />
  </Icon>
);

/// Four tiles: every shop at once.
export const ShopsIcon = () => (
  <Icon>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="0.8" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="0.8" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="0.8" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="0.8" />
  </Icon>
);

/// A page with its corner turned and a few lines: what the team wrote, for the owner to read.
export const DraftIcon = () => (
  <Icon>
    <path d="M4.5 2.5h5l3 3v7.5a1 1 0 01-1 1h-7a1 1 0 01-1-1v-9.5a1 1 0 011-1zM9.5 2.5v3h3M6 8.5h4M6 11h3" />
  </Icon>
);

/// A coin with a baht-like B: what the AI team spends on language models.
export const SpendIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M6.75 5v6M6.75 5h1.75a1.5 1.5 0 010 3H6.75M6.75 8h2a1.5 1.5 0 010 3H6.75" />
  </Icon>
);

/// The viewer's light or dark setting, kept current while the page is open.
export function useColorScheme(): "light" | "dark" {
  const query = "(prefers-color-scheme: dark)";
  const read = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches
      ? "dark"
      : "light";
  const [scheme, setScheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setScheme(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-t", scheme);
  }, [scheme]);
  return scheme;
}
