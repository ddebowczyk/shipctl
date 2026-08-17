//! Read an instance's schedule directory into an immutable candidate.
//!
//! This module deliberately has no accepted-state, watcher, timer, or runtime
//! ownership. Its only job is to make a complete, deterministic candidate that
//! a scheduler service can preflight and publish atomically.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::contracts::{
    normalized_schedule_path, parse_schedule_source, schedule_snapshot, ScheduleDefinition,
    ScheduleSnapshot, SCHEDULE_INSPECTION_SCHEMA_VERSION,
};
use super::diagnostics::{
    ScheduleDiagnostic, ScheduleDiagnosticSeverity, DUPLICATE_ID, SOURCE_INVALID,
    SOURCE_NOT_REGULAR, SOURCE_PATH_UNSAFE,
};

/// A complete schedule-directory candidate prepared without mutating accepted
/// scheduler state. Definitions remain private until the whole candidate is
/// valid, preventing route preflight or publication of a partial directory.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScheduleLoadCandidate {
    definitions: Vec<ScheduleDefinition>,
    diagnostics: Vec<ScheduleDiagnostic>,
}

impl ScheduleLoadCandidate {
    /// Returns whether this complete candidate can move to route preflight and
    /// eventual publication.
    pub fn is_valid(&self) -> bool {
        self.diagnostics.is_empty()
    }

    /// Returns the complete, stable diagnostics for this candidate.
    pub fn diagnostics(&self) -> &[ScheduleDiagnostic] {
        &self.diagnostics
    }

    /// Borrows definitions only when the whole candidate is valid.
    pub fn validated_definitions(&self) -> Result<&[ScheduleDefinition], &[ScheduleDiagnostic]> {
        if self.is_valid() {
            Ok(&self.definitions)
        } else {
            Err(&self.diagnostics)
        }
    }

    /// Consumes the candidate into definitions only when the whole directory
    /// was valid. This lets a service perform subsequent route preflight
    /// without exposing mutable candidate state.
    pub fn into_validated_definitions(
        self,
    ) -> Result<Vec<ScheduleDefinition>, Vec<ScheduleDiagnostic>> {
        if self.is_valid() {
            Ok(self.definitions)
        } else {
            Err(self.diagnostics)
        }
    }

    /// Builds the deterministic snapshot only for a diagnostic-free candidate.
    ///
    /// The returned diagnostics are the complete rejection reason rather than
    /// a partial snapshot, so callers cannot accidentally publish a subset.
    pub fn valid_snapshot(
        &self,
        generation: u64,
    ) -> Result<ScheduleSnapshot, Vec<ScheduleDiagnostic>> {
        if !self.is_valid() {
            return Err(self.diagnostics.clone());
        }
        schedule_snapshot(generation, self.definitions.clone())
            .map_err(|error| vec![schedule_diagnostic(error.code.as_str(), None, None)])
    }

    /// Adds ephemeral activation-owned definitions to the complete source
    /// candidate. They follow the same duplicate-identity rule as files, but
    /// do not need a durable source path because their owning activation is
    /// already reconstructed from the module registry on restart.
    pub fn with_runtime_definitions(
        mut self,
        definitions: impl IntoIterator<Item = ScheduleDefinition>,
    ) -> Self {
        self.definitions.extend(definitions);
        self.definitions
            .sort_by(|left, right| left.source_path.cmp(&right.source_path));
        self.diagnostics
            .retain(|diagnostic| diagnostic.code != DUPLICATE_ID);
        append_duplicate_id_diagnostics(&self.definitions, &mut self.diagnostics);
        sort_diagnostics(&mut self.diagnostics);
        self
    }
}

/// Discovers every direct source in `schedule_root`, parses all admissible
/// files in normalized path order, and validates duplicate schedule identities.
///
/// A missing directory is an empty, valid candidate. Every other discovery or
/// parsing failure is retained as a stable diagnostic while the remaining
/// sources continue to be examined. The filesystem is never modified.
pub fn load_schedule_candidate(schedule_root: &Path) -> ScheduleLoadCandidate {
    let mut candidate = ScheduleLoadCandidate::default();
    let sources = match discover_schedule_sources(schedule_root, &mut candidate.diagnostics) {
        Some(sources) => sources,
        None => {
            sort_diagnostics(&mut candidate.diagnostics);
            return candidate;
        }
    };

    let mut readable_sources = Vec::new();
    for source in sources {
        match fs::read_to_string(&source.filesystem_path) {
            Ok(contents) => readable_sources.push((source.source_path, contents)),
            Err(_) => candidate.diagnostics.push(schedule_diagnostic(
                SOURCE_INVALID,
                Some(source.source_path),
                None,
            )),
        }
    }

    for (source_path, contents) in readable_sources {
        match parse_schedule_source(Path::new(&source_path), &contents) {
            Ok(definition) => candidate.definitions.push(definition),
            Err(error) => candidate
                .diagnostics
                .push(error.diagnostic(Some(source_path), None)),
        }
    }

    candidate
        .definitions
        .sort_by(|left, right| left.source_path.cmp(&right.source_path));
    append_duplicate_id_diagnostics(&candidate.definitions, &mut candidate.diagnostics);
    sort_diagnostics(&mut candidate.diagnostics);
    candidate
}

