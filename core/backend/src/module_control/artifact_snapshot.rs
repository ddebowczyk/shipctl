use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::state::{
    CapturedSnapshotEntry, SnapshotClassification, SnapshotEntryDeclaration, SnapshotProvider,
};
use serde::{Deserialize, Serialize};

use super::artifact::RuntimeArtifactArchive;
use super::registry::{ModuleRegistry, RegistrySnapshot};
use super::repository::read_artifact_directory;
use super::{
    Diagnostic, DiagnosticSeverity, ModuleRuntimeKind, ModuleSource, RedactedEvidence,
    MODULE_CONTROL_SCHEMA_VERSION,
};

const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const ARTIFACTS_ENTRY: &str = "artifacts";
const LOCK_ENTRY: &str = "repository_lock";
const ARTIFACT_ROOT: &str = "modules";
const LOCK_FILE: &str = ".module-artifact.lock";
const STAGING_DIRECTORY: &str = ".staging";

/// Read-only health details for the immutable artifact directories below one
/// state root. Inactive artifact history is useful to report, but it is not
/// required to be valid or portable state.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDiagnosticReport {
    pub artifact_root: PathBuf,
    pub registry_path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_revision: Option<u64>,
    pub selected_artifact_count: usize,
    pub installed_artifact_count: usize,
    pub stale_artifact_count: usize,
    pub pending_install_count: usize,
    pub diagnostics: Vec<Diagnostic>,
}

/// Saves only validated, content-addressed runtime artifacts. Repository lock
/// state and incomplete staging work are never portable workspace state.
pub struct ModuleArtifactSnapshotProvider {
    artifact_root: PathBuf,
    registry_path: PathBuf,
}

impl ModuleArtifactSnapshotProvider {
    pub fn new(artifact_root: PathBuf, registry_path: PathBuf) -> Self {
        Self {
            artifact_root,
            registry_path,
        }
    }

    fn decode_and_validate(payload: &[u8]) -> Result<ArtifactSnapshotBundle, String> {
        let bundle: ArtifactSnapshotBundle = serde_json::from_slice(payload)
            .map_err(|error| format!("Module artifact snapshot is invalid: {error}"))?;
        if bundle.schema_version != SNAPSHOT_SCHEMA_VERSION {
            return Err("Module artifact snapshot schema version is unsupported".to_string());
        }
        for (digest, files) in &bundle.artifacts {
            if !is_sha256_digest(digest) {
                return Err("Module artifact snapshot contains an invalid digest path".to_string());
            }
            let archive =
                RuntimeArtifactArchive::new(files.clone()).map_err(|error| error.to_string())?;
            let artifact = archive.inspect().map_err(|error| error.to_string())?;
            if artifact.content_digest != *digest {
                return Err(
                    "Module artifact snapshot directory does not match its content digest"
                        .to_string(),
                );
            }
        }
        Ok(bundle)
    }
}

