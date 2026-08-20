import * as PluginApi from "@shipctl/module-api";
import {
  type AcceptedPluginAdmission,
  type DirectShipctlPluginDefinition,
  type LegacyShipctlPluginDefinition,
  type ModuleActivationContext,
  parseMessageDeclarations,
  type MessageDeclarations,
  type PluginArtifactDeclarations,
  type ShipctlModule,
  type ShipctlPluginDefinition,
} from "@shipctl/module-api";
import * as React from "react";
import * as ReactDom from "react-dom";
import * as ReactDomClient from "react-dom/client";
import * as ReactJsxDevRuntime from "react/jsx-dev-runtime";
import * as ReactJsxRuntime from "react/jsx-runtime";

import { moduleArtifactAssetUrl } from "@shipctl/core/platform";

import { messageDeclarations } from "./moduleMessageContext.ts";
import {
  collectPluginArtifactDeclarations,
  PluginArtifactDeclarationError,
  parsePluginArtifactDeclarations,
  samePluginArtifactDeclarationMetadata,
  samePluginArtifactDeclarations,
} from "./pluginArtifactDeclarations.ts";

export type ModuleArtifactLoadPhase = "resolve" | "import" | "validate" | "activate";

export interface ModuleArtifactHost {
  readonly react: typeof React;
  readonly reactDom: typeof ReactDom;
  readonly reactDomClient: typeof ReactDomClient;
  readonly reactJsxDevRuntime: typeof ReactJsxDevRuntime;
  readonly reactJsxRuntime: typeof ReactJsxRuntime;
  readonly pluginApi: typeof PluginApi;
}

export const MODULE_ARTIFACT_HOST_SYMBOL = Symbol.for("shipctl.plugin-host.v1");

interface ShipctlModuleArtifactNamespace {
  createShipctlModule?(host: ModuleArtifactHost): ShipctlModule;
  createShipctlPlugin?(host: ModuleArtifactHost): ShipctlPluginDefinition;
}

export interface LoadShipctlModuleArtifactRequest {
  readonly digest: string;
  readonly entryUrl: string;
  readonly expectedModuleId: string;
  readonly expectedVersion: string;
  readonly admittedApplication?: unknown;
  readonly admittedMessages?: unknown;
  readonly admittedGrants?: unknown;
  readonly styleUrls?: readonly string[];
  readonly importModule?: (url: string) => Promise<ShipctlModuleArtifactNamespace>;
}

export interface LoadedShipctlModuleArtifact {
  readonly digest: string;
  readonly entryUrl: string;
  /** Present only while this artifact still uses the temporary static adapter. */
  readonly module?: ShipctlModule;
  readonly definition: ShipctlPluginDefinition;
  /** Immutable host-side admission carried into provider bindings at activation. */
  readonly admission: AcceptedPluginAdmission;
}

export interface ModuleArtifactDiagnostic {
  readonly code: string;
  readonly subject: string;
  readonly message: string;
}

export class ModuleArtifactLoadError extends Error {
  readonly code: string;
  readonly phase: ModuleArtifactLoadPhase;
  readonly cause: unknown;
  readonly diagnostic: ModuleArtifactDiagnostic | undefined;

  constructor(
    phase: ModuleArtifactLoadPhase,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ModuleArtifactLoadError";
    this.phase = phase;
    this.cause = cause;
    this.code = phase === "validate"
      ? "module.loader.invalid_artifact"
      : `module.loader.${phase}_failed`;
    this.diagnostic = cause instanceof PluginArtifactDeclarationError
      ? Object.freeze({
          code: cause.code,
          subject: cause.subject,
          message: cause.message,
        })
      : undefined;
  }
}

function decodedUrl(entryUrl: string): string {
  try {
    return decodeURIComponent(entryUrl);
  } catch (error) {
    throw new ModuleArtifactLoadError(
      "resolve",
      "The module artifact URL cannot be decoded",
      error,
    );
  }
}

/**
 * Keep the identity check at the generic host boundary: a loader never accepts
 * an artifact whose URL is not inside the exact immutable digest directory.
 */
export function assertDigestQualifiedArtifactUrl(entryUrl: string, digest: string): void {
  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    throw new ModuleArtifactLoadError("resolve", "Module artifact digest must be a SHA-256 hex value");
  }
  const url = decodedUrl(entryUrl);
  if (!url.includes(`/${digest}/`)) {
    throw new ModuleArtifactLoadError(
      "resolve",
      "Module artifact URL is not qualified by its requested digest",
    );
  }
}

/**
 * Converts a backend-approved absolute entry path to Tauri's production asset
 * protocol. The caller receives no API for arbitrary paths; the registry will
 * supply only entries below the instance's immutable artifact root.
 */
