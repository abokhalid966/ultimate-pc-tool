import { useRef } from "react";
import { Search, X } from "lucide-react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
}

/** Search field with a clear button; Escape clears it. */
export function SearchBox({ value, onChange, placeholder, label }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <label className="search">
      <Search size={16} />
      <input
        ref={input}
        type="search"
        aria-label={label ?? placeholder}
        placeholder={placeholder}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
          aria-label="Clear search"
          title="Clear search"
        >
          <X size={14} />
        </button>
      )}
    </label>
  );
}
