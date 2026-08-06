export interface PortInfo {
  readonly port: number;
  readonly pid: number;
  readonly process: string;
  readonly cwd: string;
  readonly project: string;
  readonly framework: string;
  readonly uptime: string;
  readonly memory_kb: number;
}
