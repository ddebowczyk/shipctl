import { useEffect, useMemo, useRef, useState } from "react";
import { Upload, ChevronDown, Check } from "lucide-react";
import { EDITOR_OPTIONS } from "../settings/index.ts";
import { DARK_THEMES, LIGHT_THEMES, TRANSPARENT_THEMES } from "../appearance/index.ts";
import { KEYBINDING_PRESETS } from "../terminal-host/index.ts";
import { useEditorStore } from "../settings/index.ts";
import { useThemeStore } from "../appearance/index.ts";
import { useKeybindingStore } from "../terminal-host/index.ts";
import { useProjectSettingsStore } from "../projects/index.ts";
import { useRepoStore } from "../projects/index.ts";
import {
  formatRetentionBudget,
  RETENTION_PRESET_BYTES,
  useTerminalSettingsStore,
} from "../terminal-host/index.ts";
import { useCanvasAdapterRuntime } from "./canvasAdapterRuntime.tsx";
import {
  FONT_SIZE_OPTIONS,
  TERMINAL_FONT_FAMILY,
} from "../appearance/index.ts";
import type { CursorStyle } from "@shipctl/core/configuration";
import type { FontFamily } from "../platform/index.ts";
import { getDesktopAppMetadata, getErrorMessage } from "../platform/index.ts";
import { listMonospaceFamilies } from "../platform/index.ts";
import {
  ModuleSettingsSurfaces,
} from "../host/views.ts";

interface AppMeta {
  name: string;
  version: string;
  identifier: string;
  tauriVersion: string;
}

function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="settings-info-tip" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.4 }}>
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <text x="8" y="12" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="600">i</text>
      </svg>
      {show && <span className="settings-info-tip__bubble">{text}</span>}
    </span>
  );
}

