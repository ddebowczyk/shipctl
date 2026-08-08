import { useState, useSyncExternalStore } from "react";
import type { SettingsContributionProps } from "@shipctl/module-api";

function InfoTip({ text }: { readonly text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span
      className="settings-info-tip"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.4 }}>
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="600">i</text>
      </svg>
      {show && <span className="settings-info-tip__bubble">{text}</span>}
    </span>
  );
}

export default function GitSettingsSection({ services }: SettingsContributionProps) {
  const settings = useSyncExternalStore(
    services.settings.subscribe,
    services.settings.getSnapshot,
  );
  const enabled = settings.values.autoImportWorktrees !== false;

  return (
    <section className="settings-section">
      <h2 className="section-label !p-0 settings-section__header">Git</h2>
      <div className="settings-row !mb-0">
        <span className="settings-row__label flex items-center gap-2">
          <span>Auto-import Worktrees</span>
          <InfoTip text="When enabled, adding a main repo also imports its existing Git worktrees. Adding a worktree directly still adds its main repo so the relationship stays intact." />
        </span>
        <button
          onClick={() => void services.settings.update({ autoImportWorktrees: !enabled })}
          className={`option-card option-card--compact ${enabled ? "selected" : ""}`}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>
    </section>
  );
}
