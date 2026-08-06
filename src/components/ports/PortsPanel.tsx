import { useCallback, useEffect, useState } from "react";
import { RefreshCcw, Skull, ExternalLink, Folder } from "lucide-react";
import { listListeningPorts, killPort, openUrl } from "../../lib/tauri";
import { useNoticeStore } from "../../stores/useNoticeStore";
import { getErrorMessage } from "../../lib/errors";
import type { PortInfo } from "../../lib/types";

export function formatMemory(kb: number): string {
  if (kb === 0) return "—";
  if (kb < 1024) return `${kb} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export function formatUptime(raw: string): string {
  if (!raw) return "—";
  return raw.trim();
}

export function groupPortsByProject(ports: readonly PortInfo[]): Record<string, PortInfo[]> {
  return ports.reduce<Record<string, PortInfo[]>>((groups, port) => {
    const key = port.project || "Other";
    (groups[key] ??= []).push(port);
    return groups;
  }, {});
}

export function sortPortGroupKeys(groups: Readonly<Record<string, readonly PortInfo[]>>): string[] {
  return Object.keys(groups).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });
}

export type PortScanResult =
  | { readonly status: "ready"; readonly ports: readonly PortInfo[] }
  | { readonly status: "error"; readonly message: string };

export async function scanPorts(
  scan: () => Promise<PortInfo[]> = listListeningPorts,
): Promise<PortScanResult> {
  try {
    return { status: "ready", ports: await scan() };
  } catch (error) {
    return { status: "error", message: getErrorMessage(error) };
  }
}

export type StopPortResult =
  | {
      readonly status: "stopped";
      readonly notice: {
        readonly tone: "success";
        readonly title: "Process killed";
        readonly message: string;
      };
    }
  | {
      readonly status: "error";
      readonly notice: {
        readonly tone: "error";
        readonly title: "Kill failed";
        readonly message: string;
      };
    };

export async function stopPort(
  port: PortInfo,
  stop: (pid: number) => Promise<void> = killPort,
): Promise<StopPortResult> {
  try {
    await stop(port.pid);
    return {
      status: "stopped",
      notice: {
        tone: "success",
        title: "Process killed",
        message: `Stopped ${port.process} (pid ${port.pid}) on port ${port.port}`,
      },
    };
  } catch (error) {
    return {
      status: "error",
      notice: {
        tone: "error",
        title: "Kill failed",
        message: getErrorMessage(error),
      },
    };
  }
}

export default function PortsPanel() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<Set<number>>(new Set());
  const pushNotice = useNoticeStore((s) => s.pushNotice);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await scanPorts();
    if (result.status === "ready") {
      setPorts([...result.ports]);
    } else {
      setError(result.message);
      if (import.meta.env.DEV) console.error("Port scan failed:", result.message);
    }
    setLoading(false);
  }, []);

  // Load once when panel mounts
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleKill = useCallback(async (port: PortInfo) => {
    setKilling((prev) => new Set(prev).add(port.pid));
    try {
      const result = await stopPort(port);
      pushNotice(result.notice);
      if (result.status === "stopped") {
        window.setTimeout(() => void refresh(), 500);
      }
    } finally {
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(port.pid);
        return next;
      });
    }
  }, [pushNotice, refresh]);

  const handleOpenBrowser = useCallback((port: number) => {
    void openUrl(`http://localhost:${port}`);
  }, []);

  // Group by project
  const grouped = groupPortsByProject(ports);
  const groupKeys = sortPortGroupKeys(grouped);

  return (
    <div className="absolute inset-0 overflow-y-auto pt-3 pb-6">
      <div className="flex items-center justify-between mb-4 pr-6 pl-3">
        <h2 className="section-label !p-0">Ports</h2>
        <button
          className="icon-btn"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh port list"
        >
          <RefreshCcw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <div className="text-sm mx-6 mt-2 p-3 rounded-md" style={{ background: "rgba(255,80,80,0.1)", color: "var(--text-danger, #e55)" }}>
          <p className="font-medium mb-1">Scan error</p>
          <p className="opacity-70 font-mono text-xs">{error}</p>
        </div>
      )}

      {!error && ports.length === 0 && !loading && (
        <p className="text-sm opacity-50 mt-8 text-center">
          No dev ports detected
        </p>
      )}

      {!error && ports.length === 0 && loading && (
        <p className="text-sm opacity-50 mt-8 text-center">
          Scanning ports...
        </p>
      )}

      {groupKeys.map((group) => (
        <section key={group} className="settings-section">
          <div className="flex items-center gap-1.5 settings-section__header opacity-60">
            <Folder size={12} />
            <span className="text-xs font-medium uppercase tracking-wide">{group}</span>
            <span className="text-xs opacity-50">({grouped[group].length})</span>
          </div>

          <div className="flex flex-col gap-1">
            {grouped[group].map((port) => (
              <div
                key={`${port.pid}-${port.port}`}
                className="flex items-center gap-3 px-3 py-2 rounded-md"
                style={{ background: "var(--surface-hover)" }}
              >
                <span
                  className="font-mono text-sm font-semibold shrink-0"
                  style={{ minWidth: "52px" }}
                >
                  :{port.port}
                </span>

                <div className="flex flex-col min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm truncate">{port.process}</span>
                    {port.framework && (
                      <span
                        className="text-xs px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: "var(--surface-active)" }}
                      >
                        {port.framework}
                      </span>
                    )}
                  </div>
                  {port.cwd && (
                    <span className="text-xs opacity-40 truncate">{port.cwd}</span>
                  )}
                </div>

                <span className="text-xs opacity-40 shrink-0 font-mono" title="Uptime">
                  {formatUptime(port.uptime)}
                </span>

                <span className="text-xs opacity-40 shrink-0" style={{ minWidth: "50px" }} title="Memory">
                  {formatMemory(port.memory_kb)}
                </span>

                <span className="text-xs opacity-30 shrink-0 font-mono" title="PID" style={{ minWidth: "44px" }}>
                  {port.pid}
                </span>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="icon-btn"
                    onClick={() => handleOpenBrowser(port.port)}
                    title={`Open localhost:${port.port}`}
                    aria-label={`Open port ${port.port} in browser`}
                  >
                    <ExternalLink size={13} />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={() => void handleKill(port)}
                    disabled={killing.has(port.pid)}
                    title={`Kill ${port.process} (pid ${port.pid})`}
                    aria-label={`Kill process on port ${port.port}`}
                    style={{ color: "var(--text-danger, #e55)" }}
                  >
                    <Skull size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
