import { ReactNode } from "react";

interface Props<T extends string> {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  label: string;
}

/** A small set of mutually exclusive choices, e.g. "Apps | All processes". */
export function Segmented<T extends string>({ value, options, onChange, label }: Props<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const i = options.findIndex((x) => x.value === value);
            const next = options[(i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length];
            onChange(next.value);
            const group = e.currentTarget.parentElement;
            requestAnimationFrame(() => (group?.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus());
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
