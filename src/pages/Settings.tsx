import { useEffect, useState } from "react";
import { Monitor, Moon, Palette, ShieldCheck, Sun, X as CloseIcon } from "lucide-react";
import { api, AppInfo, CloseAction, errorText } from "../api";
import { AppIcon } from "../components/AppIcon";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { useToast } from "../components/Toast";
import { ThemePref, useThemePref } from "../theme";

type CloseChoice = CloseAction | "ask";

const SHORTCUTS: [string[], string][] = [
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

  useEffect(() => {
    api
      .settings()
      .then((s) => setCloseChoice(s.closeAction ?? "ask"))
      .catch(() => setCloseChoice("ask"));
  }, []);

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
      <PageHeader title="Settings" subtitle="Make Ultimate PC Tool work the way you like." />
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
              <strong style={{ fontWeight: 600 }}>Ultimate PC Tool</strong>
              <span>{appInfo.version ? `Version ${appInfo.version}` : "Version unknown"} · Monitor, quick fixes and startup manager for Windows</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
