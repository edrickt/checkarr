import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

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
              "border bg-white px-3 py-2 text-sm shadow-md " +
              (t.kind === "error" ? "border-red-300 text-red-700" : "border-neutral-200 text-neutral-700")
            }
          >
            <div className="flex items-start justify-between gap-2">
              <span className="whitespace-pre-wrap">{t.text}</span>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="shrink-0 text-neutral-400 hover:text-neutral-900"
              >
                &times;
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