/// Diagnose immutable artifact state without creating, migrating, deleting,
/// or repairing anything. The selected set comes from durable desired state;
/// every other content-addressed directory is historical until selected again.
pub fn diagnose_artifact_root(
    artifact_root: &Path,
    registry_path: &Path,
) -> ArtifactDiagnosticReport {
    let mut report = ArtifactDiagnosticReport {
        artifact_root: artifact_root.to_path_buf(),
        registry_path: registry_path.to_path_buf(),
        registry_revision: None,
        selected_artifact_count: 0,
        installed_artifact_count: 0,
        stale_artifact_count: 0,
        pending_install_count: 0,
        diagnostics: Vec::new(),
    };
    let registry = match ModuleRegistry::open_read_only_path(registry_path) {
        Ok(registry) => registry,
        Err(error) => {
            report.diagnostics.push(artifact_diagnostic(
                error.code,
                DiagnosticSeverity::Error,
                "artifact_selection",
                error.message,
                BTreeMap::from([
                    (
                        "artifactRoot".to_string(),
                        artifact_root.display().to_string(),
                    ),
                    (
                        "registryPath".to_string(),
                        registry_path.display().to_string(),
                    ),
                ]),
                Some(
                    "Repair the registry before assessing module artifact directories.".to_string(),
                ),
            ));
            return report;
        }
    };
    let snapshot = match registry.snapshot() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            report.diagnostics.push(artifact_diagnostic(
                error.code,
                DiagnosticSeverity::Error,
                "artifact_selection",
                error.message,
                BTreeMap::from([
                    (
                        "artifactRoot".to_string(),
                        artifact_root.display().to_string(),
                    ),
                    (
                        "registryPath".to_string(),
                        registry_path.display().to_string(),
                    ),
                ]),
                Some(
                    "Repair the registry before assessing module artifact directories.".to_string(),
                ),
            ));
            return report;
        }
    };
    report.registry_revision = Some(snapshot.registry_revision);
    let selected = selected_artifacts(&snapshot);
    report.selected_artifact_count = selected.len();
    append_pending_install_diagnostics(&registry, artifact_root, &mut report);
    append_immutable_collision_diagnostics(&snapshot, &mut report.diagnostics);

    match fs::symlink_metadata(artifact_root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            append_missing_selected_diagnostics(&selected, artifact_root, &mut report.diagnostics);
            if selected.is_empty() {
                report.diagnostics.push(artifact_diagnostic(
                    "module.artifact.health.ok",
                    DiagnosticSeverity::Info,
                    "artifact_root",
                    "No runtime artifact directory is present and no dynamic artifact is selected"
                        .to_string(),
                    BTreeMap::from([(
                        "artifactRoot".to_string(),
                        artifact_root.display().to_string(),
                    )]),
                    None,
                ));
            }
            return report;
        }
        Err(error) => {
            report.diagnostics.push(artifact_diagnostic(
                "module.artifact.repository.state_unreadable",
                DiagnosticSeverity::Error,
                "artifact_root",
                format!("Could not inspect module artifact root: {error}"),
                BTreeMap::from([(
                    "artifactRoot".to_string(),
                    artifact_root.display().to_string(),
                )]),
                Some("Repair the state-root permissions before retrying the doctor.".to_string()),
            ));
            return report;
        }
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            report.diagnostics.push(artifact_diagnostic(
                "module.artifact.repository.state_unreadable",
                DiagnosticSeverity::Error,
                "artifact_root",
                "Module artifact root must be a real directory".to_string(),
                BTreeMap::from([(
                    "artifactRoot".to_string(),
                    artifact_root.display().to_string(),
                )]),
                Some("Restore the module artifact root as a real private directory.".to_string()),
            ));
            return report;
        }
        Ok(_) => {}
    };

    let entries = match fs::read_dir(artifact_root) {
        Ok(entries) => entries,
        Err(error) => {
            report.diagnostics.push(artifact_diagnostic(
                "module.artifact.repository.state_unreadable",
                DiagnosticSeverity::Error,
                "artifact_root",
                format!("Could not read module artifact root: {error}"),
                BTreeMap::from([(
                    "artifactRoot".to_string(),
                    artifact_root.display().to_string(),
                )]),
                Some("Repair the state-root permissions before retrying the doctor.".to_string()),
            ));
            return report;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                report.diagnostics.push(artifact_diagnostic(
                    "module.artifact.repository.state_unreadable",
                    DiagnosticSeverity::Error,
                    "artifact_root",
                    format!("Could not read a module artifact entry: {error}"),
                    BTreeMap::from([(
                        "artifactRoot".to_string(),
                        artifact_root.display().to_string(),
                    )]),
                    Some(
                        "Repair the state-root permissions before retrying the doctor.".to_string(),
                    ),
                ));
                continue;
            }
        };
        let path = entry.path();
        let name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => {
                report.diagnostics.push(artifact_diagnostic(
                    "module.artifact.entry.unrecognized",
                    DiagnosticSeverity::Error,
                    "artifact_root",
                    "Module artifact directory name is not UTF-8".to_string(),
                    BTreeMap::from([("artifactPath".to_string(), path.display().to_string())]),
                    Some("Move the unexpected entry out of the module artifact root.".to_string()),
                ));
                continue;
            }
        };
        if name == STAGING_DIRECTORY {
            append_staging_diagnostic(&path, &mut report.diagnostics);
            continue;
        }
        if !is_sha256_digest(&name) {
            report.diagnostics.push(artifact_diagnostic(
                "module.artifact.entry.unrecognized",
                DiagnosticSeverity::Error,
                "artifact_root",
                format!("Module artifact root contains an unrecognized entry: {name}"),
                BTreeMap::from([("artifactPath".to_string(), path.display().to_string())]),
                Some("Move the unexpected entry out of the module artifact root.".to_string()),
            ));
            continue;
        }
        report.installed_artifact_count += 1;
        let selected_modules = selected.get(&name);
        match inspect_artifact_directory(&path, &name) {
            Ok(()) if selected_modules.is_some() => {}
            Ok(()) => {
                report.stale_artifact_count += 1;
                report.diagnostics.push(stale_artifact_diagnostic(
                    "module.artifact.stale",
                    &path,
                    &name,
                    "Inactive historical artifact is valid but not selected by the current registry"
                        .to_string(),
                ));
            }
            Err((code, message)) if selected_modules.is_some() => {
                let module_ids = selected_modules.expect("selected artifact match guard");
                report.diagnostics.push(artifact_diagnostic(
                    code,
                    DiagnosticSeverity::Error,
                    "selected_artifact",
                    format!("Selected artifact {name} is invalid: {message}"),
                    selected_artifact_evidence(&path, &name, module_ids),
                    Some(format!(
                        "Restore or reinstall the selected artifact at {}; do not delete a selected artifact.",
                        path.display()
                    )),
                ));
            }
            Err((code, message)) => {
                report.stale_artifact_count += 1;
                report.diagnostics.push(stale_artifact_diagnostic(
                    &code,
                    &path,
                    &name,
                    format!("Inactive historical artifact is invalid: {message}"),
                ));
            }
        }
    }
    append_missing_selected_diagnostics(&selected, artifact_root, &mut report.diagnostics);
    if report.diagnostics.iter().all(|diagnostic| {
        !matches!(
            diagnostic.severity,
            DiagnosticSeverity::Error | DiagnosticSeverity::Warning
        )
    }) {
        report.diagnostics.push(artifact_diagnostic(
            "module.artifact.health.ok",
            DiagnosticSeverity::Info,
            "artifact_root",
            "Selected runtime artifacts are present and valid".to_string(),
            BTreeMap::from([
                (
                    "artifactRoot".to_string(),
                    artifact_root.display().to_string(),
                ),
                (
                    "selectedArtifactCount".to_string(),
                    report.selected_artifact_count.to_string(),
                ),
            ]),
            None,
        ));
    }
    report
}

