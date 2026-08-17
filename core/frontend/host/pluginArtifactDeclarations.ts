import type {
  PluginArtifactDeclarations,
  PluginContributionDeclaration,
  PluginContributionFamily,
  ShipctlPluginDefinition,
  ShipctlPluginRole,
} from "@shipctl/module-api";
import { terminalDriverId } from "@shipctl/module-api";

const CONTRIBUTION_SCHEMA_VERSION = 1;
const PLUGIN_ROLES = new Set<ShipctlPluginRole>(["headless", "presentation", "compound"]);
const CONTRIBUTION_FAMILIES = new Set<PluginContributionFamily>([
  "command",
  "global-navigation",
  "global-surface",
  "message-graph",
  "panel",
  "project-action",
  "project-facts",
  "project-import",
  "project-layout",
  "project-navigation",
  "scheduled-task",
  "settings",
  "sidebar",
  "skills-provider",
  "terminal-presentation",
]);

function assertExactKeys(
  input: Record<string, unknown>,
  required: readonly string[],
  subject: string,
): void {
  const requiredKeys = new Set(required);
  const missing = required.filter((key) => !(key in input));
  const unknown = Object.keys(input).filter((key) => !requiredKeys.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${subject} fields differ (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
}

function validScopedId(value: string): boolean {
  return value.split(".").length >= 2
    && value.split(".").every((segment) => /^[a-z][a-z0-9-]*$/.test(segment));
}

function validContributionId(family: PluginContributionFamily, value: string): boolean {
  if (family !== "terminal-presentation") return validScopedId(value);
  try {
    terminalDriverId(value);
    return true;
  } catch {
    return false;
  }
}

function compareByIdVersion(
  left: { readonly id: string; readonly version: number },
  right: { readonly id: string; readonly version: number },
): number {
  return left.id.localeCompare(right.id) || left.version - right.version;
}

function compareContributions(
  left: PluginContributionDeclaration,
  right: PluginContributionDeclaration,
): number {
  return left.family.localeCompare(right.family)
    || left.id.localeCompare(right.id)
    || left.schemaVersion - right.schemaVersion;
}

function assertUniqueIds(
  values: readonly { readonly id: string; readonly version: number }[],
  subject: string,
): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (!validScopedId(value.id) || !Number.isSafeInteger(value.version) || value.version < 1) {
      throw new Error(`${subject} require stable scoped IDs and positive integer versions`);
    }
    if (ids.has(value.id)) throw new Error(`${subject} contain duplicate ID ${value.id}`);
    ids.add(value.id);
  }
}

function normalizeDeclarations(
  declarations: PluginArtifactDeclarations,
): PluginArtifactDeclarations {
  assertUniqueIds(declarations.requiredServices, "Required services");
  assertUniqueIds(declarations.providedServices, "Provided services");
  const backgroundEffects = [...declarations.backgroundEffects];
  const effectIds = new Set<string>();
  for (const id of backgroundEffects) {
    if (!validScopedId(id)) throw new Error(`Invalid background effect ID ${id}`);
    if (effectIds.has(id)) throw new Error(`Duplicate background effect ID ${id}`);
    effectIds.add(id);
  }
  const contributionKeys = new Set<string>();
  for (const contribution of declarations.contributions) {
    if (!CONTRIBUTION_FAMILIES.has(contribution.family)
      || !validContributionId(contribution.family, contribution.id)
      || !Number.isSafeInteger(contribution.schemaVersion)
      || contribution.schemaVersion < 1) {
      throw new Error(
        "Contribution declarations require a known family, family-appropriate stable ID, and positive schema version",
      );
    }
    const key = `${contribution.family}:${contribution.id}`;
    if (contributionKeys.has(key)) throw new Error(`Duplicate contribution ${key}`);
    contributionKeys.add(key);
  }
  return Object.freeze({
    schemaVersion: 1,
    role: declarations.role,
    requiredServices: Object.freeze([...declarations.requiredServices].sort(compareByIdVersion)),
    providedServices: Object.freeze([...declarations.providedServices].sort(compareByIdVersion)),
    backgroundEffects: Object.freeze(backgroundEffects.sort()),
    contributions: Object.freeze([...declarations.contributions].sort(compareContributions)),
  });
}

