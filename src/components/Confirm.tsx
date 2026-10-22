import { createContext, ReactNode, useCallback, useContext, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Modal } from "./Modal";

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** A highlighted warning, e.g. what breaks. */
  warning?: string | null;
  /** Exact text shown in a code box, e.g. the command that will run. */
  code?: string;
  /** Extra line under the title, e.g. an "Opens an administrator prompt" badge. */
  badge?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm>(async () => false);

/** In-app replacement for window.confirm(): resolves true when the user confirms. */
export const useConfirm = () => useContext(ConfirmContext);

interface Request {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const current = useRef<Request | null>(null);

  const confirm = useCallback<Confirm>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        // A newer question replaces an unanswered one, which counts as Cancel.
        current.current?.resolve(false);
        current.current = { opts, resolve };
        setRequest(current.current);
      }),
    [],
  );

  const finish = (ok: boolean) => {
    const r = current.current;
    current.current = null;
    setRequest(null);
    r?.resolve(ok);
  };

  const o = request?.opts;
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {o && (
        <Modal
          title={o.title}
          onClose={() => finish(false)}
          footer={
            <>
              {/* Cancel has focus, so a stray Enter never confirms. */}
              <button className="btn" autoFocus onClick={() => finish(false)}>
                Cancel
              </button>
              <button className={`btn ${o.danger ? "btn-danger" : "btn-primary"}`} onClick={() => finish(true)}>
                {o.confirmLabel ?? "OK"}
              </button>
            </>
          }
        >
          <div className="confirm-body">
            {o.badge}
            {o.message && <div>{o.message}</div>}
            {o.warning && (
              <div className="note note-warn">
                <TriangleAlert size={16} />
                <span>{o.warning}</span>
              </div>
            )}
            {o.code && <code className="cmd-code wrap-code">{o.code}</code>}
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}
