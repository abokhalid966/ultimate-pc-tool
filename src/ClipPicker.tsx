import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ClipboardList, Pin } from "lucide-react";
import { api, errorText } from "./api";
import { relativeTime } from "./format";
import { filterClips, useClipboard } from "./hooks/useClipboard";
import { applyTheme, getThemePref } from "./theme";
import "./clip.css";

/** The quick paste window (Ctrl+Shift+V): type to search, Enter pastes into the app you were in. */
export function ClipPicker() {
  const { items, load } = useClipboard();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    document.documentElement.classList.add("clip-doc");
    const onStorage = () => applyTheme(getThemePref());
    window.addEventListener("storage", onStorage);
    const unlisten = listen("clip://opened", () => {
      setQuery("");
      setIndex(0);
      setError(null);
      load();
      input.current?.focus();
    });
    input.current?.focus();
    return () => {
      window.removeEventListener("storage", onStorage);
      unlisten.then((f) => f());
    };
  }, [load]);

  const shown = filterClips(items ?? [], query);
  const paste = (id: string) => api.clipboardPaste(id).catch((e) => setError(errorText(e)));

  useEffect(() => {
    list.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && shown[index]) {
      e.preventDefault();
      paste(shown[index].id);
    } else if (e.key === "Escape") {
      api.hideClipPicker().catch(() => {});
    }
  };

  return (
    <div className="clip" onKeyDown={onKey}>
      <div className="clip-search">
        <ClipboardList size={17} />
        <input
          ref={input}
          value={query}
          placeholder="Search what you copied"
          aria-label="Search what you copied"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
        />
      </div>
      {error && <div className="clip-error">{error}</div>}
      {shown.length === 0 ? (
        <div className="clip-empty">{items && items.length > 0 ? "Nothing matches your search." : "Nothing copied yet. Copy some text and it shows up here."}</div>
      ) : (
        <ul className="clip-list" ref={list} role="listbox" aria-label="Clipboard history">
          {shown.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === index} className={i === index ? "active" : undefined} onMouseEnter={() => setIndex(i)} onClick={() => paste(c.id)}>
              <span className="clip-text">{c.text.trim().slice(0, 400)}</span>
              <span className="clip-meta">
                {c.pinned && <Pin size={12} />}
                {relativeTime(new Date(c.at))}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="clip-foot">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> choose · <kbd>Enter</kbd> paste · <kbd>Esc</kbd> close
        </span>
        <button className="clip-link" onClick={() => api.showMain().catch(() => {})}>
          Open Optimo
        </button>
      </div>
    </div>
  );
}
