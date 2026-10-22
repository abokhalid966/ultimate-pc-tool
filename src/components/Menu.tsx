import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ellipsis, LucideIcon } from "lucide-react";

export type MenuEntry =
  | {
      label: string;
      icon?: LucideIcon;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      hint?: string;
      title?: string;
    }
  | "separator";

interface Props {
  items: MenuEntry[];
  /** Accessible name of the button, e.g. "More actions for Flush DNS". */
  label: string;
  /** Custom button content; defaults to a ⋯ icon. */
  children?: ReactNode;
  className?: string;
  align?: "start" | "end";
}

/** A button that opens a small list of actions (rendered in a portal so cards never clip it). */
export function Menu({ items, label, children, className = "icon-btn", align = "end" }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return;
    const b = button.current.getBoundingClientRect();
    const m = menu.current.getBoundingClientRect();
    let top = b.bottom + 4;
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, b.top - m.height - 4);
    let left = align === "end" ? b.right - m.width : b.left;
    left = Math.min(Math.max(8, left), window.innerWidth - m.width - 8);
    setPos({ top, left });
    menu.current.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")?.focus();
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Handled here so a dialog underneath stays open.
        e.preventDefault();
        e.stopPropagation();
        close();
        button.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>(".menu-item:not(:disabled)") ?? [])];
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (i + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
    list[next]?.focus();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setPos(null);
          setOpen((o) => !o);
        }}
      >
        {children ?? <Ellipsis size={16} />}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="menu"
            role="menu"
            aria-label={label}
            style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
            onKeyDown={onMenuKey}
          >
            {items.map((item, i) =>
              item === "separator" ? (
                <div key={`sep-${i}`} className="menu-sep" role="separator" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`menu-item ${item.danger ? "danger" : ""}`}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.icon && <item.icon size={16} />}
                  {item.label}
                  {item.hint && <span className="menu-hint">{item.hint}</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