#[derive(Debug)]
struct ScheduleSource {
    source_path: String,
    filesystem_path: PathBuf,
}

fn discover_schedule_sources(
    schedule_root: &Path,
    diagnostics: &mut Vec<ScheduleDiagnostic>,
) -> Option<Vec<ScheduleSource>> {
    match fs::symlink_metadata(schedule_root) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            diagnostics.push(schedule_diagnostic(SOURCE_PATH_UNSAFE, None, None));
            return None;
        }
        Ok(metadata) if !metadata.is_dir() => {
            diagnostics.push(schedule_diagnostic(SOURCE_NOT_REGULAR, None, None));
            return None;
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => {
            diagnostics.push(schedule_diagnostic(SOURCE_INVALID, None, None));
            return None;
        }
    }

    let entries = match fs::read_dir(schedule_root) {
        Ok(entries) => entries,
        Err(_) => {
            diagnostics.push(schedule_diagnostic(SOURCE_INVALID, None, None));
            return None;
        }
    };
    let mut sources = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                diagnostics.push(schedule_diagnostic(SOURCE_INVALID, None, None));
                continue;
            }
        };
        let path = entry.path();
        let source_path = match classify_schedule_entry(schedule_root, &path) {
            ScheduleEntryClassification::Ignore => continue,
            ScheduleEntryClassification::Unsafe => {
                diagnostics.push(schedule_diagnostic(SOURCE_PATH_UNSAFE, None, None));
                continue;
            }
            ScheduleEntryClassification::Eligible(source_path) => source_path,
        };
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                diagnostics.push(schedule_diagnostic(SOURCE_INVALID, Some(source_path), None));
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            diagnostics.push(schedule_diagnostic(
                SOURCE_PATH_UNSAFE,
                Some(source_path),
                None,
            ));
            continue;
        }
        if !metadata.is_file() {
            diagnostics.push(schedule_diagnostic(
                SOURCE_NOT_REGULAR,
                Some(source_path),
                None,
            ));
            continue;
        }
        sources.push(ScheduleSource {
            source_path,
            filesystem_path: path,
        });
    }
    sources.sort_by(|left, right| left.source_path.cmp(&right.source_path));
    Some(sources)
}

enum ScheduleEntryClassification {
    Ignore,
    Eligible(String),
    Unsafe,
}

fn classify_schedule_entry(schedule_root: &Path, path: &Path) -> ScheduleEntryClassification {
    let Ok(relative) = path.strip_prefix(schedule_root) else {
        return ScheduleEntryClassification::Unsafe;
    };
    if relative.components().count() != 1
        || !matches!(relative.components().next(), Some(Component::Normal(_)))
    {
        return ScheduleEntryClassification::Unsafe;
    }
    let has_schedule_extension = matches!(
        relative
            .extension()
            .and_then(|extension| extension.to_str()),
        Some("yaml" | "yml")
    );
    if !has_schedule_extension {
        return ScheduleEntryClassification::Ignore;
    }
    match normalized_schedule_path(relative) {
        Ok(source_path) => ScheduleEntryClassification::Eligible(source_path),
        Err(_) => ScheduleEntryClassification::Unsafe,
    }
}

fn append_duplicate_id_diagnostics(
    definitions: &[ScheduleDefinition],
    diagnostics: &mut Vec<ScheduleDiagnostic>,
) {
    let mut paths_by_id = BTreeMap::<&str, Vec<&str>>::new();
    for definition in definitions {
        paths_by_id
            .entry(&definition.id)
            .or_default()
            .push(&definition.source_path);
    }
    for (id, paths) in paths_by_id {
        if paths.len() > 1 {
            for source_path in paths {
                diagnostics.push(schedule_diagnostic(
                    DUPLICATE_ID,
                    Some(source_path.to_string()),
                    Some(id.to_string()),
                ));
            }
        }
    }
}

fn schedule_diagnostic(
    code: &str,
    source_path: Option<String>,
    schedule_id: Option<String>,
) -> ScheduleDiagnostic {
    ScheduleDiagnostic {
        schema_version: SCHEDULE_INSPECTION_SCHEMA_VERSION,
        code: code.to_string(),
        severity: ScheduleDiagnosticSeverity::Error,
        source_path,
        schedule_id,
        context: Default::default(),
    }
}

