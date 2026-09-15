import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";

export interface MenuItemSpec {
  key: string;
  label: string;
  /** Muted suffix after the label, usually a count. */
  hint?: string;
  /** One-line explanation rendered under the label. */
  description?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

const ITEM =
  "block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-300 disabled:hover:bg-transparent";

/**
 * The one dropdown pattern (Scan, Delete & re-search, row actions): a trigger
 * button plus a menu that closes on outside click and Escape, navigates with
 * the arrow keys, and returns focus to the trigger.
 *
 * The menu renders through a portal with fixed positioning so ancestors with
 * overflow (e.g. the library table's scroll wrapper) cannot clip it, whatever
 * the row count. It tracks the trigger on scroll/resize and flips above the
 * trigger when there is no room below.
 */
export function DropdownButton({
  label,
  items,
  variant = "default",
  size = "md",
  caret = true,
  disabled,
  title,
  ariaLabel,
  align = "left",
  menuClassName = "w-64",
  className = ""
}: {
  label: ReactNode;
  items: MenuItemSpec[];
  variant?: ButtonVariant;
  size?: ButtonSize;
  caret?: boolean;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  align?: "left" | "right";
  menuClassName?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Place the menu under (or, when out of viewport, above) the trigger using
  // fixed coordinates. Runs in a layout effect so the menu is positioned
  // before first paint and never flashes at the wrong spot.
  const computePos = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const t = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const margin = 8;
    const vh = window.innerHeight;
    const fitsBelow = t.bottom + m.height + margin <= vh;
    const fitsAbove = t.top - m.height - margin >= 0;
    const top =
      !fitsBelow && fitsAbove
        ? Math.max(margin, t.top - m.height - 4)
        : Math.max(margin, Math.min(t.bottom + 4, vh - m.height - margin));
    const maxX = Math.max(margin, window.innerWidth - m.width - margin);
    const left =
      align === "right"
        ? Math.min(Math.max(margin, t.right - m.width), maxX)
        : Math.min(Math.max(margin, t.left), maxX);
    setPos({ top, left });
  }, [align]);

  useLayoutEffect(() => {
    if (open) computePos();
    else setPos(null);
  }, [open, computePos]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: globalThis.MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // Capture phase: also catches scrolls inside the table's scroll wrapper,
    // not just page-level scrolling, so a fixed menu tracks its trigger.
    const onReposition = () => computePos();
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open, computePos]);

  // Opening the menu moves focus into it so keyboard users are not stranded.
  useEffect(() => {
    if (!open) return;
    const first = itemRefs.current.find((el) => el !== null && !el.disabled);
    first?.focus();
  }, [open]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null && !el.disabled);
    if (enabled.length === 0) return;
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % enabled.length;
    else if (e.key === "ArrowUp")
      next = current < 0 ? enabled.length - 1 : (current - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    if (next >= 0) {
      e.preventDefault();
      enabled[next]?.focus();
    }
  };

  return (
    <div ref={rootRef} className={"relative " + className}>
      <Button
        ref={triggerRef}
        variant={variant}
        size={size}
        disabled={disabled}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="inline-flex items-center gap-1.5">
          {label}
          {caret && (
            <span
              aria-hidden="true"
              className={
                "inline-block text-[10px] leading-none transition-transform " + (open ? "rotate-180" : "")
              }
            >
              &#9662;
            </span>
          )}
        </span>
      </Button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={ariaLabel}
            onKeyDown={onMenuKeyDown}
            style={pos ? { top: pos.top, left: pos.left } : undefined}
            className={"fixed z-50 border border-neutral-200 bg-white py-1 shadow-lg " + menuClassName}
          >
            {items.map((item, i) => (
              <button
                key={item.key}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                role="menuitem"
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className={ITEM + (item.danger ? " text-red-600" : "")}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span>{item.label}</span>
                  {item.hint !== undefined && <span className="shrink-0 text-neutral-400">{item.hint}</span>}
                </span>
                {item.description && (
                  <span className="mt-0.5 block text-xs font-normal text-neutral-400">
                    {item.description}
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
