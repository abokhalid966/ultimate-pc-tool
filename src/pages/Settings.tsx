import { useEffect, useState } from "react";
import { Bell, Cpu, HardDrive, MemoryStick, Monitor, Moon, Palette, PictureInPicture2, Power, ShieldCheck, Sun, Thermometer, X as CloseIcon } from "lucide-react";
import { AlertSettings, api, AppInfo, CloseAction, errorText } from "../api";
import { AppIcon } from "../components/AppIcon";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { Switch } from "../components/Switch";
import { useToast } from "../components/Toast";
import { ThemePref, useThemePref } from "../theme";

type CloseChoice = CloseAction | "ask";

const LIMITS: { key: keyof Omit<AlertSettings, "enabled">; label: string; hint: string; icon: typeof Cpu; options: number[]; unit: string }[] = [
  { key: "cpuPercent", label: "Processor busy", hint: "Over this for two minutes", icon: Cpu, options: [70, 80, 90, 95], unit: "%" },
  { key: "memoryPercent", label: "Memory almost full", hint: "Over this for two minutes", icon: MemoryStick, options: [80, 85, 90, 95], unit: "%" },
  { key: "temperature", label: "Running hot", hint: "Over this for half a minute, when the PC reports a real temperature", icon: Thermometer, options: [75, 80, 85, 90, 95], unit: "°C" },
  { key: "diskFreePercent", label: "Drive almost full", hint: "Less free space than this", icon: HardDrive, options: [5, 10, 15, 20], unit: "%" },
];

const SHORTCUTS: [string[], string][] = [
  [["Ctrl", "Shift", "V"], "Quick paste from your clipboard history, in any app"],
  [["Ctrl", "K"], "Search pages, fixes and apps, or run a command"],
  [["Ctrl", "1…9"], "Go to a page in the sidebar"],
  [["F5"], "Refresh the current page"],
  [["Ctrl", "Shift", "T"], "New terminal tab"],
  [["Delete"], "End the selected process (asks first)"],
];

