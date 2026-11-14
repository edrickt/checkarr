import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { CloseIcon } from "./icons";

interface Toast {
  id: number;
  kind: "success" | "error";
  text: string;
}

const ToastContext = createContext<{ success: (text: string) => void; error: (text: string) => void }>({
  success: () => {},
  error: () => {}
});

/**
 * The one feedback pattern for every mutation result: success toasts auto-
 * dismiss after 6s, error toasts stay until dismissed. Query *load* failures
 * are not toasts - they render as inline error banners where the data belongs.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (kind: Toast["kind"], text: string) => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-4), { id, kind, text }]);
      if (kind === "success") {
        setTimeout(() => dismiss(id), 6000);
      }
    },
    [dismiss]
  );

  const value = {
    success: (text: string) => push("success", text),
    error: (text: string) => push("error", text)
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[70] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={
              "flex items-start gap-3 border border-neutral-200 bg-white px-3 py-2.5 text-sm " +
              "shadow-[0_12px_32px_-16px_rgba(0,0,0,0.35)]"
            }
          >
            <span
              aria-hidden="true"
              className={
                "mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full " +
                (t.kind === "error" ? "bg-red-600" : "bg-emerald-600")
              }
            />
            <span
              className={
                "flex-1 whitespace-pre-wrap " + (t.kind === "error" ? "text-red-700" : "text-neutral-800")
              }
            >
              {t.text}
            </span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="-mr-1 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
            >
              <CloseIcon width={12} height={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