export function moduleArtifactUrl(
  entryPath: string,
  digest: string,
  toUrl: (path: string) => string = moduleArtifactAssetUrl,
): string {
  const entryUrl = toUrl(entryPath);
  assertDigestQualifiedArtifactUrl(entryUrl, digest);
  return entryUrl;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function parseGrants(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((grant) => typeof grant !== "string")) {
    throw new ModuleArtifactLoadError("validate", "Admitted grants must be an array of strings");
  }
  const grants = [...value] as string[];
  if (new Set(grants).size !== grants.length) {
    throw new ModuleArtifactLoadError("validate", "Admitted grants must be unique");
  }
  return grants.sort();
}

function sameMessages(left: MessageDeclarations, right: MessageDeclarations): boolean {
  return sameJson(left, right);
}

const LEGACY_HEADLESS_MODULE_KEYS = new Set(["id", "version", "messages", "activate"]);

function isLegacyDefinition(
  definition: ShipctlPluginDefinition,
): definition is LegacyShipctlPluginDefinition {
  return "module" in definition;
}

function definitionIdentity(
  definition: ShipctlPluginDefinition,
): { readonly id: string; readonly version: string } {
  return isLegacyDefinition(definition)
    ? { id: definition.module.id, version: definition.module.version }
    : { id: definition.id, version: definition.version };
}

function definitionGrants(definition: ShipctlPluginDefinition): readonly string[] {
  return isLegacyDefinition(definition)
    ? definition.module.requiredGrants ?? []
    : definition.requiredGrants ?? [];
}

function installModuleArtifactHost(): ModuleArtifactHost {
  const host = Object.freeze({
    react: React,
    reactDom: ReactDom,
    reactDomClient: ReactDomClient,
    reactJsxDevRuntime: ReactJsxDevRuntime,
    reactJsxRuntime: ReactJsxRuntime,
    pluginApi: PluginApi,
  });
  const globals = globalThis as typeof globalThis & Record<PropertyKey, unknown>;
  const installed = globals[MODULE_ARTIFACT_HOST_SYMBOL];
  if (installed !== undefined) {
    const candidate = installed as Partial<ModuleArtifactHost>;
    if (candidate.react !== React
      || candidate.reactDom !== ReactDom
      || candidate.reactDomClient !== ReactDomClient
      || candidate.reactJsxDevRuntime !== ReactJsxDevRuntime
      || candidate.reactJsxRuntime !== ReactJsxRuntime
      || candidate.pluginApi !== PluginApi) {
      throw new ModuleArtifactLoadError(
        "resolve",
        "The installed module artifact host does not match this application runtime",
      );
    }
    return installed as ModuleArtifactHost;
  }
  Object.defineProperty(globalThis, MODULE_ARTIFACT_HOST_SYMBOL, {
    configurable: false,
    enumerable: false,
    value: host,
    writable: false,
  });
  return host;
}

function withActivationOwnedStyles(
  definition: ShipctlPluginDefinition,
  styleUrls: readonly string[],
): ShipctlPluginDefinition {
  if (styleUrls.length === 0) return definition;
  const attachStyles = (moduleId: string) => {
    if (typeof document === "undefined" || document.head === null) {
      throw new Error("A presentation artifact requires a document to attach its styles");
    }
    const styles = styleUrls.map((href) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.shipctlModule = moduleId;
      document.head.append(link);
      return link;
    });
    return () => {
      for (const style of styles) style.remove();
    };
  };
  if (isLegacyDefinition(definition)) {
    const original = definition.module.activate;
    return {
      ...definition,
      module: {
        ...definition.module,
        activate(host) {
          const detach = attachStyles(definition.module.id);
          try {
            const deactivation = original?.(host);
            return {
              async deactivate() {
                try {
                  await deactivation?.deactivate();
                } finally {
                  detach();
                }
              },
            };
          } catch (error) {
            detach();
            throw error;
          }
        },
      },
    };
  }
  const original = definition.activate;
  const styled: DirectShipctlPluginDefinition = {
    ...definition,
    async activate(context: ModuleActivationContext) {
      const detach = attachStyles(definition.id);
      try {
        const deactivation = await original(context);
        return {
          async deactivate() {
            try {
              await deactivation?.deactivate();
            } finally {
              detach();
            }
          },
        };
      } catch (error) {
        detach();
        throw error;
      }
    },
  };
  return styled;
}