export function Settings({ appInfo, onRestartAsAdmin }: { appInfo: AppInfo; onRestartAsAdmin: () => void }) {
  const toast = useToast();
  const [theme, setTheme] = useThemePref();
  const [closeChoice, setCloseChoice] = useState<CloseChoice | null>(null);
  const [alerts, setAlerts] = useState<AlertSettings | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [autostart, setAutostart] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setCloseChoice(s.closeAction ?? "ask");
        setAlerts(s.alerts);
        setOverlay(s.overlay);
      })
      .catch(() => setCloseChoice("ask"));
    api
      .getAutostart()
      .then(setAutostart)
      .catch(() => setAutostart(false));
  }, []);

  /** Shows the change at once and puts it back if saving fails. */
  const optimistic = async <T,>(set: (v: T) => void, previous: T, next: T, save: () => Promise<void>) => {
    set(next);
    try {
      await save();
    } catch (e) {
      set(previous);
      toast(errorText(e), "error");
    }
  };

  const changeAlerts = (next: AlertSettings) => alerts && optimistic(setAlerts, alerts, next, () => api.setAlerts(next));

  const changeClose = async (choice: CloseChoice) => {
    const previous = closeChoice;
    setCloseChoice(choice);
    try {
      await api.setCloseAction(choice === "ask" ? null : choice);
    } catch (e) {
      setCloseChoice(previous);
      toast(errorText(e), "error");
    }
  };

  return (
    <div className="page">
      <PageHeader title="Settings" subtitle="Make Optimo work the way you like." />
      <div className="settings">
        <section className="settings-group" aria-labelledby="set-appearance">
          <h2 id="set-appearance" className="section-title">
            Appearance
          </h2>
          <div className="card settings-row">
            <span className="settings-row-icon">
              <Palette size={18} />
            </span>
            <div className="settings-row-text">
              <strong>Theme</strong>
              <span>“Windows setting” follows light or dark mode from Windows Settings &gt; Personalization &gt; Colors.</span>
            </div>
            <Segmented<ThemePref>
              label="Theme"
              value={theme}
              onChange={setTheme}
              options={[
                {
                  value: "system",
                  label: (
                    <>
                      <Monitor size={14} /> Windows setting
                    </>
                  ),
                },
                {
                  value: "light",
                  label: (
                    <>
                      <Sun size={14} /> Light
                    </>
                  ),
                },
                {
                  value: "dark",
                  label: (
                    <>
                      <Moon size={14} /> Dark
                    </>
                  ),
                },
              ]}
            />
          </div>
        </section>

        <section className="settings-group" aria-labelledby="set-general">
          <h2 id="set-general" className="section-title">
            General
          </h2>
          <div className="card settings-row">
            <span className="settings-row-icon">
              <CloseIcon size={18} />
            </span>
            <div className="settings-row-text">
              <strong>When I close the window</strong>
              <span>In the tray, the app keeps showing CPU and memory near the clock. Right-click the tray icon to quit.</span>
            </div>
            <label className="field">
              <span className="visually-hidden">When I close the window</span>
              <select value={closeChoice ?? ""} disabled={closeChoice === null} onChange={(e) => changeClose(e.target.value as CloseChoice)}>
                {closeChoice === null && <option value="">Loading…</option>}
                <option value="tray">Keep running in the tray</option>
                <option value="quit">Quit the app</option>
                <option value="ask">Ask me each time</option>
              </select>
            </label>
          </div>
          <div className="card settings-row">
            <span className="settings-row-icon">
              <Power size={18} />
            </span>
            <div className="settings-row-text">
              <strong>Start with Windows</strong>
              <span>Opens quietly in the tray when you sign in, so alerts and automations keep working.</span>
            </div>
            <Switch
              label="Start with Windows"
              checked={!!autostart}
              busy={autostart === null}
              onChange={(on) => optimistic(setAutostart, autostart, on, () => api.setAutostart(on))}
            />
          </div>
          <div className="card settings-row">
            <span className="settings-row-icon">
              <PictureInPicture2 size={18} />
            </span>
            <div className="settings-row-text">
              <strong>Mini overlay</strong>
              <span>A small box that stays on top of other windows, with CPU, memory, network and temperature. Drag it anywhere.</span>
            </div>
            <Switch label="Mini overlay" checked={overlay} onChange={(on) => optimistic(setOverlay, overlay, on, () => api.setOverlay(on))} />
          </div>
          <div className="card settings-row">
            <span className="settings-row-icon">
              <ShieldCheck size={18} />
            </span>
            <div className="settings-row-text">
              <strong>Administrator rights</strong>
              <span>
                {appInfo.elevated
                  ? "The app is running as administrator, so it can change startup apps for all users. Terminal tabs run as administrator too."
                  : "Only needed to change startup apps that apply to everyone who uses this PC."}
              </span>
            </div>
            {appInfo.elevated ? (
              <span className="pill pill-warn">
                <ShieldCheck size={12} /> Running as administrator
              </span>
            ) : (
              <button className="btn" onClick={onRestartAsAdmin}>
                <ShieldCheck size={16} /> Restart as administrator
              </button>
            )}
          </div>
        </section>

        <section className="settings-group" aria-labelledby="set-alerts">
          <h2 id="set-alerts" className="section-title">
            Alerts
          </h2>
          <div className="card settings-row">
            <span className="settings-row-icon">
              <Bell size={18} />
            </span>
            <div className="settings-row-text">
              <strong>Notify me when something needs attention</strong>
              <span>Windows notifications, at most once every half hour for each alert. Works while Optimo is in the tray.</span>
            </div>
            <Switch label="Alerts" checked={!!alerts?.enabled} busy={!alerts} onChange={(on) => alerts && changeAlerts({ ...alerts, enabled: on })} />
          </div>
          {alerts?.enabled &&
            LIMITS.map(({ key, label, hint, icon: Icon, options, unit }) => (
              <div key={key} className="card settings-row settings-sub">
                <span className="settings-row-icon">
                  <Icon size={18} />
                </span>
                <div className="settings-row-text">
                  <strong>{label}</strong>
                  <span>{hint}</span>
                </div>
                <label className="field">
                  <span className="visually-hidden">{label}</span>
                  <select value={alerts[key]} onChange={(e) => changeAlerts({ ...alerts, [key]: Number(e.target.value) })}>
                    {!options.includes(alerts[key]) && alerts[key] !== 0 && (
                      <option value={alerts[key]}>
                        {alerts[key]}
                        {unit}
                      </option>
                    )}
                    {options.map((o) => (
                      <option key={o} value={o}>
                        {key === "diskFreePercent" ? "Under" : "Over"} {o}
                        {unit}
                      </option>
                    ))}
                    <option value={0}>Don't alert</option>
                  </select>
                </label>
              </div>
            ))}
        </section>

        <section className="settings-group" aria-labelledby="set-keys">
          <h2 id="set-keys" className="section-title">
            Keyboard shortcuts
          </h2>
          <div className="card">
            <dl className="shortcut-list">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={what} style={{ display: "contents" }}>
                  <dt>
                    <span className="kbd-combo">
                      {keys.map((k, i) => (
                        <span key={k}>
                          {i > 0 && "+"}
                          <kbd>{k}</kbd>
                        </span>
                      ))}
                    </span>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="settings-group" aria-labelledby="set-about">
          <h2 id="set-about" className="section-title">
            About
          </h2>
          <div className="card settings-row">
            <AppIcon size={40} />
            <div className="settings-row-text">
              <strong style={{ fontWeight: 600 }}>Optimo</strong>
              <span>{appInfo.version ? `Version ${appInfo.version}` : "Version unknown"} · Monitor, clean up and look after your Windows PC</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
