import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type ActiveRequest = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

/**
 * The one confirmation pattern for destructive and slow actions. Await the
 * promise; it resolves false when the dialog is dismissed (Cancel, Escape,
 * backdrop). Focus lands on Cancel so Enter can never confirm by accident.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ActiveRequest | null>(null);

  const confirm = useCallback(
    (o: ConfirmOptions) => new Promise<boolean>((resolve) => setRequest({ ...o, resolve })),
    []
  );

  const settle = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <Modal ariaLabel={request.title} onClose={() => settle(false)} panelClassName="max-w-md">
          <h2 className="text-base font-semibold text-neutral-900">{request.title}</h2>
          <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-600">{request.body}</div>
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => settle(false)}>Cancel</Button>
            <Button variant={request.danger ? "danger" : "primary"} onClick={() => settle(true)}>
              {request.confirmLabel ?? "Confirm"}
            </Button>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmContext);
}