export default function SettingsPanel() {
  const optionClass = "option-card w-44 justify-start";
  const canvasAdapterId = useCanvasAdapterRuntime();
  const [appMeta, setAppMeta] = useState<AppMeta | null>(null);
  const [appMetaError, setAppMetaError] = useState<string | null>(null);
  const [fontFamilies, setFontFamilies] = useState<FontFamily[]>([]);
  const [fontError, setFontError] = useState<string | null>(null);
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [fontSearch, setFontSearch] = useState("");
  const fontPickerRef = useRef<HTMLDivElement>(null);
  const fontSearchRef = useRef<HTMLInputElement>(null);
  const [themeError, setThemeError] = useState<string | null>(null);
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const customTheme = useThemeStore((s) => s.customTheme);
  const importTheme = useThemeStore((s) => s.importTheme);
  const themeFileInputRef = useRef<HTMLInputElement | null>(null);
  const settings = useEditorStore((s) => s.settings);
  const hasLoaded = useEditorStore((s) => s.hasLoaded);
  const isSaving = useEditorStore((s) => s.isSaving);
  const error = useEditorStore((s) => s.error);
  const loadSettings = useEditorStore((s) => s.loadSettings);
  const setPreferredEditor = useEditorStore((s) => s.setPreferredEditor);

  const kbSettings = useKeybindingStore((s) => s.settings);
  const kbHasLoaded = useKeybindingStore((s) => s.hasLoaded);
  const kbIsSaving = useKeybindingStore((s) => s.isSaving);
  const kbError = useKeybindingStore((s) => s.error);
  const loadKbSettings = useKeybindingStore((s) => s.loadSettings);
  const setKbEnabled = useKeybindingStore((s) => s.setEnabled);

  const projectSettings = useProjectSettingsStore((s) => s.settings);
  const projectHasLoaded = useProjectSettingsStore((s) => s.hasLoaded);
  const projectIsSaving = useProjectSettingsStore((s) => s.isSaving);
  const projectError = useProjectSettingsStore((s) => s.error);
  const loadProjectSettings = useProjectSettingsStore((s) => s.loadSettings);
  const updateProjectSettings = useProjectSettingsStore((s) => s.updateSettings);
  const repos = useRepoStore((s) => s.repos);
  const moduleProjectPaths = useMemo(() => repos.map((repo) => repo.path), [repos]);

  const termSettings = useTerminalSettingsStore((s) => s.settings);
  const termHasLoaded = useTerminalSettingsStore((s) => s.hasLoaded);
  const termIsSaving = useTerminalSettingsStore((s) => s.isSaving);
  const termError = useTerminalSettingsStore((s) => s.error);
  const loadTermSettings = useTerminalSettingsStore((s) => s.loadSettings);
  const updateTermSettings = useTerminalSettingsStore((s) => s.updateSettings);

  useEffect(() => {
    if (!hasLoaded) void loadSettings();
    if (!projectHasLoaded) void loadProjectSettings();
    if (!kbHasLoaded) void loadKbSettings();
    if (!termHasLoaded) void loadTermSettings();
  }, [hasLoaded, loadSettings, projectHasLoaded, loadProjectSettings, kbHasLoaded, loadKbSettings, termHasLoaded, loadTermSettings]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const metadata = await getDesktopAppMetadata();

        if (!cancelled) {
          setAppMeta(metadata);
          setAppMetaError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setAppMeta(null);
          setAppMetaError(getErrorMessage(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void listMonospaceFamilies()
      .then((families) => {
        if (!cancelled) {
          setFontFamilies(families);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setFontError(getErrorMessage(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Close the font picker on outside click / Escape.
  useEffect(() => {
    if (!fontPickerOpen) return;

    const onMouseDown = (event: MouseEvent) => {
      if (!fontPickerRef.current) return;
      if (!fontPickerRef.current.contains(event.target as Node)) {
        setFontPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFontPickerOpen(false);
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [fontPickerOpen]);


  // Assemble the searchable list: always surface the bundled MesloLGS NF
  // (the default) even if CoreText didn't return it as a system-installed
  // family, then append everything from Rust. Dedupe by family name.
  const pickerFamilies = useMemo(() => {
    const seen = new Set<string>();
    const list: FontFamily[] = [];
    const bundled: FontFamily = {
      family: TERMINAL_FONT_FAMILY,
      faceCount: 4,
      isNerdFont: true,
    };
    list.push(bundled);
    seen.add(TERMINAL_FONT_FAMILY);
    for (const family of fontFamilies) {
      if (seen.has(family.family)) continue;
      seen.add(family.family);
      list.push(family);
    }
    return list;
  }, [fontFamilies]);

  const filteredFontFamilies = useMemo(() => {
    const query = fontSearch.trim().toLowerCase();
    if (!query) return pickerFamilies;
    return pickerFamilies.filter((family) =>
      family.family.toLowerCase().includes(query),
    );
  }, [pickerFamilies, fontSearch]);

  const selectFont = (family: string) => {
    setFontPickerOpen(false);
    setFontSearch("");
    void updateTermSettings({ fontFamily: family });
  };

  const importThemeFile = async (file: File | null) => {
    if (!file) return;

    try {
      const source = await file.text();
      await importTheme(source);
      setThemeError(null);
    } catch (error) {
      setThemeError(getErrorMessage(error));
    }
  };

  return (
    <div className="absolute inset-0 overflow-y-auto pt-3 pb-6">
      {/* ── Theme ──────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Theme</h2>

        <div className="flex flex-wrap gap-3">
          {[...DARK_THEMES, ...LIGHT_THEMES, ...TRANSPARENT_THEMES].map((t) => {
            const active = t.id === themeId;
            return (
              <button
                key={t.id}
                onClick={() => {
                  void setTheme(t.id).then(
                    () => setThemeError(null),
                    (error) => setThemeError(getErrorMessage(error)),
                  );
                }}
                className={`${optionClass} ${active ? "selected" : ""}`}
              >
                <div
                  className="shrink-0 rounded-full"
                  style={{
                    width: 24,
                    height: 24,
                    background: `linear-gradient(135deg, ${t.bgRadial1} 0%, ${t.bgLinearMid} 50%, ${t.bgRadial3} 100%)`,
                  }}
                />
                <span>{t.name}</span>
              </button>
            );
          })}
        </div>

        <div className="settings-row !mb-0 mt-2">
          <span className="settings-row__label flex items-center gap-2">
            <span>Custom Theme</span>
            <InfoTip text={"Ghostty-style file: background and foreground, plus palette entries 0 through 15. Download examples from terminalcolors.com/themes/."} />
          </span>
          <div className="flex flex-wrap gap-2">
            {customTheme && (
              <button
                onClick={() => {
                  void setTheme(customTheme.id).then(
                    () => setThemeError(null),
                    (error) => setThemeError(getErrorMessage(error)),
                  );
                }}
                className={`option-card option-card--compact ${themeId === customTheme.id ? "selected" : ""}`}
              >
                <div
                  className="shrink-0 rounded-full"
                  style={{
                    width: 18,
                    height: 18,
                    background: `linear-gradient(135deg, ${customTheme.bgRadial1} 0%, ${customTheme.bgLinearMid} 50%, ${customTheme.bgRadial3} 100%)`,
                  }}
                />
                <span>Custom</span>
              </button>
            )}
            <button
              onClick={() => {
                setThemeError(null);
                themeFileInputRef.current?.click();
              }}
              className="option-card option-card--compact"
            >
              <span className="flex items-center gap-2">
                <Upload size={14} />
                <span>{customTheme ? "Update Theme" : "Import Theme"}</span>
              </span>
            </button>
            <input
              ref={themeFileInputRef}
              type="file"
              accept=".txt,.conf,.theme,.config"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                void importThemeFile(file);
                event.currentTarget.value = "";
              }}
            />
          </div>
          {themeError && <div className="mt-2 text-sm text-red-300">{themeError}</div>}
        </div>
      </section>

      {/* ── Editor ─────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Editor</h2>

        <div className="flex flex-wrap gap-3">
          {EDITOR_OPTIONS.map((option) => {
            const active = option.id === settings.preferredEditor;
            return (
              <button
                key={option.id}
                onClick={() => void setPreferredEditor(option.id)}
                className={`${optionClass} ${active ? "selected" : ""}`}
              >
                <img
                  src={option.logoSrc}
                  alt=""
                  width={20}
                  height={20}
                  className={`shrink-0 ${option.logoClassName ?? ""}`}
                />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>

        {isSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving...</div>}
        {error && <div className="mt-2 text-sm text-red-300">{error}</div>}
      </section>

      {/* ── Keybindings ────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Keybindings</h2>

        <div className="flex flex-wrap gap-3">
          {KEYBINDING_PRESETS.map((preset) => {
            const active = kbSettings[preset.id];
            return (
              <button
                key={preset.id}
                onClick={() => void setKbEnabled(preset.id, !active)}
                className={`keybinding-card ${active ? "selected" : ""}`}
              >
                <span className="keybinding-card__keys">
                  {preset.keys.map((k, i) => (
                    <kbd key={i} className="keybinding-kbd">{k}</kbd>
                  ))}
                </span>
                <span className="keybinding-card__action">{preset.action}</span>
              </button>
            );
          })}
        </div>

        {kbIsSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving keybindings...</div>}
        {kbError && <div className="mt-2 text-sm text-red-300">{kbError}</div>}
      </section>

      {/* ── Projects ───────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Projects</h2>

        <div className="settings-row">
          <span className="settings-row__label flex items-center gap-2">
            <span>Agent Sessions in Sidebar</span>
            <InfoTip text="Shows the global agent session section above Projects. Project tabs and agent sessions remain available inside each project when this is off." />
          </span>
          <button
            onClick={() => void updateProjectSettings({ showAgentSessionsInSidebar: !projectSettings.showAgentSessionsInSidebar })}
            className={`option-card option-card--compact ${projectSettings.showAgentSessionsInSidebar ? "selected" : ""}`}
          >
            {projectSettings.showAgentSessionsInSidebar ? "On" : "Off"}
          </button>
        </div>

        {projectIsSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving project settings...</div>}
        {projectError && <div className="mt-2 text-sm text-red-300">{projectError}</div>}
      </section>

      <ModuleSettingsSurfaces projectPaths={moduleProjectPaths} slot="projects.after" />

      {/* ── Terminal ───────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Terminal</h2>

        <div className="settings-row">
          <span className="settings-row__label">Cursor</span>
          <div className="flex flex-wrap gap-2">
            {(["block", "underline", "bar"] as const).map((style) => (
              <button
                key={style}
                onClick={() => void updateTermSettings({ cursorStyle: style as CursorStyle })}
                className={`option-card option-card--compact ${termSettings.cursorStyle === style ? "selected" : ""}`}
              >
                <span className="capitalize">{style}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <span className="settings-row__label">Blink</span>
          <button
            onClick={() => void updateTermSettings({ cursorBlink: !termSettings.cursorBlink })}
            className={`option-card option-card--compact ${termSettings.cursorBlink ? "selected" : ""}`}
          >
            {termSettings.cursorBlink ? "On" : "Off"}
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-row__label flex items-center gap-2">
            <span>Font</span>
            <InfoTip text="Lists every installed monospace font on your Mac. Nerd Font variants are surfaced first — they're the best choice for powerline prompts and devicons." />
          </span>
          <div className="relative" ref={fontPickerRef}>
            <button
              type="button"
              onClick={() => {
                setFontPickerOpen((open) => {
                  const next = !open;
                  if (next) {
                    setFontSearch("");
                    // Autofocus the search input once the dropdown mounts.
                    window.setTimeout(() => fontSearchRef.current?.focus(), 0);
                  }
                  return next;
                });
              }}
              className="option-card option-card--compact justify-between"
              style={{ minWidth: 240 }}
            >
              <span className="truncate">{termSettings.fontFamily || "Select font"}</span>
              <ChevronDown size={14} className="shrink-0 opacity-60" />
            </button>

            {fontPickerOpen && (
              <div className="font-picker-dropdown">
                <input
                  ref={fontSearchRef}
                  type="text"
                  value={fontSearch}
                  onChange={(event) => setFontSearch(event.target.value)}
                  placeholder="Search installed fonts..."
                  className="font-picker-search"
                />
                <div className="font-picker-list">
                  {filteredFontFamilies.length === 0 && (
                    <div className="font-picker-empty">No matching fonts</div>
                  )}
                  {filteredFontFamilies.map((family) => {
                    const active = termSettings.fontFamily === family.family;
                    return (
                      <button
                        key={family.family}
                        type="button"
                        onClick={() => selectFont(family.family)}
                        className={`font-picker-item ${active ? "font-picker-item--active" : ""}`}
                      >
                        <Check
                          size={14}
                          className={`shrink-0 ${active ? "opacity-100" : "opacity-0"}`}
                        />
                        <span className="font-picker-item__name">{family.family}</span>
                        {family.isNerdFont && (
                          <span className="font-picker-item__badge">Nerd Font</span>
                        )}
                        <span className="font-picker-item__count">
                          {family.faceCount} {family.faceCount === 1 ? "face" : "faces"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {fontError && <div className="mt-2 text-sm text-red-300">{fontError}</div>}
        </div>

        <div className="settings-row">
          <span className="settings-row__label">Font Size</span>
          <div className="flex flex-wrap gap-2">
            {FONT_SIZE_OPTIONS.map((size) => (
              <button
                key={size}
                onClick={() => void updateTermSettings({ fontSize: size })}
                className={`option-card option-card--compact ${termSettings.fontSize === size ? "selected" : ""}`}
              >
                {size}px
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row !mb-0">
          <span className="settings-row__label">
            History
            <InfoTip text="Memory each terminal may use for scrollback history. The terminal keeps as much history as fits, so the number of lines depends on how wide the output is. Applies to terminals started after the change." />
          </span>
          <div className="flex flex-wrap gap-2">
            {RETENTION_PRESET_BYTES.map((value) => (
              <button
                key={value}
                onClick={() => void updateTermSettings({ scrollbackBytes: value })}
                className={`option-card option-card--compact ${termSettings.scrollbackBytes === value ? "selected" : ""}`}
              >
                {formatRetentionBudget(value)}
              </button>
            ))}
          </div>
        </div>

        {termIsSaving && <div className="mt-2 text-xs text-[var(--text-muted)]">Saving terminal settings...</div>}
        {termError && <div className="mt-2 text-sm text-red-300">{termError}</div>}
      </section>

      <ModuleSettingsSurfaces projectPaths={moduleProjectPaths} slot="terminal.after" />

      {/* ── Canvas ─────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Canvas</h2>

        <div className="settings-row !mb-0">
          <span className="settings-row__label">Main canvas</span>
          <code className="text-sm text-[var(--text-secondary)]">{canvasAdapterId}</code>
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-3 max-w-lg leading-5">
          Shipctl reads <code>ui.canvas</code> from global configuration when it starts.
          Change it there, then restart Shipctl to use another canvas adapter.
        </p>
      </section>

      {/* ── Updates ─────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">Updates</h2>
        <p className="text-sm text-[var(--text-secondary)] max-w-lg leading-6">
          Homebrew manages Shipctl updates. Quit Shipctl, then run these commands in Terminal.
        </p>
        <pre className="mt-3 rounded-md bg-[var(--bg-secondary)] p-3 text-xs text-[var(--text-primary)] overflow-x-auto"><code>brew update{"\n"}brew outdated --cask shipctl{"\n"}brew upgrade --cask shipctl</code></pre>
        <p className="text-xs text-[var(--text-muted)] mt-3 max-w-lg leading-5">
          Shipctl does not download or replace its own application bundle.
        </p>
      </section>

      {/* ── About ───────────────────────────────────────────── */}
      <section className="settings-section">
        <h2 className="section-label !p-0 settings-section__header">About</h2>

        {appMeta ? (
          <div className="settings-meta-grid">
            <div className="settings-meta-row">
              <span className="settings-meta-row__label">App</span>
              <span>{appMeta.name}</span>
            </div>
            <div className="settings-meta-row">
              <span className="settings-meta-row__label">Version</span>
              <span>{appMeta.version}</span>
            </div>
            <div className="settings-meta-row">
              <span className="settings-meta-row__label">Identifier</span>
              <span>{appMeta.identifier}</span>
            </div>
            <div className="settings-meta-row">
              <span className="settings-meta-row__label">Tauri</span>
              <span>{appMeta.tauriVersion}</span>
            </div>
          </div>
        ) : appMetaError ? (
          <div className="mt-2 text-sm text-red-300">{appMetaError}</div>
        ) : (
          <div className="mt-2 text-xs text-[var(--text-muted)]">Loading app info...</div>
        )}

        <p className="text-xs text-[var(--text-muted)] mt-4 max-w-lg leading-5">
          For tester reports, include the app version, what you were doing, and whether the issue happened in a packaged build or dev mode.
        </p>
      </section>
    </div>
  );
}