fn selected_artifact_digests(registry_path: &Path) -> Result<BTreeSet<String>, String> {
    let registry =
        ModuleRegistry::open_read_only_path(registry_path).map_err(|error| error.to_string())?;
    let snapshot = registry.snapshot().map_err(|error| error.to_string())?;
    Ok(selected_artifacts(&snapshot).into_keys().collect())
}

fn selected_artifacts(snapshot: &RegistrySnapshot) -> BTreeMap<String, Vec<String>> {
    let mut selected = BTreeMap::<String, Vec<String>>::new();
    for desired in &snapshot.desired {
        let Some(identity) = &desired.selected_artifact else {
            continue;
        };
        if identity.runtime_kind == ModuleRuntimeKind::StaticBuiltin {
            continue;
        }
        selected
            .entry(identity.content_digest.clone())
            .or_default()
            .push(identity.id.clone());
    }
    selected
}

fn inspect_artifact_directory(directory: &Path, digest: &str) -> Result<(), (String, String)> {
    let archive =
        read_artifact_directory(directory).map_err(|error| (error.code, error.message))?;
    let artifact = archive
        .inspect()
        .map_err(|error| (error.code, error.message))?;
    if artifact.content_digest != digest {
        return Err((
            "module.artifact.content_digest.mismatch".to_string(),
            "Artifact directory does not match its content digest".to_string(),
        ));
    }
    Ok(())
}

