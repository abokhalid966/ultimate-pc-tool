/** An on/off switch with an "On"/"Off" caption, like Windows Settings. */
export function Switch({ checked, onChange, label, disabled, busy }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean; busy?: boolean }) {
  return (
    <label className="switch" title={checked ? "Turn off" : "Turn on"}>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled || busy} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
      <span className="switch-label">{busy ? <span className="spinner" /> : checked ? "On" : "Off"}</span>
    </label>
  );
}
