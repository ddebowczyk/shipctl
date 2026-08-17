import type { ListeningProcessInspection } from "@shipctl/module-api";

/** Ports-owned projection of generic process facts into UI meaning. */
export interface PortInfo extends ListeningProcessInspection {
  readonly projectName: string;
  readonly framework: string;
}
