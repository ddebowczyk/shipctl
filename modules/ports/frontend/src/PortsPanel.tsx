import { useCallback, useEffect, useState } from "react";
import { RefreshCcw, Skull, ExternalLink, Folder } from "lucide-react";
import {
  processesService,
  type GlobalSurfaceContributionProps,
  type ListeningProcessInspection,
  type ProcessesService,
  type ProcessInspectionId,
} from "@shipctl/module-api";

import type { PortInfo } from "./types";

export const PROJECT_ROOT_MARKERS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
] as const;

export const FRAMEWORK_FILE_NAMES = [
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "angular.json",
  "Cargo.toml",
  "go.mod",
  "manage.py",
  "Gemfile",
] as const;

export function isDevelopmentProcess(processName: string): boolean {
  const name = processName.toLowerCase();
  return ![
    "spotify",
    "raycast",
    "tableplus",
    "postman",
    "linear",
    "controlce",
    "rapportd",
    "superhuma",
    "setappage",
    "slack",
    "discord",
    "firefox",
    "chrome",
    "google",
    "safari",
    "figma",
    "notion",
    "zoom",
    "teams",
    "iterm2",
    "warp",
    "arc",
    "loginwindow",
    "windowserver",
    "systemuise",
    "kernel_tas",
    "launchd",
    "mdworker",
    "mds_store",
    "cfprefsd",
    "coreaudio",
    "corebrigh",
    "airportd",
    "bluetoothd",
    "sharingd",
    "usernoted",
    "notificat",
    "cloudd",
  ].some((application) => name.startsWith(application));
}

export function matchProject(
  workingDirectory: string,
  projectPaths: readonly string[],
): string {
  if (!workingDirectory) return "";
  return projectPaths
    .filter((projectPath) => workingDirectory.startsWith(projectPath))
    .sort((left, right) => right.length - left.length)[0]
    ?.split("/")
    .filter(Boolean)
    .pop() ?? "";
}

export function detectFramework(inspection: ListeningProcessInspection): string {
  const command = inspection.commandLine.toLowerCase();
  for (const [needle, framework] of [
    ["next", "Next.js"],
    ["vite", "Vite"],
    ["nuxt", "Nuxt"],
    ["webpack", "Webpack"],
    ["remix", "Remix"],
    ["astro", "Astro"],
    ["gatsby", "Gatsby"],
    ["flask", "Flask"],
    ["uvicorn", "FastAPI"],
    ["rails", "Rails"],
    ["storybook", "Storybook"],
  ] as const) {
    if (command.includes(needle)) return framework;
  }
  if (command.includes("angular") || command.includes("ng serve")) return "Angular";
  if (command.includes("django") || command.includes("manage.py")) return "Django";
  if (command.includes("cargo") || command.includes("rustc")) return "Rust";

  const name = inspection.name.toLowerCase();
  if (name === "node") return "Node.js";
  if (name.startsWith("python")) return "Python";
  if (name.startsWith("ruby")) return "Ruby";
  if (name.startsWith("java")) return "Java";
  if (name === "go") return "Go";
  if (name.includes("postgres") || name === "postmaster") return "PostgreSQL";
  if (name.includes("redis")) return "Redis";
  if (name.includes("mongod")) return "MongoDB";
  if (name.includes("mysqld")) return "MySQL";
  if (name.includes("docker") || name.startsWith("com.docke")) return "Docker";
  if (name.includes("nginx")) return "nginx";

  const files = new Set(inspection.observedProjectFiles);
  for (const [candidates, framework] of [
    [["vite.config.ts", "vite.config.js"], "Vite"],
    [["next.config.js", "next.config.mjs"], "Next.js"],
    [["angular.json"], "Angular"],
    [["Cargo.toml"], "Rust"],
    [["go.mod"], "Go"],
    [["manage.py"], "Django"],
    [["Gemfile"], "Ruby"],
  ] as const) {
    if (candidates.some((candidate) => files.has(candidate))) return framework;
  }
  return "";
}

export function projectPortInspection(
  inspection: ListeningProcessInspection,
  projectPaths: readonly string[],
): PortInfo | null {
  if (!isDevelopmentProcess(inspection.name)) return null;
  return {
    ...inspection,
    projectName: matchProject(inspection.workingDirectory, projectPaths),
    framework: detectFramework(inspection),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    const key = port.projectName || "Other";
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
  processes: ProcessesService,
  projectPaths: readonly string[] = [],
): Promise<PortScanResult> {
  try {
    const outcome = await processes.inspectListeningPorts.execute({
      projectRootMarkers: PROJECT_ROOT_MARKERS,
      observedProjectFileNames: FRAMEWORK_FILE_NAMES,
    });
    return outcome.result.ok
      ? {
          status: "ready",
          ports: outcome.result.value
            .map((inspection) => projectPortInspection(inspection, projectPaths))
            .filter((inspection): inspection is PortInfo => inspection !== null),
        }
      : { status: "error", message: outcome.result.error.message };
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
  processes: ProcessesService,
): Promise<StopPortResult> {
  try {
    const outcome = await processes.terminateInspectedProcess.execute({
      inspectionId: port.inspectionId,
    });
    if (!outcome.result.ok) throw new Error(outcome.result.error.message);
    return {
      status: "stopped",
      notice: {
        tone: "success",
        title: "Process killed",
        message: `Stopped ${port.name} (pid ${port.processId}) on port ${port.port}`,
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

export default function PortsPanel({
  activation,
  projectPaths,
  services,
}: GlobalSurfaceContributionProps) {
  const processes = activation.services.require(processesService);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [killing, setKilling] = useState<Set<ProcessInspectionId>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await scanPorts(processes, projectPaths);
    if (result.status === "ready") {
      setPorts([...result.ports]);
    } else {
      setError(result.message);
      if (import.meta.env.DEV) console.error("Port scan failed:", result.message);
    }
    setLoading(false);
  }, [processes, projectPaths]);

  // Load once when panel mounts
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleKill = useCallback(async (port: PortInfo) => {
    setKilling((prev) => new Set(prev).add(port.inspectionId));
    try {
      const result = await stopPort(port, processes);
      services.notices.push(result.notice);
      if (result.status === "stopped") {
        window.setTimeout(() => void refresh(), 500);
      }
    } finally {
      setKilling((prev) => {
        const next = new Set(prev);
        next.delete(port.inspectionId);
        return next;
      });
    }
  }, [processes, refresh, services.notices]);

  const handleOpenBrowser = useCallback((port: number) => {
    void services.externalLinks.open(`http://localhost:${port}`);
  }, [services.externalLinks]);

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
                key={port.inspectionId}
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
                    <span className="text-sm truncate">{port.name}</span>
                    {port.framework && (
                      <span
                        className="text-xs px-1.5 py-0.5 rounded shrink-0"
                        style={{ background: "var(--surface-active)" }}
                      >
                        {port.framework}
                      </span>
                    )}
                  </div>
                  {port.workingDirectory && (
                    <span className="text-xs opacity-40 truncate">{port.workingDirectory}</span>
                  )}
                </div>

                <span className="text-xs opacity-40 shrink-0 font-mono" title="Uptime">
                  {formatUptime(port.uptime)}
                </span>

                <span className="text-xs opacity-40 shrink-0" style={{ minWidth: "50px" }} title="Memory">
                  {formatMemory(port.memoryKilobytes)}
                </span>

                <span className="text-xs opacity-30 shrink-0 font-mono" title="PID" style={{ minWidth: "44px" }}>
                  {port.processId}
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
                    disabled={killing.has(port.inspectionId)}
                    title={`Kill ${port.name} (pid ${port.processId})`}
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
