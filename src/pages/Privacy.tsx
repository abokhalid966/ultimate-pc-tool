import { useCallback, useEffect, useState } from "react";
import { CircleAlert, PackageX, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { api, BloatApp, errorText, PrivacyTweak } from "../api";
import { useConfirm } from "../components/Confirm";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { Skeleton } from "../components/Skeleton";
import { Switch } from "../components/Switch";
import { useToast } from "../components/Toast";
import { useOnRefresh } from "../hooks/useRefresh";
import "./privacy/privacy.css";

type Tab = "settings" | "apps";
const RESTART_EXPLORER = "Stop-Process -Name explorer -Force; Start-Process explorer";

export function Privacy({ elevated, onRestartAsAdmin }: { elevated: boolean; onRestartAsAdmin: () => void }) {
  const [tab, setTab] = useState<Tab>("settings");
  return (
    <div className="page">
      <PageHeader
        title="Privacy"
        subtitle="Turn off ads, tracking and suggestions, and remove apps that came with Windows. Everything can be undone."
        actions={
          <Segmented
            label="Show"
            value={tab}
            onChange={setTab}
            options={[
              { value: "settings", label: "Privacy settings" },
              { value: "apps", label: "Preinstalled apps" },
            ]}
          />
        }
      />
      {tab === "settings" ? <Tweaks elevated={elevated} onRestartAsAdmin={onRestartAsAdmin} /> : <Bloat />}
    </div>
  );
}

function Tweaks({ elevated, onRestartAsAdmin }: { elevated: boolean; onRestartAsAdmin: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<PrivacyTweak[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [needsExplorer, setNeedsExplorer] = useState(false);

  const load = useCallback(() => {
    api.privacyTweaks().then(setList, (e) => toast(errorText(e), "error"));
  }, [toast]);
  useEffect(load, [load]);
  useOnRefresh(load);

  const apply = (tweaks: PrivacyTweak[], on: boolean, key: string) => {
    setBusy(key);
    api
      .setPrivacyTweaks(
        tweaks.map((t) => t.id),
        on,
      )
      .then((undoId) => {
        if (tweaks.some((t) => t.explorer)) setNeedsExplorer(true);
        const text = tweaks.length === 1 ? (on ? "Done." : "Set back to Windows' default.") : `${tweaks.length} settings changed.`;
        toast(text, "success", undoId ? { action: { label: "Undo", run: () => api.undoActivity(undoId).then(load, (e) => toast(errorText(e), "error")) } } : undefined);
        load();
      })
      .catch((e) => toast(errorText(e), "error"))
      .finally(() => setBusy(null));
  };

  const restartExplorer = () => {
    setNeedsExplorer(false);
    api.runCommand(RESTART_EXPLORER, "powershell", false, "Restart Explorer").catch((e) => toast(errorText(e), "error"));
  };

  if (!list) {
    return (
      <section className="card">
        <Skeleton height={14} />
        <Skeleton height={14} width="70%" style={{ marginTop: 12 }} />
      </section>
    );
  }

  const todo = list.filter((t) => t.recommended && !t.applied && (elevated || !t.admin));
  const groups = [...new Set(list.map((t) => t.group))];

  return (
    <>
      <section className="card privacy-summary">
        <ShieldCheck size={22} className="text-ok" />
        <div>
          <strong>
            {list.filter((t) => t.applied).length} of {list.length} turned on
          </strong>
          <p className="muted small">{todo.length > 0 ? `${todo.length} recommended ${todo.length === 1 ? "setting is" : "settings are"} still off.` : "All recommended settings are on."}</p>
        </div>
        <button className="btn btn-primary" disabled={todo.length === 0 || busy !== null} onClick={() => apply(todo, true, "all")}>
          <Sparkles size={16} /> Apply recommended
        </button>
      </section>
      {needsExplorer && (
        <div className="privacy-hint">
          <span>Some changes show after File Explorer and the taskbar restart (or after you sign out).</span>
          <button className="btn btn-sm" onClick={restartExplorer}>
            <RefreshCw size={14} /> Restart Explorer now
          </button>
        </div>
      )}
      {groups.map((g) => (
        <section key={g} className="card">
          <h3 className="privacy-h">{g}</h3>
          {list
            .filter((t) => t.group === g)
            .map((t) => (
              <div key={t.id} className="privacy-row">
                <div>
                  <div className="privacy-title">
                    {t.title}
                    {t.recommended && <span className="pill pill-sm pill-accent">Recommended</span>}
                    {t.admin && <span className="pill pill-sm pill-outline">Administrator</span>}
                  </div>
                  <p className="muted small">{t.description}</p>
                  {t.admin && !elevated && (
                    <button className="btn btn-sm btn-ghost" onClick={onRestartAsAdmin}>
                      <ShieldCheck size={14} /> Restart as administrator to change this
                    </button>
                  )}
                </div>
                <Switch label={t.title} checked={t.applied} busy={busy === t.id} disabled={busy !== null || (t.admin && !elevated)} onChange={(on) => apply([t], on, t.id)} />
              </div>
            ))}
        </section>
      ))}
    </>
  );
}

function Bloat() {
  const toast = useToast();
  const confirm = useConfirm();
  const [apps, setApps] = useState<BloatApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api.bloatApps().then(
      (list) => {
        setApps(list);
        setPicked((p) => new Set([...p].filter((f) => list.some((a) => a.fullName === f))));
      },
      (e) => setError(errorText(e)),
    );
  }, []);
  useEffect(load, [load]);
  useOnRefresh(load);

  const remove = async () => {
    const targets = apps!.filter((a) => picked.has(a.fullName));
    const ok = await confirm({
      title: `Remove ${targets.length} ${targets.length === 1 ? "app" : "apps"}?`,
      message: (
        <>
          <p>{targets.map((t) => t.label).join(", ")}</p>
          <p className="muted">They're removed for your account. You can install any of them again from the Microsoft Store.</p>
        </>
      ),
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      const results = await api.removeBloatApps(targets.map((t) => ({ fullName: t.fullName, label: t.label })));
      const failed = results.filter((r) => r.error);
      const done = results.length - failed.length;
      if (done > 0) toast(`Removed ${done} ${done === 1 ? "app" : "apps"}.`, "success");
      failed.forEach((f) => toast(`${f.label}: ${f.error}`, "error"));
      setPicked(new Set());
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setRemoving(false);
      load();
    }
  };

  if (error && !apps) {
    return (
      <div className="card">
        <EmptyState icon={CircleAlert} tone="danger" title="Couldn't list the apps" body={error} actions={<button className="btn" onClick={load}>Try again</button>} />
      </div>
    );
  }
  if (!apps) {
    return (
      <section className="card">
        <p className="muted small">Looking for apps that came with Windows...</p>
        <Skeleton height={14} />
      </section>
    );
  }
  if (apps.length === 0) {
    return (
      <div className="card">
        <EmptyState icon={PackageX} title="Nothing to remove" body="None of the usual preinstalled extras are on this PC." />
      </div>
    );
  }

  const recommended = apps.filter((a) => a.recommended);
  const toggle = (f: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(f);
      else next.delete(f);
      return next;
    });

  return (
    <section className="card">
      <div className="privacy-bloat-head">
        <p className="muted small">
          Apps and games that came with Windows. Ones marked <strong>Safe to remove</strong> are rarely used. Removing an app only affects your account.
        </p>
        <button className="btn btn-sm" onClick={() => setPicked(new Set(recommended.map((a) => a.fullName)))} disabled={recommended.length === 0 || removing}>
          Select safe ones
        </button>
        <button className="btn btn-sm btn-danger" onClick={remove} disabled={picked.size === 0 || removing}>
          {removing ? <RefreshCw size={14} className="spin" /> : <PackageX size={14} />} Remove {picked.size > 0 ? picked.size : ""} selected
        </button>
      </div>
      <ul className="privacy-apps">
        {apps.map((a) => (
          <li key={a.fullName}>
            <label className="check">
              <input type="checkbox" checked={picked.has(a.fullName)} disabled={removing} onChange={(e) => toggle(a.fullName, e.target.checked)} />
              <span>{a.label}</span>
            </label>
            {a.recommended && <span className="pill pill-sm pill-ok">Safe to remove</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
