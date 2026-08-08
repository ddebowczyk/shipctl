use std::collections::BTreeMap;
use std::path::Path;

use super::{ModuleRegistry, RegistryError, REGISTRY_SCHEMA_VERSION};
use crate::module_control::{
    Diagnostic, DiagnosticSeverity, RedactedEvidence, MODULE_CONTROL_SCHEMA_VERSION,
};

pub const REGISTRY_HEALTHY: &str = "module.registry.health.ok";

/// Inspect an existing registry without creating, migrating, or mutating it.
pub fn diagnose_registry(path: &Path) -> Vec<Diagnostic> {
    match ModuleRegistry::open_read_only_path(path).and_then(|registry| registry.snapshot()) {
        Ok(snapshot) => {
            let mut diagnostic = registry_diagnostic(
                REGISTRY_HEALTHY,
                DiagnosticSeverity::Info,
                "registry_snapshot",
                format!(
                    "Registry is coherent at revision {}",
                    snapshot.registry_revision
                ),
                path,
                None,
            );
            diagnostic.evidence.fields.extend([
                (
                    "schemaVersion".to_string(),
                    REGISTRY_SCHEMA_VERSION.to_string(),
                ),
                (
                    "registryRevision".to_string(),
                    snapshot.registry_revision.to_string(),
                ),
                ("integrity".to_string(), "passed".to_string()),
                ("revisionContinuity".to_string(), "passed".to_string()),
                ("artifactReferences".to_string(), "passed".to_string()),
                ("operationJournal".to_string(), "passed".to_string()),
                (
                    "staticBuildProvenance".to_string(),
                    snapshot
                        .static_build_provenance
                        .unwrap_or_else(|| "absent".to_string()),
                ),
            ]);
            vec![diagnostic]
        }
        Err(error) => vec![error_diagnostic(path, error)],
    }
}

fn error_diagnostic(path: &Path, error: RegistryError) -> Diagnostic {
    registry_diagnostic(
        error.code,
        DiagnosticSeverity::Error,
        "registry_snapshot",
        error.message,
        path,
        Some("Inspect the named instance state root and registry diagnostics".to_string()),
    )
}

pub(super) fn registry_diagnostic(
    code: &str,
    severity: DiagnosticSeverity,
    check: &str,
    summary: String,
    path: &Path,
    remedy: Option<String>,
) -> Diagnostic {
    Diagnostic {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        code: code.to_string(),
        severity,
        check: check.to_string(),
        summary,
        evidence: RedactedEvidence {
            fields: BTreeMap::from([("registryPath".to_string(), path.display().to_string())]),
        },
        remedy,
    }
}
