import { useState } from "react";
import { ClipboardList, Copy, Pin, PinOff, Trash2 } from "lucide-react";
import { api, ClipboardSettings, errorText } from "../api";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { SearchBox } from "../components/SearchBox";
import { Skeleton } from "../components/Skeleton";
import { Switch } from "../components/Switch";
import { useToast } from "../components/Toast";
import { relativeTime } from "../format";
import { filterClips, useClipboard } from "../hooks/useClipboard";
import "./clipboard/clipboard.css";

export function Clipboard() {
  const toast = useToast();
  const { items, settings, setSettings } = useClipboard();
  const [query, setQuery] = useState("");
  const shown = filterClips(items ?? [], query);

  const save = (next: ClipboardSettings) => {
    const before = settings;
    setSettings(next);
    api.setClipboardSettings(next).catch((e) => {
      setSettings(before);
      toast(errorText(e), "error");
    });
  };
  const run = (p: Promise<void>, done?: string) => p.then(() => done && toast(done, "success", { duration: 2000 }), (e) => toast(errorText(e), "error"));

  return (
    <div className="page">
      <PageHeader
        title="Clipboard"
        subtitle="Everything you copy, ready to paste again. In any app, press Ctrl+Shift+V to search and paste."
        actions={
          <button className="btn" onClick={() => run(api.clipboardClear(), "Cleared. Pinned items were kept.")} disabled={!items?.some((i) => !i.pinned)}>
            <Trash2 size={16} /> Clear history
          </button>
        }
      />
      {settings && (
        <section className="card clip-settings">
          <div className="clip-setting">
            <div>
              <strong>Save what I copy</strong>
              <p className="muted small">Kept only while Optimo runs. Pinned items are saved on this PC. Passwords copied from password managers are skipped.</p>
            </div>
            <Switch label="Save what I copy" checked={settings.enabled} onChange={(enabled) => save({ ...settings, enabled })} />
          </div>
          <div className="clip-setting">
            <div>
              <strong>Quick paste with Ctrl+Shift+V</strong>
              <p className="muted small">Opens a small search box wherever you are. Pick an item and press Enter to paste it.</p>
            </div>
            <Switch label="Quick paste with Ctrl+Shift+V" checked={settings.shortcut} onChange={(shortcut) => save({ ...settings, shortcut })} />
          </div>
        </section>
      )}
      <div className="clip-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="Search what you copied" />
        {items && <span className="muted small">{items.length} saved</span>}
      </div>
      {!items ? (
        <section className="card">
          <Skeleton height={14} />
        </section>
      ) : shown.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={ClipboardList}
            title={items.length ? "Nothing matches your search" : "Nothing copied yet"}
            body={items.length ? "Try other words." : "Copy some text in any app (Ctrl+C) and it shows up here."}
          />
        </div>
      ) : (
        <ul className="clip-items">
          {shown.map((c) => (
            <li key={c.id} className={`card ${c.pinned ? "pinned" : ""}`}>
              <button className="clip-body" onClick={() => run(api.clipboardCopy(c.id), "Copied. Press Ctrl+V to paste it.")} title="Copy">
                <span className="clip-preview">{c.text.trim().slice(0, 1200)}</span>
                <span className="muted small">
                  {c.pinned && "Pinned · "}
                  {relativeTime(new Date(c.at))} · {c.text.length.toLocaleString()} characters
                </span>
              </button>
              <div className="clip-actions">
                <button className="btn btn-sm" onClick={() => run(api.clipboardCopy(c.id), "Copied. Press Ctrl+V to paste it.")}>
                  <Copy size={14} /> Copy
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => run(api.clipboardPin(c.id, !c.pinned))} title={c.pinned ? "Unpin" : "Pin: keep it, even after a restart"}>
                  {c.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => run(api.clipboardDelete(c.id))} title="Remove">
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