fn append_pending_install_diagnostics(
    registry: &ModuleRegistry,
    artifact_root: &Path,
    report: &mut ArtifactDiagnosticReport,
) {
    match registry.pending_artifact_installs() {
        Ok(pending) => {
            report.pending_install_count = pending.len();
            for install in pending {
                let identity = install.artifact.identity();
                report.diagnostics.push(artifact_diagnostic(
                    "module.artifact.install.pending",
                    DiagnosticSeverity::Warning,
                    "pending_install",
                    format!(
                        "Artifact install for {} is still staged and has not completed",
                        identity.id
                    ),
                    BTreeMap::from([
                        ("artifactRoot".to_string(), artifact_root.display().to_string()),
                        ("moduleId".to_string(), identity.id),
                        ("contentDigest".to_string(), identity.content_digest),
                        ("stageId".to_string(), install.stage_id),
                        ("requestId".to_string(), install.request_id.to_string()),
                    ]),
                    Some("Start Shipctl once to let its artifact repository recover the staged install.".to_string()),
                ));
            }
        }
        Err(error) => report.diagnostics.push(artifact_diagnostic(
            error.code,
            DiagnosticSeverity::Error,
            "pending_install",
            error.message,
            BTreeMap::from([(
                "registryPath".to_string(),
                registry.path().display().to_string(),
            )]),
            Some("Repair the registry before retrying the doctor.".to_string()),
        )),
    }
}

fn append_immutable_collision_diagnostics(
    snapshot: &RegistrySnapshot,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let mut identities = BTreeMap::<(String, String), Vec<_>>::new();
    for artifact in &snapshot.artifacts {
        identities
            .entry((
                artifact.identity.id.clone(),
                artifact.identity.version.clone(),
            ))
            .or_default()
            .push(artifact);
    }
    for ((module_id, version), artifacts) in identities {
        let digests = artifacts
            .iter()
            .map(|artifact| artifact.identity.content_digest.clone())
            .collect::<BTreeSet<_>>();
        let exclusively_bundled = artifacts.iter().all(|artifact| {
            !artifact.sources.is_empty()
                && artifact
                    .sources
                    .iter()
                    .all(|source| *source == ModuleSource::Bundled)
        });
        if digests.len() > 1 && !exclusively_bundled {
            diagnostics.push(artifact_diagnostic(
                "module.artifact.immutable.collision",
                DiagnosticSeverity::Error,
                "immutable_identity",
                format!(
                    "Module {module_id} version {version} is bound to multiple non-bundled immutable digests"
                ),
                BTreeMap::from([
                    ("moduleId".to_string(), module_id),
                    ("version".to_string(), version),
                    (
                        "contentDigests".to_string(),
                        digests.into_iter().collect::<Vec<_>>().join(","),
                    ),
                ]),
                Some("Reinstall one authoritative artifact version and remove the conflicting registration.".to_string()),
            ));
        }
    }
}

fn append_staging_diagnostic(path: &Path, diagnostics: &mut Vec<Diagnostic>) {
    match directory_contains_files(path) {
        Ok(false) => {}
        Ok(true) => diagnostics.push(artifact_diagnostic(
            "module.artifact.staging.pending",
            DiagnosticSeverity::Warning,
            "artifact_staging",
            "Module artifact staging directory contains interrupted install work".to_string(),
            BTreeMap::from([("stagingPath".to_string(), path.display().to_string())]),
            Some(
                "Start Shipctl once to let its artifact repository recover the staged install."
                    .to_string(),
            ),
        )),
        Err(message) => diagnostics.push(artifact_diagnostic(
            "module.artifact.repository.state_unreadable",
            DiagnosticSeverity::Error,
            "artifact_staging",
            message,
            BTreeMap::from([("stagingPath".to_string(), path.display().to_string())]),
            Some(
                "Repair the staging directory permissions before retrying the doctor.".to_string(),
            ),
        )),
    }
}

