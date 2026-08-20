// Transitional host entrypoint for callers that have not yet moved their
// import to the runtime-owned declaration validator.
export {
  collectPluginArtifactDeclarations,
  parsePluginArtifactDeclarations,
  PluginArtifactDeclarationError,
  samePluginArtifactDeclarationMetadata,
  samePluginArtifactDeclarations,
} from "@shipctl/core/runtime";
export type { PluginArtifactDeclarationDiagnosticCode } from "@shipctl/core/runtime";
