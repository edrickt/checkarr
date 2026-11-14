import type { ReactNode } from "react";

/** Query-load failure where the data belongs; mutation results use toasts. */
export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
      {children}
    </div>
  );
}