/** Collect the exact application surface which must match an admitted manifest. */
export function collectPluginArtifactDeclarations(
  definition: ShipctlPluginDefinition,
): PluginArtifactDeclarations {
  const contributions: PluginContributionDeclaration[] = [];
  const add = (family: PluginContributionFamily, id: string) => contributions.push({
    family,
    id,
    schemaVersion: CONTRIBUTION_SCHEMA_VERSION,
  });
  const { module } = definition;
  for (const value of module.commands ?? []) add("command", value.id);
  for (const value of module.panels ?? []) add("panel", value.id);
  for (const value of module.globalSurfaces ?? []) add("global-surface", value.id);
  for (const value of module.globalNavigation ?? []) add("global-navigation", value.id);
  for (const value of module.sidebar ?? []) add("sidebar", value.id);
  for (const value of module.projectNavigation ?? []) add("project-navigation", value.id);
  for (const value of module.projectLayout ?? []) add("project-layout", value.id);
  for (const value of module.projectActions ?? []) add("project-action", value.id);
  if (module.projectFactsProvider) add("project-facts", module.projectFactsProvider.id);
  if (module.projectImport) add("project-import", module.projectImport.id);
  for (const value of module.settings ?? []) add("settings", value.id);
  if (module.skillsProvider) add("skills-provider", module.skillsProvider.id);
  for (const value of module.scheduledTasks ?? []) add("scheduled-task", value.id);
  if (module.messages) add("message-graph", `${module.id}.messages`);
  for (const value of module.terminalPresentations ?? []) {
    add("terminal-presentation", value.driverId);
  }
  return normalizeDeclarations({
    schemaVersion: 1,
    role: definition.role,
    requiredServices: (definition.requires ?? []).map(({ id, version }) => ({ id, version })),
    providedServices: (definition.provides ?? []).map(({ service: { id, version } }) => ({ id, version })),
    backgroundEffects: [...definition.backgroundEffects ?? []],
    contributions,
  });
}

/** Parse native-admitted JSON without trusting its TypeScript shape. */
export function parsePluginArtifactDeclarations(value: unknown): PluginArtifactDeclarations {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Application declarations must be an object");
  }
  const input = value as Record<string, unknown>;
  assertExactKeys(
    input,
    [
      "schemaVersion",
      "role",
      "requiredServices",
      "providedServices",
      "backgroundEffects",
      "contributions",
    ],
    "Application declarations",
  );
  if (input.schemaVersion !== 1 || !PLUGIN_ROLES.has(input.role as ShipctlPluginRole)) {
    throw new Error("Application declarations use an unsupported schema or role");
  }
  const serviceList = (field: "requiredServices" | "providedServices") => {
    const values = input[field];
    if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
    return values.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`${field} entries must be objects`);
      }
      const service = item as Record<string, unknown>;
      assertExactKeys(service, ["id", "version"], `${field} entry`);
      if (typeof service.id !== "string" || typeof service.version !== "number") {
        throw new Error(`${field} entries require id and version`);
      }
      return { id: service.id, version: service.version };
    });
  };
  if (!Array.isArray(input.backgroundEffects) || !Array.isArray(input.contributions)) {
    throw new Error("Application effects and contributions must be arrays");
  }
  const backgroundEffects = input.backgroundEffects.map((id) => {
    if (typeof id !== "string") throw new Error("Background effect IDs must be strings");
    return id;
  });
  const contributions = input.contributions.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Contribution declarations must be objects");
    }
    const contribution = item as Record<string, unknown>;
    assertExactKeys(
      contribution,
      ["family", "id", "schemaVersion"],
      "Contribution declaration",
    );
    if (typeof contribution.family !== "string"
      || typeof contribution.id !== "string"
      || typeof contribution.schemaVersion !== "number") {
      throw new Error("Contribution declarations require family, id, and schemaVersion");
    }
    return {
      family: contribution.family as PluginContributionFamily,
      id: contribution.id,
      schemaVersion: contribution.schemaVersion,
    };
  });
  return normalizeDeclarations({
    schemaVersion: 1,
    role: input.role as ShipctlPluginRole,
    requiredServices: serviceList("requiredServices"),
    providedServices: serviceList("providedServices"),
    backgroundEffects,
    contributions,
  });
}

export function samePluginArtifactDeclarations(
  left: PluginArtifactDeclarations,
  right: PluginArtifactDeclarations,
): boolean {
  return JSON.stringify(normalizeDeclarations(left)) === JSON.stringify(normalizeDeclarations(right));
}