fn sort_diagnostics(diagnostics: &mut [ScheduleDiagnostic]) {
    diagnostics.sort_by(|left, right| {
        left.source_path
            .cmp(&right.source_path)
            .then_with(|| left.schedule_id.cmp(&right.schedule_id))
            .then_with(|| left.code.cmp(&right.code))
    });
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    const VALID: &str = include_str!("../../fixtures/scheduler/sources/valid-channel.yaml");
    const INVALID: &str =
        include_str!("../../fixtures/scheduler/sources/invalid-unknown-field.yaml");
    const DUPLICATE: &str = include_str!("../../fixtures/scheduler/sources/duplicate-b.yaml");

    #[test]
    fn candidate_parses_direct_sources_in_normalized_order() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("z.yaml"), VALID).unwrap();
        fs::write(
            root.path().join("a.yml"),
            VALID.replacen("agents.wakeup", "agents.alpha", 1),
        )
        .unwrap();

        let candidate = load_schedule_candidate(root.path());

        assert!(candidate.diagnostics().is_empty());
        assert_eq!(
            candidate
                .validated_definitions()
                .unwrap()
                .iter()
                .map(|definition| definition.source_path.as_str())
                .collect::<Vec<_>>(),
            ["a.yml", "z.yaml"]
        );
        assert_eq!(
            candidate.valid_snapshot(8).unwrap().definitions.as_slice(),
            candidate.validated_definitions().unwrap()
        );
    }

    #[test]
    fn candidate_digest_is_independent_of_directory_enumeration_order() {
        let first_root = tempdir().unwrap();
        let second_root = tempdir().unwrap();
        let alpha = VALID.replacen("agents.wakeup", "agents.alpha", 1);

        fs::write(first_root.path().join("z.yaml"), VALID).unwrap();
        fs::write(first_root.path().join("a.yaml"), &alpha).unwrap();
        fs::write(second_root.path().join("a.yaml"), &alpha).unwrap();
        fs::write(second_root.path().join("z.yaml"), VALID).unwrap();

        let first = load_schedule_candidate(first_root.path());
        let second = load_schedule_candidate(second_root.path());

        assert_eq!(
            first.valid_snapshot(5).unwrap().digest_sha256,
            second.valid_snapshot(5).unwrap().digest_sha256
        );
    }

    #[test]
    fn candidate_collects_all_source_diagnostics_without_partial_acceptance() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("valid.yaml"), VALID).unwrap();
        fs::write(root.path().join("invalid.yml"), INVALID).unwrap();
        fs::write(
            root.path().join("duplicate-a.yaml"),
            include_str!("../../fixtures/scheduler/sources/duplicate-a.yaml"),
        )
        .unwrap();
        fs::write(root.path().join("duplicate-b.yaml"), DUPLICATE).unwrap();

        let candidate = load_schedule_candidate(root.path());

        assert!(!candidate.is_valid());
        assert_eq!(candidate.validated_definitions().unwrap_err().len(), 3);
        assert!(candidate.diagnostics().iter().any(|diagnostic| {
            diagnostic.code == super::super::diagnostics::SOURCE_UNKNOWN_FIELD
                && diagnostic.source_path.as_deref() == Some("invalid.yml")
        }));
        assert!(candidate.diagnostics().iter().any(|diagnostic| {
            diagnostic.code == DUPLICATE_ID
                && diagnostic.source_path.as_deref() == Some("duplicate-b.yaml")
                && diagnostic.schedule_id.as_deref() == Some("agents.duplicate")
        }));
        assert!(candidate.valid_snapshot(9).is_err());
    }

    #[test]
    fn missing_or_empty_root_is_a_valid_empty_candidate() {
        let root = tempdir().unwrap();
        let missing = root.path().join("missing");
        assert_eq!(
            load_schedule_candidate(&missing),
            ScheduleLoadCandidate::default()
        );

        fs::create_dir(&missing).unwrap();
        let candidate = load_schedule_candidate(&missing);
        assert!(candidate.is_valid());
        assert!(candidate.valid_snapshot(3).unwrap().definitions.is_empty());
    }

    #[test]
    fn candidate_ignores_non_schedule_entries() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("nested")).unwrap();
        fs::write(root.path().join("notes.txt"), "not a schedule").unwrap();

        let candidate = load_schedule_candidate(root.path());

        assert!(candidate.is_valid());
        assert!(candidate.diagnostics().is_empty());
        assert!(candidate.valid_snapshot(3).unwrap().definitions.is_empty());
    }

    #[test]
    fn candidate_rejects_nonregular_schedule_entries() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join("nested.yaml")).unwrap();

        let candidate = load_schedule_candidate(root.path());

        assert!(!candidate.is_valid());
        assert!(candidate.diagnostics().iter().any(|diagnostic| {
            diagnostic.code == SOURCE_NOT_REGULAR
                && diagnostic.source_path.as_deref() == Some("nested.yaml")
        }));
    }

    #[cfg(unix)]
    #[test]
    fn candidate_rejects_symlink_sources() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let target = root.path().join("outside.yaml");
        fs::write(&target, VALID).unwrap();
        symlink(&target, root.path().join("linked.yaml")).unwrap();

        let candidate = load_schedule_candidate(root.path());

        assert!(!candidate.is_valid());
        assert!(candidate.diagnostics().iter().any(|diagnostic| {
            diagnostic.code == SOURCE_PATH_UNSAFE
                && diagnostic.source_path.as_deref() == Some("linked.yaml")
        }));
    }
}
