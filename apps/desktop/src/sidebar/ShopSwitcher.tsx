// The shop switcher in the account row (docs/several-shops.md, "How the desktop shows them"): a person in two or more
// shops picks the one every page shows. The canvas draws no switcher, so this is the desktop's own, and keeps the
// canvas's account row as it is: the row still opens Settings, and a small button at its end opens the list of shops
// above it, the ones the person owns first, each with their role there ("Owner", "Helper") and a tick on the one shown.
// A person in one shop, or none, sees no button. Asks are not part of a switch: Needs you lists every shop's.
//
// The list is a menu of radio items: Up and Down move through it, Home and End jump, Enter or a click chooses, and Escape
// or a click outside closes it, giving the focus back to the button.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../i18n";
import type { ShopRow } from "../lib/protocol";
import { SwitchGlyph } from "./menuIcons";

/** A shop as the list names it: by its own name, or for the person's own shop that the setup left unnamed, "Your shop". */
export const shopLabel = (s: Pick<ShopRow, "name">) => s.name || t("shops.yourShop");

/** The list's rows: each shop, with its role in words, and whether it is the one shown. */
export function shopItems(list: readonly ShopRow[], current: string | null): { id: string; name: string; role: string; current: boolean }[] {
  return list.map((s) => ({ id: s.id, name: shopLabel(s), role: t(s.role === "owner" ? "shops.owner" : "shops.helper"), current: s.id === current }));
}

/** Where a key moves the focus in a list of `n` items from `at`, or null for a key the list does not take. */
export function moveIn(key: string, at: number, n: number): number | null {
  if (key === "ArrowDown") return (at + 1) % n;
  if (key === "ArrowUp") return (at - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}

export function ShopSwitcher({ list, current, onSwitch }: { list: readonly ShopRow[]; current: string | null; onSwitch: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = shopItems(list, current);

  const close = (focus: boolean) => {
    setOpen(false);
    if (focus) button.current?.focus();
  };

  // A click anywhere outside the list closes it, as a menu does.
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  // Opening puts the focus on the shop shown, so Up and Down start from it.
  useEffect(() => {
    if (!open) return;
    const rows = menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]");
    const at = Math.max(0, items.findIndex((i) => i.current));
    rows?.[at]?.focus();
    // the items do not change while the list is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      close(e.key === "Escape");
      return;
    }
    const rows = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? [])];
    const to = moveIn(e.key, Math.max(0, rows.indexOf(document.activeElement as HTMLButtonElement)), rows.length);
    if (to === null) return;
    e.preventDefault();
    rows[to]?.focus();
  };

  if (list.length < 2) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="ib acct-switch"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "shop-menu" : undefined}
        aria-label={t("shops.switch")}
        title={t("shops.switch")}
        onClick={() => setOpen((o) => !o)}
        data-testid="shop-switch"
      >
        <SwitchGlyph />
      </button>
      {open && (
        <div ref={menu} id="shop-menu" className="shop-menu" role="menu" aria-label={t("shops.menu")} onKeyDown={onKey} data-testid="shop-menu">
          {items.map((i) => (
            <button
              key={i.id}
              type="button"
              role="menuitemradio"
              aria-checked={i.current}
              className="shop-item"
              onClick={() => {
                close(true);
                if (!i.current) onSwitch(i.id);
              }}
              data-testid="shop-item"
            >
              <span className="shop-n">{i.name}</span>
              <span className="shop-r">{i.role}</span>
              <span className="shop-tick" aria-hidden="true">
                {i.current ? "✓" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
