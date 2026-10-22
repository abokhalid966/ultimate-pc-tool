import { ReactNode, useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

/** Open modals, newest last: Escape closes only the top one. */
const stack: number[] = [];
let nextId = 0;

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, footer, wide }: Props) {
  const close = useRef(onClose);
  close.current = onClose;
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const id = ++nextId;
    stack.push(id);
    const previous = document.activeElement as HTMLElement | null;

    // Focus what the dialog asked for (autoFocus), else its first control.
    requestAnimationFrame(() => {
      const el = dialog.current;
      if (el && !el.contains(document.activeElement)) {
        (el.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
      }
    });

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Tab" && dialog.current) {
        // Keep Tab inside the dialog.
        const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      // Something above us (the palette, a menu) already handled this Escape.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(id), 1);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
