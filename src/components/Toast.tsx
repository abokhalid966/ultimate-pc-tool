import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

type Kind = "success" | "error" | "info";

interface ToastOptions {
  /** A button in the toast, e.g. Undo. */
  action?: { label: string; run: () => void };
  /** Milliseconds before it hides. Errors stay until closed unless this is set. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  kind: Kind;
  text: string;
}

type Show = (text: string, kind?: Kind, opts?: ToastOptions) => void;

const ToastContext = createContext<Show>(() => {});

export const useToast = () => useContext(ToastContext);

const MAX_VISIBLE = 4;
const ICONS = { success: CircleCheck, error: CircleAlert, info: Info };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback<Show>((text, kind = "info", opts = {}) => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list, { id, kind, text, ...opts }].slice(-MAX_VISIBLE));
  }, []);

  const polite = items.filter((t) => t.kind !== "error");
  const alerts = items.filter((t) => t.kind === "error");

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts">
        <div role="status" aria-live="polite" style={{ display: "contents" }}>
          {polite.map((t) => (
            <ToastView key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>
        <div role="alert" aria-live="assertive" style={{ display: "contents" }}>
          {alerts.map((t) => (
            <ToastView key={t.id} item={t} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item: t, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(t.duration ?? (t.action ? 8000 : t.kind === "error" ? Infinity : 4000));

  // Counts down only while the pointer is away, so a toast never vanishes mid-read.
  useEffect(() => {
    if (paused || !Number.isFinite(remaining.current)) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(t.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, t.id, onDismiss]);

  const Icon = ICONS[t.kind];
  return (
    <div className={`toast toast-${t.kind}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <Icon size={18} className="toast-icon" aria-hidden="true" />
      <span className="toast-text">{t.text}</span>
      <span className="toast-actions">
        {t.action && (
          <button
            className="btn btn-sm"
            onClick={() => {
              onDismiss(t.id);
              t.action!.run();
            }}
          >
            {t.action.label}
          </button>
        )}
        <button className="icon-btn icon-btn-sm" onClick={() => onDismiss(t.id)} aria-label="Dismiss" title="Dismiss">
          <X size={14} />
        </button>
      </span>
    </div>
  );
}
