import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Nested modals must not all react to one Escape press (a confirm dialog on
 * top of the detail modal would otherwise close both), so every modal
 * registers on a stack and only the topmost one handles Escape and Tab.
 */
const modalStack: symbol[] = [];

export function Modal({
  onClose,
  children,
  ariaLabel,
  panelClassName = "max-w-3xl"
}: {
  onClose: () => void;
  children: ReactNode;
  ariaLabel: string;
  panelClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  const idRef = useRef<symbol | null>(null);
  useEffect(() => {
    const id = Symbol("modal");
    idRef.current = id;
    modalStack.push(id);
    return () => {
      const idx = modalStack.indexOf(id);
      if (idx >= 0) modalStack.splice(idx, 1);
      idRef.current = null;
    };
  }, []);

  // Focus the first control on open and restore focus to the opener on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== idRef.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/40 p-4"
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={
          "max-h-[90vh] w-full overflow-y-auto border border-neutral-200 bg-white p-5 shadow-[0_24px_64px_-24px_rgba(0,0,0,0.4)] focus:outline-none " +
          panelClassName
        }
      >
        {children}
      </div>
    </div>
  );
}
