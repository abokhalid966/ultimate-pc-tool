import { ReactNode } from "react";
import { CircleAlert, LucideIcon, RefreshCw } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  tone?: "neutral" | "danger";
}

/** Friendly placeholder for empty lists, no search results and load errors. */
export function EmptyState({ icon: Icon, title, body, actions, tone = "neutral" }: Props) {
  return (
    <div className={`empty-state tone-${tone}`} role={tone === "danger" ? "alert" : undefined}>
      <div className="empty-state-icon">
        <Icon size={22} />
      </div>
      <div className="empty-state-title">{title}</div>
      {body && <div className="empty-state-body">{body}</div>}
      {actions && <div className="empty-state-actions">{actions}</div>}
    </div>
  );
}

/** "Couldn't load" with the reason and a Retry button. */
export function ErrorState({ what, message, onRetry }: { what: string; message: string; onRetry: () => void }) {
  return (
    <EmptyState
      icon={CircleAlert}
      tone="danger"
      title={`Couldn't load ${what}`}
      body={message}
      actions={
        <button className="btn" onClick={onRetry}>
          <RefreshCw size={16} /> Try again
        </button>
      }
    />
  );
}