/** Load and validate one admitted runtime module without activating it. */
export async function loadShipctlModuleArtifact({
  digest,
  entryUrl,
  expectedModuleId,
  expectedVersion,
  admittedApplication,
  admittedMessages,
  admittedGrants,
  styleUrls = [],
  importModule = (url) => import(/* @vite-ignore */ url),
}: LoadShipctlModuleArtifactRequest): Promise<LoadedShipctlModuleArtifact> {
  assertDigestQualifiedArtifactUrl(entryUrl, digest);
  for (const styleUrl of styleUrls) assertDigestQualifiedArtifactUrl(styleUrl, digest);
  if (new Set(styleUrls).size !== styleUrls.length) {
    throw new ModuleArtifactLoadError("resolve", "Module artifact style URLs must be unique");
  }
  const host = installModuleArtifactHost();
  let namespace: ShipctlModuleArtifactNamespace;
  try {
    namespace = await importModule(entryUrl);
  } catch (error) {
    throw new ModuleArtifactLoadError("import", "Module artifact import failed", error);
  }
  const usesApplicationContract = admittedApplication !== undefined;
  if (usesApplicationContract && typeof namespace.createShipctlPlugin !== "function") {
    throw new ModuleArtifactLoadError(
      "validate",
      "Schema version 2 artifact must export createShipctlPlugin(host)",
    );
  }
  if (!usesApplicationContract && typeof namespace.createShipctlModule !== "function") {
    throw new ModuleArtifactLoadError(
      "validate",
      "Schema version 1 artifact must export createShipctlModule(host)",
    );
  }
  let definition: ShipctlPluginDefinition;
  try {
    definition = usesApplicationContract
      ? namespace.createShipctlPlugin!(host)
      : {
          module: namespace.createShipctlModule!(host),
          role: "headless",
        };
  } catch (error) {
    throw new ModuleArtifactLoadError("validate", "Module artifact declaration factory failed", error);
  }
  if (!definition || typeof definition !== "object") {
    throw new ModuleArtifactLoadError(
      "validate",
      "Module artifact did not return a plugin definition",
    );
  }
  const identity = definitionIdentity(definition);
  if (identity.id !== expectedModuleId || identity.version !== expectedVersion) {
    throw new ModuleArtifactLoadError(
      "validate",
      "Module artifact identity does not match its admitted manifest",
    );
  }
  const legacyModule = isLegacyDefinition(definition) ? definition.module : undefined;
  const legacyDefinition = legacyModule !== undefined;
  let parsedApplication: PluginArtifactDeclarations | undefined;
  if (usesApplicationContract) {
    let admitted: PluginArtifactDeclarations;
    try {
      admitted = parsePluginArtifactDeclarations(admittedApplication);
      parsedApplication = admitted;
      if (legacyDefinition) {
        const runtime = collectPluginArtifactDeclarations(definition);
        if (!samePluginArtifactDeclarations(admitted, runtime)) {
          throw new PluginArtifactDeclarationError(
            "module.declaration.inconsistent",
            "Application declarations",
            "Application declarations differ",
          );
        }
      } else if (!samePluginArtifactDeclarationMetadata(admitted, definition)) {
        throw new PluginArtifactDeclarationError(
          "module.declaration.inconsistent",
          "Application declarations",
          "Application declaration metadata differs",
        );
      }
    } catch (error) {
      throw new ModuleArtifactLoadError(
        "validate",
        "Runtime application declarations do not match the admitted manifest",
        error,
      );
    }
  } else {
    if (legacyModule === undefined) {
      throw new ModuleArtifactLoadError(
        "validate",
        "Schema version 1 artifacts must use the legacy module declaration",
      );
    }
    const unsupported = Object.keys(legacyModule).filter(
      (key) => !LEGACY_HEADLESS_MODULE_KEYS.has(key),
    );
    if (unsupported.length > 0) {
      throw new ModuleArtifactLoadError(
        "validate",
        `Schema version 1 modules are headless; unsupported contributions: ${unsupported.join(", ")}`,
      );
    }
  }
  let parsedMessages: MessageDeclarations | undefined;
  if (admittedMessages !== undefined) {
    let admitted: MessageDeclarations;
    try {
      admitted = parseMessageDeclarations(admittedMessages);
      parsedMessages = admitted;
    } catch (error) {
      throw new ModuleArtifactLoadError("validate", "Runtime message declarations are invalid", error);
    }
    if (legacyModule !== undefined) {
      let runtime: MessageDeclarations;
      try {
        runtime = parseMessageDeclarations(messageDeclarations(legacyModule));
      } catch (error) {
        throw new ModuleArtifactLoadError("validate", "Runtime message declarations are invalid", error);
      }
      if (!sameMessages(admitted, runtime)) {
        throw new ModuleArtifactLoadError(
          "validate",
          "Runtime message declarations do not match the admitted manifest",
        );
      }
    }
  }
  const effectiveGrants = admittedGrants === undefined ? [] : parseGrants(admittedGrants);
  if (admittedGrants !== undefined) {
    const runtime = [...definitionGrants(definition)].sort();
    if (!sameJson(effectiveGrants, runtime)) {
      throw new ModuleArtifactLoadError(
        "validate",
        "Runtime grants do not match the admitted manifest",
      );
    }
  }
  const loadableDefinition = withActivationOwnedStyles(definition, styleUrls);
  const admission: AcceptedPluginAdmission = Object.freeze({
    artifact: Object.freeze({
      contentDigest: digest,
      entryUrl,
      moduleId: expectedModuleId,
      version: expectedVersion,
    }),
    effectiveGrants: Object.freeze([...effectiveGrants]),
    ...(parsedApplication === undefined ? {} : { application: parsedApplication }),
    ...(parsedMessages === undefined ? {} : { messages: parsedMessages }),
  });
  return {
    digest,
    entryUrl,
    definition: loadableDefinition,
    admission,
    ...(isLegacyDefinition(loadableDefinition) ? { module: loadableDefinition.module } : {}),
  };
}
