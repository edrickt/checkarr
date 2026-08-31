import type { ReactNode } from "react";

export function ErrorBanner({ children }: { children: ReactNode }) {
  return <div className="border border-red-300 bg-white px-4 py-3 text-sm text-red-700">{children}</div>;
}
