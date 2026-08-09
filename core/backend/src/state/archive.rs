use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use shipctl_module_api::{DurableWriteBarrier, SnapshotClassification, SnapshotProvider};
use uuid::Uuid;

use crate::instance::{ControlError, InstanceBuildIdentity, InstanceContext};
use crate::state::paths::ShipctlPaths;

pub const ARCHIVE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateArchiveSource {
    pub instance_id: Uuid,
    pub instance_name: String,
    pub state_root: PathBuf,
    pub build: InstanceBuildIdentity,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateArchiveEntry {
    pub id: String,
    pub classification: SnapshotClassification,
    pub included: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_digest_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
    pub source_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_path: Option<String>,
    pub decision: String,
    pub redaction: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateArchiveProvider {
    pub id: String,
    pub schema_version: u32,
    pub entries: Vec<StateArchiveEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateArchiveManifest {
    pub archive_schema_version: u32,
    pub captured_at_unix_seconds: u64,
    pub source: StateArchiveSource,
    pub source_state_fingerprint: String,
    pub providers: Vec<StateArchiveProvider>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateArchiveInspection {
    pub archive_path: PathBuf,
    pub verified: bool,
    pub manifest: StateArchiveManifest,
}

struct VerifiedArchive {
    manifest: StateArchiveManifest,
    payloads: BTreeMap<String, Vec<u8>>,
}

pub struct StateArchiveService {
    paths: ShipctlPaths,
    source: StateArchiveSource,
    durable_writes: DurableWriteBarrier,
    providers: Vec<Arc<dyn SnapshotProvider>>,
}

impl StateArchiveService {
    pub fn new(
        paths: ShipctlPaths,
        context: &InstanceContext,
        durable_writes: DurableWriteBarrier,
        providers: Vec<Arc<dyn SnapshotProvider>>,
    ) -> Self {
        Self {
            paths,
            source: StateArchiveSource {
                instance_id: context.instance_id,
                instance_name: context.name.clone(),
                state_root: context.state_root.clone(),
                build: context.build.clone(),
            },
            durable_writes,
            providers,
        }
    }

    pub fn save(&self, destination: &Path) -> Result<StateArchiveInspection, ControlError> {
        if destination.starts_with(&self.paths.state_root) {
            return Err(error(
                "state.snapshot.provider_failed",
                "The archive destination must be outside the instance state root",
            ));
        }
        if destination.exists() {
            return Err(error(
                "state.snapshot.destination_exists",
                format!(
                    "Archive destination already exists: {}",
                    destination.display()
                ),
            ));
        }
        let _freeze = self
            .durable_writes
            .freeze()
            .map_err(|message| error("state.snapshot.provider_failed", message))?;
        ensure_classification_complete(&self.paths.state_root, &self.providers)?;
        let (mut manifest, payloads) = capture_manifest(&self.source, &self.providers)?;
        manifest.source_state_fingerprint = fingerprint(&manifest.providers);

        let parent = destination.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).map_err(|failure| {
            error(
                "state.snapshot.provider_failed",
                format!("Could not create archive directory: {failure}"),
            )
        })?;
        let temporary = parent.join(format!(".shipctl-state-{}.tmp", Uuid::new_v4()));
        let result = (|| {
            write_archive(&temporary, &manifest, &payloads)?;
            let verified = read_and_verify(&temporary)?;
            if verified.manifest.source_state_fingerprint != manifest.source_state_fingerprint {
                return Err(error(
                    "state.snapshot.digest_mismatch",
                    "The staged archive fingerprint changed during verification",
                ));
            }
            fs::rename(&temporary, destination).map_err(|failure| {
                error(
                    "state.snapshot.provider_failed",
                    format!("Could not publish state archive: {failure}"),
                )
            })?;
            Ok(StateArchiveInspection {
                archive_path: destination.to_path_buf(),
                verified: true,
                manifest,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn fingerprint_current(&self) -> Result<String, ControlError> {
        let _freeze = self
            .durable_writes
            .freeze()
            .map_err(|message| error("state.snapshot.provider_failed", message))?;
        ensure_classification_complete(&self.paths.state_root, &self.providers)?;
        let (manifest, _) = capture_manifest(&self.source, &self.providers)?;
        Ok(fingerprint(&manifest.providers))
    }

    pub fn restore(&self, archive_path: &Path) -> Result<StateArchiveInspection, ControlError> {
        let _freeze = self
            .durable_writes
            .freeze()
            .map_err(|message| error("state.restore.provider_failed", message))?;
        ensure_empty_target(&self.paths.state_root)?;
        let verified = read_and_verify(archive_path)?;
        let provider_map = self
            .providers
            .iter()
            .map(|provider| (provider.id(), provider))
            .collect::<BTreeMap<_, _>>();
        let parent = self.paths.state_root.parent().ok_or_else(|| {
            error(
                "state.restore.provider_failed",
                "The target state root has no parent directory",
            )
        })?;
        let staging = parent.join(format!(".shipctl-restore-{}", Uuid::new_v4()));
        create_private_directory(&staging).map_err(|failure| {
            error(
                "state.restore.provider_failed",
                format!("Could not create restore staging directory: {failure}"),
            )
        })?;

        let restore_result = (|| {
            for archived_provider in &verified.manifest.providers {
                let provider =
                    provider_map
                        .get(archived_provider.id.as_str())
                        .ok_or_else(|| {
                            error(
                                "state.snapshot.incompatible_version",
                                format!(
                                    "Snapshot provider {} is not installed in this build",
                                    archived_provider.id
                                ),
                            )
                        })?;
                if provider.schema_version() != archived_provider.schema_version {
                    return Err(error(
                        "state.snapshot.incompatible_version",
                        format!(
                            "Provider {} schema {} is incompatible with supported schema {}",
                            archived_provider.id,
                            archived_provider.schema_version,
                            provider.schema_version()
                        ),
                    ));
                }
                for entry in archived_provider
                    .entries
                    .iter()
                    .filter(|entry| entry.included)
                {
                    let archive_entry = entry.archive_path.as_deref().ok_or_else(|| {
                        error(
                            "state.snapshot.unsafe_entry",
                            "Included entry has no archive path",
                        )
                    })?;
                    let payload = verified.payloads.get(archive_entry).ok_or_else(|| {
                        error(
                            "state.snapshot.digest_mismatch",
                            "Declared payload is missing",
                        )
                    })?;
                    provider
                        .validate_payload(&entry.id, payload)
                        .map_err(|message| error("state.restore.provider_failed", message))?;
                    let canonical = provider
                        .canonical_payload(&entry.id, payload)
                        .map_err(|message| error("state.restore.provider_failed", message))?;
                    if entry.state_digest_sha256.as_deref() != Some(digest(&canonical).as_str()) {
                        return Err(error(
                            "state.snapshot.digest_mismatch",
                            format!(
                                "Provider {} entry {} has a mismatched canonical state digest",
                                archived_provider.id, entry.id
                            ),
                        ));
                    }
                    provider
                        .restore_payload(&entry.id, payload, &staging)
                        .map_err(|message| error("state.restore.provider_failed", message))?;
                }
            }
            ensure_empty_target(&self.paths.state_root)?;
            fs::remove_dir(&self.paths.state_root).map_err(|failure| {
                error(
                    "state.restore.provider_failed",
                    format!("Could not promote restored profile: {failure}"),
                )
            })?;
            fs::rename(&staging, &self.paths.state_root).map_err(|failure| {
                error(
                    "state.restore.provider_failed",
                    format!("Could not promote restored profile: {failure}"),
                )
            })?;
            Ok(())
        })();
        if restore_result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        restore_result?;
        Ok(StateArchiveInspection {
            archive_path: archive_path.to_path_buf(),
            verified: true,
            manifest: verified.manifest,
        })
    }
}

pub fn inspect_archive(path: &Path) -> Result<StateArchiveInspection, ControlError> {
    let verified = read_and_verify(path)?;
    Ok(StateArchiveInspection {
        archive_path: path.to_path_buf(),
        verified: true,
        manifest: verified.manifest,
    })
}

fn capture_manifest(
    source: &StateArchiveSource,
    providers: &[Arc<dyn SnapshotProvider>],
) -> Result<(StateArchiveManifest, BTreeMap<String, Vec<u8>>), ControlError> {
    let mut providers = providers.iter().collect::<Vec<_>>();
    providers.sort_by_key(|provider| provider.id());
    let mut manifest_providers = Vec::new();
    let mut payloads = BTreeMap::new();
    let mut seen_providers = BTreeSet::new();

    for provider in providers {
        validate_identifier(provider.id())?;
        if !seen_providers.insert(provider.id()) {
            return Err(error(
                "state.snapshot.provider_failed",
                format!(
                    "Snapshot provider {} was registered more than once",
                    provider.id()
                ),
            ));
        }
        let declarations = provider.entries();
        let captured = provider.capture().map_err(|message| {
            error(
                "state.snapshot.provider_failed",
                format!(
                    "Provider {} could not capture state: {message}",
                    provider.id()
                ),
            )
        })?;
        let captured = captured
            .into_iter()
            .map(|entry| (entry.id, entry))
            .collect::<BTreeMap<_, _>>();
        let mut entries = Vec::new();
        let mut declaration_ids = BTreeSet::new();
        for declaration in declarations {
            validate_identifier(declaration.id)?;
            if !declaration_ids.insert(declaration.id) {
                return Err(error(
                    "state.snapshot.provider_failed",
                    format!(
                        "Provider {} declared duplicate entry {}",
                        provider.id(),
                        declaration.id
                    ),
                ));
            }
            for path in declaration
                .source_paths
                .iter()
                .chain(declaration.target_path.iter())
            {
                validate_relative_path(path)?;
            }
            let captured_entry = captured.get(declaration.id).ok_or_else(|| {
                error(
                    "state.snapshot.provider_failed",
                    format!(
                        "Provider {} did not classify entry {}",
                        provider.id(),
                        declaration.id
                    ),
                )
            })?;
            let included = captured_entry.payload.is_some();
            if included && declaration.classification != SnapshotClassification::Portable {
                return Err(error(
                    "state.snapshot.provider_failed",
                    format!(
                        "Provider {} emitted non-portable entry {}",
                        provider.id(),
                        declaration.id
                    ),
                ));
            }
            let archive_path =
                included.then(|| format!("payloads/{}/{}", provider.id(), declaration.id));
            let (digest_sha256, state_digest_sha256, byte_length) =
                if let Some(payload) = &captured_entry.payload {
                    provider
                        .validate_payload(declaration.id, payload)
                        .map_err(|message| error("state.snapshot.provider_failed", message))?;
                    let canonical = provider
                        .canonical_payload(declaration.id, payload)
                        .map_err(|message| error("state.snapshot.provider_failed", message))?;
                    let path = archive_path.clone().expect("included payload has path");
                    if payloads.insert(path, payload.clone()).is_some() {
                        return Err(error(
                            "state.snapshot.unsafe_entry",
                            "Duplicate archive payload path",
                        ));
                    }
                    (
                        Some(digest(payload)),
                        Some(digest(&canonical)),
                        Some(payload.len() as u64),
                    )
                } else {
                    (None, None, None)
                };
            entries.push(StateArchiveEntry {
                id: declaration.id.to_string(),
                classification: declaration.classification,
                included,
                archive_path,
                digest_sha256,
                state_digest_sha256,
                byte_length,
                source_paths: declaration
                    .source_paths
                    .iter()
                    .map(|path| relative_string(path))
                    .collect(),
                target_path: declaration
                    .target_path
                    .as_ref()
                    .map(|path| relative_string(path)),
                decision: captured_entry.decision.clone(),
                redaction: declaration.redaction.to_string(),
            });
        }
        if captured.keys().any(|id| !declaration_ids.contains(id)) {
            return Err(error(
                "state.snapshot.provider_failed",
                format!("Provider {} emitted an undeclared entry", provider.id()),
            ));
        }
        entries.sort_by(|left, right| left.id.cmp(&right.id));
        manifest_providers.push(StateArchiveProvider {
            id: provider.id().to_string(),
            schema_version: provider.schema_version(),
            entries,
        });
    }
    Ok((
        StateArchiveManifest {
            archive_schema_version: ARCHIVE_SCHEMA_VERSION,
            captured_at_unix_seconds: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0),
            source: source.clone(),
            source_state_fingerprint: String::new(),
            providers: manifest_providers,
        },
        payloads,
    ))
}

fn ensure_classification_complete(
    state_root: &Path,
    providers: &[Arc<dyn SnapshotProvider>],
) -> Result<(), ControlError> {
    for provider in providers {
        for declaration in provider.entries() {
            for path in declaration.source_paths {
                validate_relative_path(&path)?;
            }
        }
    }
    for path in files_below(state_root)? {
        if !providers
            .iter()
            .any(|provider| provider.owns_source_path(&path))
        {
            return Err(error(
                "state.snapshot.unclassified_source",
                format!("Durable source is not classified: {}", path.display()),
            ));
        }
    }
    Ok(())
}

fn files_below(root: &Path) -> Result<Vec<PathBuf>, ControlError> {
    fn walk(root: &Path, current: &Path, output: &mut Vec<PathBuf>) -> Result<(), ControlError> {
        if !current.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(current).map_err(|failure| {
            error(
                "state.snapshot.provider_failed",
                format!("Could not inspect durable sources: {failure}"),
            )
        })? {
            let entry = entry.map_err(|failure| {
                error(
                    "state.snapshot.provider_failed",
                    format!("Could not inspect durable source: {failure}"),
                )
            })?;
            let file_type = entry.file_type().map_err(|failure| {
                error(
                    "state.snapshot.provider_failed",
                    format!("Could not classify durable source: {failure}"),
                )
            })?;
            let relative = entry.path().strip_prefix(root).unwrap().to_path_buf();
            if file_type.is_symlink() {
                return Err(error(
                    "state.snapshot.unsafe_entry",
                    format!(
                        "State root contains a symbolic link: {}",
                        relative.display()
                    ),
                ));
            }
            if file_type.is_dir() {
                walk(root, &entry.path(), output)?;
            } else {
                output.push(relative);
            }
        }
        Ok(())
    }
    let mut output = Vec::new();
    walk(root, root, &mut output)?;
    Ok(output)
}

fn write_archive(
    path: &Path,
    manifest: &StateArchiveManifest,
    payloads: &BTreeMap<String, Vec<u8>>,
) -> Result<(), ControlError> {
    let file = create_private_file(path).map_err(|failure| {
        error(
            "state.snapshot.provider_failed",
            format!("Could not create state archive: {failure}"),
        )
    })?;
    let mut builder = tar::Builder::new(file);
    append_tar_entry(
        &mut builder,
        "manifest.json",
        &serde_json::to_vec(manifest).map_err(|failure| {
            error(
                "state.snapshot.provider_failed",
                format!("Could not encode state manifest: {failure}"),
            )
        })?,
    )?;
    for (archive_path, payload) in payloads {
        append_tar_entry(&mut builder, archive_path, payload)?;
    }
    builder
        .into_inner()
        .and_then(|file| file.sync_all())
        .map_err(|failure| {
            error(
                "state.snapshot.provider_failed",
                format!("Could not finalize state archive: {failure}"),
            )
        })
}

fn append_tar_entry(
    builder: &mut tar::Builder<File>,
    archive_path: &str,
    payload: &[u8],
) -> Result<(), ControlError> {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Regular);
    header.set_mode(0o600);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_size(payload.len() as u64);
    header.set_cksum();
    builder
        .append_data(&mut header, archive_path, Cursor::new(payload))
        .map_err(|failure| {
            error(
                "state.snapshot.provider_failed",
                format!("Could not write archive entry {archive_path}: {failure}"),
            )
        })
}

fn read_and_verify(path: &Path) -> Result<VerifiedArchive, ControlError> {
    let file = File::open(path).map_err(|failure| {
        error(
            "state.snapshot.provider_failed",
            format!("Could not open state archive {}: {failure}", path.display()),
        )
    })?;
    let mut archive = tar::Archive::new(file);
    let mut entries = BTreeMap::new();
    for item in archive.entries().map_err(|failure| {
        error(
            "state.snapshot.unsafe_entry",
            format!("Could not enumerate archive: {failure}"),
        )
    })? {
        let mut item = item.map_err(|failure| {
            error(
                "state.snapshot.unsafe_entry",
                format!("Could not read archive entry: {failure}"),
            )
        })?;
        if !item.header().entry_type().is_file() {
            return Err(error(
                "state.snapshot.unsafe_entry",
                "State archives may contain only regular files",
            ));
        }
        let path = item.path().map_err(|failure| {
            error(
                "state.snapshot.unsafe_entry",
                format!("Archive path is invalid: {failure}"),
            )
        })?;
        validate_relative_path(&path)?;
        let path = relative_string(&path);
        let mut payload = Vec::new();
        item.read_to_end(&mut payload).map_err(|failure| {
            error(
                "state.snapshot.unsafe_entry",
                format!("Could not read {path}: {failure}"),
            )
        })?;
        if entries.insert(path.clone(), payload).is_some() {
            return Err(error(
                "state.snapshot.unsafe_entry",
                format!("Archive contains duplicate entry {path}"),
            ));
        }
    }
    let manifest_bytes = entries.remove("manifest.json").ok_or_else(|| {
        error(
            "state.snapshot.unsafe_entry",
            "Archive does not contain manifest.json",
        )
    })?;
    let manifest: StateArchiveManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|failure| {
            error(
                "state.snapshot.unsafe_entry",
                format!("State manifest is invalid: {failure}"),
            )
        })?;
    if manifest.archive_schema_version != ARCHIVE_SCHEMA_VERSION {
        return Err(error(
            "state.snapshot.incompatible_version",
            format!(
                "Archive schema {} is incompatible with supported schema {}",
                manifest.archive_schema_version, ARCHIVE_SCHEMA_VERSION
            ),
        ));
    }
    let canonical = serde_json::to_vec(&manifest).map_err(|failure| {
        error(
            "state.snapshot.unsafe_entry",
            format!("Could not canonicalize manifest: {failure}"),
        )
    })?;
    if canonical != manifest_bytes {
        return Err(error(
            "state.snapshot.unsafe_entry",
            "manifest.json is not in canonical form",
        ));
    }
    let mut declared = BTreeSet::new();
    let mut provider_ids = BTreeSet::new();
    for provider in &manifest.providers {
        validate_identifier(&provider.id)?;
        if !provider_ids.insert(&provider.id) {
            return Err(error(
                "state.snapshot.unsafe_entry",
                "Duplicate provider in manifest",
            ));
        }
        let mut entry_ids = BTreeSet::new();
        for entry in &provider.entries {
            validate_identifier(&entry.id)?;
            if !entry_ids.insert(&entry.id) {
                return Err(error(
                    "state.snapshot.unsafe_entry",
                    "Duplicate provider entry in manifest",
                ));
            }
            if entry.included {
                if entry.classification != SnapshotClassification::Portable {
                    return Err(error(
                        "state.snapshot.unsafe_entry",
                        "Non-portable entry contains payload",
                    ));
                }
                let archive_path = entry.archive_path.as_deref().ok_or_else(|| {
                    error(
                        "state.snapshot.unsafe_entry",
                        "Included entry has no archive path",
                    )
                })?;
                validate_relative_path(Path::new(archive_path))?;
                if !declared.insert(archive_path.to_string()) {
                    return Err(error(
                        "state.snapshot.unsafe_entry",
                        "Duplicate payload declaration",
                    ));
                }
                let payload = entries.get(archive_path).ok_or_else(|| {
                    error(
                        "state.snapshot.digest_mismatch",
                        format!("Payload {archive_path} is missing"),
                    )
                })?;
                if entry.byte_length != Some(payload.len() as u64)
                    || entry.digest_sha256.as_deref() != Some(digest(payload).as_str())
                    || !entry
                        .state_digest_sha256
                        .as_deref()
                        .is_some_and(valid_sha256)
                {
                    return Err(error(
                        "state.snapshot.digest_mismatch",
                        format!("Payload {archive_path} does not match its manifest digest"),
                    ));
                }
            } else if entry.archive_path.is_some()
                || entry.digest_sha256.is_some()
                || entry.state_digest_sha256.is_some()
                || entry.byte_length.is_some()
            {
                return Err(error(
                    "state.snapshot.unsafe_entry",
                    "Excluded entry declares payload metadata",
                ));
            }
            for source in &entry.source_paths {
                validate_relative_path(Path::new(source))?;
            }
            if let Some(target) = &entry.target_path {
                validate_relative_path(Path::new(target))?;
            }
        }
    }
    if entries.keys().any(|path| !declared.contains(path)) {
        return Err(error(
            "state.snapshot.unsafe_entry",
            "Archive contains an undeclared payload",
        ));
    }
    let observed_fingerprint = fingerprint(&manifest.providers);
    if observed_fingerprint != manifest.source_state_fingerprint {
        return Err(error(
            "state.snapshot.digest_mismatch",
            "State fingerprint does not match the verified provider payloads",
        ));
    }
    Ok(VerifiedArchive {
        manifest,
        payloads: entries,
    })
}

fn fingerprint(providers: &[StateArchiveProvider]) -> String {
    let mut canonical = Vec::new();
    for provider in providers {
        for entry in provider.entries.iter().filter(|entry| entry.included) {
            canonical.extend_from_slice(provider.id.as_bytes());
            canonical.push(0);
            canonical.extend_from_slice(provider.schema_version.to_string().as_bytes());
            canonical.push(0);
            canonical.extend_from_slice(entry.id.as_bytes());
            canonical.push(0);
            canonical.extend_from_slice(
                serde_json::to_string(&entry.classification)
                    .expect("classification serializes")
                    .as_bytes(),
            );
            canonical.push(0);
            canonical.extend_from_slice(
                entry
                    .state_digest_sha256
                    .as_deref()
                    .unwrap_or("")
                    .as_bytes(),
            );
            canonical.push(b'\n');
        }
    }
    digest(&canonical)
}

fn digest(payload: &[u8]) -> String {
    format!("{:x}", Sha256::digest(payload))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn ensure_empty_target(path: &Path) -> Result<(), ControlError> {
    fs::create_dir_all(path).map_err(|failure| {
        error(
            "state.restore.provider_failed",
            format!("Could not prepare restore target: {failure}"),
        )
    })?;
    let mut entries = fs::read_dir(path).map_err(|failure| {
        error(
            "state.restore.provider_failed",
            format!("Could not inspect restore target: {failure}"),
        )
    })?;
    if entries
        .next()
        .transpose()
        .map_err(|failure| {
            error(
                "state.restore.provider_failed",
                format!("Could not inspect restore target: {failure}"),
            )
        })?
        .is_some()
    {
        return Err(error(
            "state.restore.target_not_empty",
            format!("Restore target is not empty: {}", path.display()),
        ));
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), ControlError> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(error(
            "state.snapshot.unsafe_entry",
            format!("Unsafe provider or entry identifier: {value}"),
        ));
    }
    Ok(())
}

fn validate_relative_path(path: &Path) -> Result<(), ControlError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(error(
            "state.snapshot.unsafe_entry",
            format!("Unsafe archive path: {}", path.display()),
        ));
    }
    Ok(())
}

fn relative_string(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn create_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn create_private_directory(path: &Path) -> std::io::Result<()> {
    fs::create_dir(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn error(code: &str, message: impl Into<String>) -> ControlError {
    ControlError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instance::{InstanceLaunchOptions, LaunchProvenance};
    use crate::scheduler::SchedulerSnapshotProvider;
    use shipctl_module_api::{CapturedSnapshotEntry, SnapshotEntryDeclaration};

    struct FixtureProvider {
        path: PathBuf,
        reject_restore: bool,
        fail_capture: bool,
    }

    impl SnapshotProvider for FixtureProvider {
        fn id(&self) -> &'static str {
            "fixture.state"
        }

        fn schema_version(&self) -> u32 {
            1
        }

        fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
            vec![
                SnapshotEntryDeclaration {
                    id: "portable",
                    classification: SnapshotClassification::Portable,
                    source_paths: vec![PathBuf::from("portable.bin")],
                    target_path: Some(PathBuf::from("portable.bin")),
                    redaction: "none",
                },
                SnapshotEntryDeclaration {
                    id: "secret",
                    classification: SnapshotClassification::Secret,
                    source_paths: Vec::new(),
                    target_path: None,
                    redaction: "always excluded",
                },
            ]
        }

        fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
            if self.fail_capture {
                return Err("fixture capture failed".to_string());
            }
            Ok(vec![
                CapturedSnapshotEntry {
                    id: "portable",
                    payload: self.path.exists().then(|| fs::read(&self.path).unwrap()),
                    decision: "included".to_string(),
                },
                CapturedSnapshotEntry {
                    id: "secret",
                    payload: None,
                    decision: "excluded_by_classification".to_string(),
                },
            ])
        }

        fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String> {
            if self.reject_restore {
                return Err("fixture rejected restore".to_string());
            }
            if entry_id != "portable" || payload.is_empty() {
                return Err("fixture payload is invalid".to_string());
            }
            Ok(())
        }
    }

    fn fixture_context(root: &Path, name: &str) -> InstanceContext {
        InstanceContext::resolve(
            InstanceLaunchOptions {
                name: Some(name.to_string()),
                state_root: Some(root.join(name).join("state")),
                runtime_root: Some(root.join(name).join("runtime")),
                load_state: None,
                provenance: Some(LaunchProvenance::Cli),
            },
            "1.0.0",
        )
        .unwrap()
    }

    fn fixture_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "shipctl-state-archive-{label}-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        ))
    }

    fn service(
        context: &InstanceContext,
        reject_restore: bool,
        fail_capture: bool,
    ) -> StateArchiveService {
        let paths = context.paths();
        StateArchiveService::new(
            paths.clone(),
            context,
            DurableWriteBarrier::default(),
            vec![Arc::new(FixtureProvider {
                path: paths.state_root.join("portable.bin"),
                reject_restore,
                fail_capture,
            })],
        )
    }

    fn scheduler_service(context: &InstanceContext) -> StateArchiveService {
        let paths = context.paths();
        StateArchiveService::new(
            paths.clone(),
            context,
            DurableWriteBarrier::default(),
            vec![Arc::new(SchedulerSnapshotProvider::new(
                paths.schedule_root.clone(),
            ))],
        )
    }

    #[test]
    fn round_trip_preserves_portable_fingerprint_but_not_runtime_identity() {
        let root = fixture_root("round-trip");
        let source = fixture_context(&root, "source");
        fs::write(source.state_root.join("portable.bin"), b"portable-state").unwrap();
        let archive = root.join("snapshot.shipctl-state");
        let saved = service(&source, false, false).save(&archive).unwrap();

        let target = fixture_context(&root, "target");
        let restored = service(&target, false, false).restore(&archive).unwrap();

        assert_eq!(
            saved.manifest.source_state_fingerprint,
            restored.manifest.source_state_fingerprint
        );
        assert_eq!(
            service(&target, false, false)
                .fingerprint_current()
                .unwrap(),
            saved.manifest.source_state_fingerprint
        );
        assert_eq!(
            fs::read(target.state_root.join("portable.bin")).unwrap(),
            b"portable-state"
        );
        assert_ne!(source.instance_id, target.instance_id);
        assert_ne!(source.name, target.name);
        assert_ne!(source.state_root, target.state_root);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn save_rejects_unclassified_sources_and_provider_failure_publishes_nothing() {
        let root = fixture_root("save-failures");
        let source = fixture_context(&root, "source");
        fs::write(source.state_root.join("portable.bin"), b"portable-state").unwrap();
        fs::write(source.state_root.join("unknown.cache"), b"unclassified").unwrap();
        let archive = root.join("unclassified.shipctl-state");

        let failure = service(&source, false, false).save(&archive).unwrap_err();
        assert_eq!(failure.code.as_str(), "state.snapshot.unclassified_source");
        assert!(!archive.exists());

        fs::remove_file(source.state_root.join("unknown.cache")).unwrap();
        let failed_archive = root.join("provider-failed.shipctl-state");
        let failure = service(&source, false, true)
            .save(&failed_archive)
            .unwrap_err();
        assert_eq!(failure.code.as_str(), "state.snapshot.provider_failed");
        assert!(!failed_archive.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scheduler_sources_are_portable_but_other_schedule_root_files_fail_closed() {
        let root = fixture_root("scheduler-sources");
        let source = fixture_context(&root, "source");
        let source_paths = source.paths();
        fs::create_dir(&source_paths.schedule_root).unwrap();
        fs::write(
            source_paths.schedule_root.join("wakeup.yaml"),
            b"schema_version: 1\nid: agents.wakeup\n",
        )
        .unwrap();
        let archive = root.join("scheduler.shipctl-state");
        let saved = scheduler_service(&source).save(&archive).unwrap();
        assert!(saved.manifest.providers[0].entries[0].included);

        let target = fixture_context(&root, "target");
        scheduler_service(&target).restore(&archive).unwrap();
        assert_eq!(
            fs::read(target.paths().schedule_root.join("wakeup.yaml")).unwrap(),
            b"schema_version: 1\nid: agents.wakeup\n"
        );

        fs::write(
            source_paths.schedule_root.join("notes.txt"),
            b"not a schedule",
        )
        .unwrap();
        let rejected = scheduler_service(&source)
            .save(&root.join("scheduler-invalid.shipctl-state"))
            .unwrap_err();
        assert_eq!(rejected.code.as_str(), "state.snapshot.unclassified_source");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn verify_rejects_digest_corruption_and_undeclared_entries() {
        let root = fixture_root("corruption");
        let source = fixture_context(&root, "source");
        fs::write(source.state_root.join("portable.bin"), b"portable-state").unwrap();
        let archive = root.join("valid.shipctl-state");
        service(&source, false, false).save(&archive).unwrap();

        let mut entries = read_test_entries(&archive);
        entries.insert(
            "payloads/fixture.state/portable".to_string(),
            b"tampered".to_vec(),
        );
        let corrupt = root.join("corrupt.shipctl-state");
        write_test_entries(&corrupt, &entries);
        assert_eq!(
            inspect_archive(&corrupt).unwrap_err().code.as_str(),
            "state.snapshot.digest_mismatch"
        );

        let mut entries = read_test_entries(&archive);
        entries.insert("undeclared".to_string(), b"surprise".to_vec());
        let unsafe_archive = root.join("unsafe.shipctl-state");
        write_test_entries(&unsafe_archive, &entries);
        assert_eq!(
            inspect_archive(&unsafe_archive).unwrap_err().code.as_str(),
            "state.snapshot.unsafe_entry"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn restore_rejects_nonempty_targets_and_provider_failure_leaves_them_empty() {
        let root = fixture_root("restore-failures");
        let source = fixture_context(&root, "source");
        fs::write(source.state_root.join("portable.bin"), b"portable-state").unwrap();
        let archive = root.join("snapshot.shipctl-state");
        service(&source, false, false).save(&archive).unwrap();

        let nonempty = fixture_context(&root, "nonempty");
        fs::write(nonempty.state_root.join("existing"), b"keep").unwrap();
        let failure = service(&nonempty, false, false)
            .restore(&archive)
            .unwrap_err();
        assert_eq!(failure.code.as_str(), "state.restore.target_not_empty");
        assert_eq!(
            fs::read(nonempty.state_root.join("existing")).unwrap(),
            b"keep"
        );

        let rejected = fixture_context(&root, "rejected");
        let failure = service(&rejected, true, false)
            .restore(&archive)
            .unwrap_err();
        assert_eq!(failure.code.as_str(), "state.restore.provider_failed");
        assert!(fs::read_dir(&rejected.state_root).unwrap().next().is_none());
        let _ = fs::remove_dir_all(root);
    }

    fn read_test_entries(path: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut entries = BTreeMap::new();
        for item in tar::Archive::new(File::open(path).unwrap())
            .entries()
            .unwrap()
        {
            let mut item = item.unwrap();
            let path = item.path().unwrap().to_string_lossy().to_string();
            let mut payload = Vec::new();
            item.read_to_end(&mut payload).unwrap();
            entries.insert(path, payload);
        }
        entries
    }

    fn write_test_entries(path: &Path, entries: &BTreeMap<String, Vec<u8>>) {
        let file = create_private_file(path).unwrap();
        let mut builder = tar::Builder::new(file);
        if let Some(manifest) = entries.get("manifest.json") {
            append_tar_entry(&mut builder, "manifest.json", manifest).unwrap();
        }
        for (entry_path, payload) in entries {
            if entry_path != "manifest.json" {
                append_tar_entry(&mut builder, entry_path, payload).unwrap();
            }
        }
        builder.into_inner().unwrap().sync_all().unwrap();
    }
}