fn append_missing_selected_diagnostics(
    selected: &BTreeMap<String, Vec<String>>,
    artifact_root: &Path,
    diagnostics: &mut Vec<Diagnostic>,
) {
    for (digest, module_ids) in selected {
        let path = artifact_root.join(digest);
        if !path.exists() {
            diagnostics.push(artifact_diagnostic(
                "module.artifact.selected.missing",
                DiagnosticSeverity::Error,
                "selected_artifact",
                format!("Selected artifact {digest} is missing from the module artifact root"),
                selected_artifact_evidence(&path, digest, module_ids),
                Some(format!(
                    "Restore or reinstall the selected artifact at {}; do not delete a selected artifact.",
                    path.display()
                )),
            ));
        }
    }
}

fn stale_artifact_diagnostic(code: &str, path: &Path, digest: &str, summary: String) -> Diagnostic {
    artifact_diagnostic(
        code,
        DiagnosticSeverity::Warning,
        "stale_artifact",
        summary,
        BTreeMap::from([
            ("artifactPath".to_string(), path.display().to_string()),
            ("contentDigest".to_string(), digest.to_string()),
        ]),
        Some(format!(
            "Stop any older Shipctl instances, back up {}, then remove this inactive directory manually. It is already excluded from state snapshots.",
            path.display()
        )),
    )
}

fn selected_artifact_evidence(
    path: &Path,
    digest: &str,
    module_ids: &[String],
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("artifactPath".to_string(), path.display().to_string()),
        ("contentDigest".to_string(), digest.to_string()),
        ("moduleIds".to_string(), module_ids.join(",")),
    ])
}

fn artifact_diagnostic(
    code: impl Into<String>,
    severity: DiagnosticSeverity,
    check: impl Into<String>,
    summary: impl Into<String>,
    fields: BTreeMap<String, String>,
    remedy: Option<String>,
) -> Diagnostic {
    Diagnostic {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        code: code.into(),
        severity,
        check: check.into(),
        summary: summary.into(),
        evidence: RedactedEvidence { fields },
        remedy,
    }
}

