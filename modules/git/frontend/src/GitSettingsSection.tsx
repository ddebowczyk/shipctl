import { useState } from "react";
import type { SettingsContributionProps } from "@shipctl/module-api";

import {
  DEFAULT_GIT_PREFERENCES,
  updateGitPreferences,
  useGitPreferencesStore,
} from "./gitPreferences.ts";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  const preferences = useGitPreferencesStore((state) => state.preferences);
  const enabled = preferences?.autoImportWorktrees ?? DEFAULT_GIT_PREFERENCES.autoImportWorktrees;

  const update = () => {
    void updateGitPreferences({ autoImportWorktrees: !enabled }).catch((error) => {
      services.notices.push({
        tone: "error",
        title: "Couldn't save Git preferences",
        message: getErrorMessage(error),
      });
    });
  };

  return (
    <section className="settings-section">
      <h2 className="section-label !p-0 settings-section__header">Git</h2>
      <div className="settings-row !mb-0">
        <span className="settings-row__label flex items-center gap-2">
          <span>Auto-import Worktrees</span>
          <InfoTip text="When enabled, adding a main repo also imports its existing Git worktrees. Adding a worktree directly still adds its main repo so the relationship stays intact." />
        </span>
        <button
          onClick={update}
          className={`option-card option-card--compact ${enabled ? "selected" : ""}`}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>
    </section>
  );
}
