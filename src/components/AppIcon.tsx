/** The app's mark: a gauge in a blue squircle. Same artwork as src-tauri/icons/app-icon.svg, which the window, taskbar and tray icons are generated from. */
export function AppIcon({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="app-icon-bg" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3aa0ff" />
          <stop offset="1" stopColor="#0a4fb0" />
        </linearGradient>
        <linearGradient id="app-icon-arc" x1="18" y1="44" x2="46" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#c8f1ff" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#app-icon-bg)" />
      <rect x="2.5" y="2.5" width="59" height="59" rx="14.5" fill="none" stroke="#ffffff" strokeOpacity="0.18" />
      <path d="M20.69 46.31 A16 16 0 1 1 43.31 46.31" fill="none" stroke="#ffffff" strokeOpacity="0.28" strokeWidth="5.5" strokeLinecap="round" />
      <path d="M20.69 46.31 A16 16 0 1 1 44.94 25.6" fill="none" stroke="url(#app-icon-arc)" strokeWidth="5.5" strokeLinecap="round" />
      <path d="M32 35 L40.1 29.1" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" />
      <circle cx="32" cy="35" r="4.2" fill="#ffffff" />
    </svg>
  );
}