impl SnapshotProvider for ModuleArtifactSnapshotProvider {
    fn id(&self) -> &'static str {
        "modules.artifacts"
    }

    fn schema_version(&self) -> u32 {
        SNAPSHOT_SCHEMA_VERSION
    }

    fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
        vec![
            SnapshotEntryDeclaration {
                id: ARTIFACTS_ENTRY,
                classification: SnapshotClassification::Portable,
                source_paths: vec![PathBuf::from(ARTIFACT_ROOT)],
                target_path: Some(PathBuf::from(ARTIFACT_ROOT)),
                redaction: "validated immutable module artifacts only",
            },
            SnapshotEntryDeclaration {
                id: LOCK_ENTRY,
                classification: SnapshotClassification::LiveOnly,
                source_paths: vec![PathBuf::from(LOCK_FILE)],
                target_path: None,
                redaction: "process-local repository lease is excluded",
            },
        ]
    }

    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
        let artifacts = match fs::symlink_metadata(&self.artifact_root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Could not inspect module artifact root: {error}")),
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("Module artifact root must be a real directory".to_string());
                }
                let selected = selected_artifact_digests(&self.registry_path)?;
                let mut artifacts = BTreeMap::new();
                for entry in fs::read_dir(&self.artifact_root)
                    .map_err(|error| format!("Could not read module artifact root: {error}"))?
                {
                    let entry = entry.map_err(|error| {
                        format!("Could not read module artifact entry: {error}")
                    })?;
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| "Module artifact directory name is not UTF-8".to_string())?;
                    if name == STAGING_DIRECTORY {
                        if directory_contains_files(&entry.path())? {
                            return Err(
                                "Module artifact staging directory is not empty during snapshot"
                                    .to_string(),
                            );
                        }
                        continue;
                    }
                    if !is_sha256_digest(&name) {
                        return Err(format!(
                            "Module artifact root contains an unrecognized entry: {name}"
                        ));
                    }
                    if !selected.contains(&name) {
                        continue;
                    }
                    let archive = read_artifact_directory(&entry.path())
                        .map_err(|error| error.to_string())?;
                    let artifact = archive.inspect().map_err(|error| error.to_string())?;
                    if artifact.content_digest != name {
                        return Err(format!(
                            "Module artifact directory {name} does not match its content digest"
                        ));
                    }
                    artifacts.insert(name, archive.files().clone());
                }
                Some(
                    serde_json::to_vec(&ArtifactSnapshotBundle {
                        schema_version: SNAPSHOT_SCHEMA_VERSION,
                        artifacts,
                    })
                    .map_err(|error| {
                        format!("Could not encode module artifact snapshot: {error}")
                    })?,
                )
            }
        };

        Ok(vec![
            CapturedSnapshotEntry {
                id: ARTIFACTS_ENTRY,
                decision: if artifacts.is_some() {
                    "included_selected_artifacts".to_string()
                } else {
                    "source_absent".to_string()
                },
                payload: artifacts,
            },
            CapturedSnapshotEntry {
                id: LOCK_ENTRY,
                payload: None,
                decision: "excluded_process_local_lease".to_string(),
            },
        ])
    }

    fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String> {
        if entry_id != ARTIFACTS_ENTRY {
            return Err(format!("Unknown modules.artifacts payload {entry_id}"));
        }
        Self::decode_and_validate(payload).map(|_| ())
    }

    fn restore_payload(
        &self,
        entry_id: &str,
        payload: &[u8],
        staging_state_root: &Path,
    ) -> Result<(), String> {
        if entry_id != ARTIFACTS_ENTRY {
            return Err(format!("Unknown modules.artifacts payload {entry_id}"));
        }
        let bundle = Self::decode_and_validate(payload)?;
        let target_root = staging_state_root.join(ARTIFACT_ROOT);
        fs::create_dir_all(&target_root)
            .map_err(|error| format!("Could not create module artifact restore root: {error}"))?;
        for (digest, files) in bundle.artifacts {
            let artifact_root = target_root.join(digest);
            fs::create_dir(&artifact_root)
                .map_err(|error| format!("Could not create restored module artifact: {error}"))?;
            for (relative, contents) in files {
                let relative = safe_relative_path(&relative)?;
                let target = artifact_root.join(relative);
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| {
                        format!("Could not create restored module artifact directory: {error}")
                    })?;
                }
                fs::write(&target, contents)
                    .map_err(|error| format!("Could not restore module artifact file: {error}"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).map_err(
                        |error| format!("Could not secure restored module artifact: {error}"),
                    )?;
                }
            }
        }
        Ok(())
    }

    fn owns_source_path(&self, source_path: &Path) -> bool {
        source_path == Path::new(LOCK_FILE) || source_path.starts_with(ARTIFACT_ROOT)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactSnapshotBundle {
    schema_version: u32,
    artifacts: BTreeMap<String, BTreeMap<String, Vec<u8>>>,
}

fn directory_contains_files(root: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Could not inspect module artifact staging root: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Module artifact staging root must be a real directory".to_string());
    }
    for entry in fs::read_dir(root)
        .map_err(|error| format!("Could not read module artifact staging root: {error}"))?
    {
        let entry = entry
            .map_err(|error| format!("Could not read module artifact staging entry: {error}"))?;
        let file_type = entry.file_type().map_err(|error| {
            format!("Could not classify module artifact staging entry: {error}")
        })?;
        if file_type.is_symlink() || file_type.is_file() {
            return Ok(true);
        }
        if file_type.is_dir() && directory_contains_files(&entry.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Module artifact snapshot path is unsafe".to_string());
    }
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module_control::registry::{ArtifactAcquisition, RegistryMutation};
    use crate::module_control::{
        DesiredModuleState, ModuleIdentity, ModuleOperationKind, ModuleRuntimeKind, ModuleSource,
    };
    use crate::state::paths::ShipctlPaths;
    use tempfile::TempDir;
    use uuid::Uuid;

    #[test]
    fn capture_excludes_invalid_inactive_artifact_history() {
        let temporary = TempDir::new().unwrap();
        let paths = ShipctlPaths::new(
            temporary.path().join("state"),
            temporary.path().join("runtime"),
        );
        drop(ModuleRegistry::open_writable(&paths).unwrap());

        let stale_digest = "a".repeat(64);
        let stale_directory = paths.module_artifact_root.join(&stale_digest);
        fs::create_dir_all(&stale_directory).unwrap();
        fs::write(
            stale_directory.join("module.yaml"),
            b"not valid runtime metadata",
        )
        .unwrap();

        let provider = ModuleArtifactSnapshotProvider::new(
            paths.module_artifact_root.clone(),
            paths.module_registry_database.clone(),
        );
        let capture = provider.capture().unwrap();
        let artifacts = capture
            .iter()
            .find(|entry| entry.id == ARTIFACTS_ENTRY)
            .expect("artifact snapshot entry");
        assert_eq!(artifacts.decision, "included_selected_artifacts");
        let bundle: ArtifactSnapshotBundle = serde_json::from_slice(
            artifacts
                .payload
                .as_deref()
                .expect("artifact snapshot payload"),
        )
        .unwrap();
        assert!(bundle.artifacts.is_empty());

        let diagnosis =
            diagnose_artifact_root(&paths.module_artifact_root, &paths.module_registry_database);
        assert_eq!(diagnosis.stale_artifact_count, 1);
        assert!(diagnosis.diagnostics.iter().any(|diagnostic| {
            diagnostic.severity == DiagnosticSeverity::Warning
                && diagnostic.check == "stale_artifact"
                && diagnostic
                    .evidence
                    .fields
                    .get("artifactPath")
                    .is_some_and(|path| path == &stale_directory.display().to_string())
        }));
    }

    #[test]
    fn capture_keeps_selected_artifact_validation_strict() {
        let temporary = TempDir::new().unwrap();
        let paths = ShipctlPaths::new(
            temporary.path().join("state"),
            temporary.path().join("runtime"),
        );
        let identity = ModuleIdentity {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            id: "example.selected".to_string(),
            version: "1.0.0".to_string(),
            content_digest: "b".repeat(64),
            runtime_kind: ModuleRuntimeKind::FrontendEsm,
        };
        let mut registry = ModuleRegistry::open_writable(&paths).unwrap();
        registry
            .commit(&RegistryMutation {
                request_id: Uuid::new_v4(),
                module_id: identity.id.clone(),
                instance_id: Uuid::new_v4(),
                kind: ModuleOperationKind::Add,
                artifacts: vec![ArtifactAcquisition {
                    identity: identity.clone(),
                    source: ModuleSource::User,
                }],
                desired: Some(DesiredModuleState {
                    schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                    module_id: identity.id.clone(),
                    selected_artifact: Some(identity.clone()),
                    enabled: true,
                    configuration_revision: 1,
                }),
                observations: Vec::new(),
            })
            .unwrap();
        drop(registry);

        let selected_directory = paths.module_artifact_root.join(&identity.content_digest);
        fs::create_dir_all(&selected_directory).unwrap();
        fs::write(
            selected_directory.join("module.yaml"),
            b"not valid runtime metadata",
        )
        .unwrap();

        let provider = ModuleArtifactSnapshotProvider::new(
            paths.module_artifact_root.clone(),
            paths.module_registry_database.clone(),
        );
        assert!(provider.capture().is_err());

        let diagnosis =
            diagnose_artifact_root(&paths.module_artifact_root, &paths.module_registry_database);
        assert!(diagnosis.diagnostics.iter().any(|diagnostic| {
            diagnostic.severity == DiagnosticSeverity::Error
                && diagnostic.check == "selected_artifact"
                && diagnostic
                    .evidence
                    .fields
                    .get("artifactPath")
                    .is_some_and(|path| path == &selected_directory.display().to_string())
        }));
    }
}
