import type { ProjectFacts } from "@shipctl/module-api";

// Module-contributed facts keyed by project path. The host produces this map by
// polling the enabled facts provider; the projects capability only consumes it,
// so the shape is declared here rather than alongside the producer.
export type ProjectFactsByPath = Readonly<Record<string, ProjectFacts | null>>;
