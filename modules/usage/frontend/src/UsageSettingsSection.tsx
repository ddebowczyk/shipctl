import { useState } from "react";

import { getUsageProviderLogoClass, usageProviderLogoSrc } from "./branding";
import { ALL_USAGE_PROVIDERS } from "./usageHelpers";
import { useUsageSettingsStore } from "./usageSettingsStore";
import type { BudgetMode } from "./types";

export default function UsageSettingsSection() {
  const usageSettings = useUsageSettingsStore((state) => state.settings);
  const usageIsSaving = useUsageSettingsStore((state) => state.isSaving);
  const usageError = useUsageSettingsStore((state) => state.error);
  const updateProvider = useUsageSettingsStore((state) => state.updateProvider);
  const [budgetInputs, setBudgetInputs] = useState<Record<string, string>>({});

  return (
    <section className="settings-section">
      <h2 className="section-label !p-0 settings-section__header">Usage Providers</h2>

      <div className="usage-provider-grid">
        {ALL_USAGE_PROVIDERS.map((provider) => {
          const config = usageSettings[provider];
          const logo = usageProviderLogoSrc[provider];
          const label = provider === "claude"
            ? "Claude"
            : provider === "codex"
              ? "Codex"
              : provider === "antigravity"
                ? "Antigravity"
                : provider === "gemini"
                  ? "Gemini"
                  : provider === "opencode"
                    ? "opencode"
                    : "pi";
          const budgetInput = budgetInputs[provider]
            ?? (config.monthlyBudget != null ? String(config.monthlyBudget) : "");
          return (
            <div key={provider} className="usage-provider-row">
              <span className="usage-provider-row__name">
                {logo && (
                  <img
                    src={logo}
                    alt=""
                    width={18}
                    height={18}
                    className={`shrink-0 ${getUsageProviderLogoClass(provider) ?? ""}`}
                  />
                )}
                <span>{label}</span>
              </span>

              <button
                onClick={() => void updateProvider(provider, { show: !config.show })}
                className={`option-card option-card--compact ${config.show ? "selected" : ""}`}
              >
                {config.show ? "On" : "Off"}
              </button>

              {config.show && (
                <>
                  {(["subscription", "custom"] as BudgetMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => void updateProvider(provider, { budgetMode: mode })}
                      className={`option-card option-card--compact ${config.budgetMode === mode ? "selected" : ""}`}
                    >
                      <span className="capitalize">{mode}</span>
                    </button>
                  ))}

                  {config.budgetMode === "custom" && (
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="decimal"
                      placeholder="$ / month"
                      value={budgetInput}
                      onChange={(event) => setBudgetInputs((previous) => ({
                        ...previous,
                        [provider]: event.target.value,
                      }))}
                      onBlur={() => {
                        const trimmed = budgetInput.trim();
                        const nextBudget = trimmed === "" ? null : Number(trimmed);
                        if (nextBudget == null || Number.isFinite(nextBudget)) {
                          void updateProvider(provider, { monthlyBudget: nextBudget });
                        }
                        setBudgetInputs((previous) => {
                          const next = { ...previous };
                          delete next[provider];
                          return next;
                        });
                      }}
                      className="usage-provider-row__budget-input"
                    />
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {usageIsSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving...</div>}
      {usageError && <div className="mt-2 text-sm text-red-300">{usageError}</div>}

      <p className="text-xs text-[var(--text-muted)] mt-4">
        Settings are saved to ~/.shep/config.yml
      </p>
    </section>
  );
}
