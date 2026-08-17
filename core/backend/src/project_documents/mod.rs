//! Scoped, revision-aware access to text documents inside registered projects.
//!
//! This provider owns filesystem authority and atomic publication. It contains
//! no Todo parsing, ordering, mutation, or presentation policy. Callers choose
//! the bounded file names that they want to discover and interpret the returned
//! text in TypeScript.

#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::workspace::manager::WorkspaceManager;

pub const PROJECT_DOCUMENTS_TRANSPORT_FAILED: &str = "project-documents.transport-failed";
pub const PROJECT_DOCUMENTS_DENIED: &str = "project-documents.denied";
pub const PROJECT_DOCUMENTS_INVALID_PROJECT: &str = "project-documents.invalid-project";
pub const PROJECT_DOCUMENTS_INVALID_PATH: &str = "project-documents.invalid-path";
pub const PROJECT_DOCUMENTS_NOT_FOUND: &str = "project-documents.not-found";
pub const PROJECT_DOCUMENTS_CONFLICT: &str = "project-documents.conflict";
pub const PROJECT_DOCUMENTS_TOO_LARGE: &str = "project-documents.too-large";
pub const PROJECT_DOCUMENTS_INVALID_CONTENT: &str = "project-documents.invalid-content";
pub const PROJECT_DOCUMENTS_ACTIVATION_DISPOSED: &str = "project-documents.activation-disposed";
pub const PROJECT_DOCUMENTS_INVALID_REQUEST: &str = "project-documents.invalid-request";

// These bounds preserve the characterized behavior of the extracted provider.
const MAX_SCAN_DEPTH: usize = 3;
const MAX_DOCUMENTS: usize = 20;
const MAX_DOCUMENT_BYTES: u64 = 1024 * 1024;
const UNSCANNED_DIRECTORIES: &[&str] = &[
    "node_modules",
    "target",
    ".next",
    "dist",
    "build",
    "__pycache__",
    "vendor",
    ".shipctl-worktrees",
    ".shep-worktrees",
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectDocumentsActor {
    pub module_id: String,
    pub activation_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoverProjectDocumentsInput {
    pub project_id: String,
    pub file_names: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadProjectDocumentInput {
    pub project_id: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteProjectDocumentInput {
    pub project_id: String,
    pub relative_path: String,
    pub expected_revision: Option<String>,
    pub contents: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocument {
    pub project_id: String,
    pub relative_path: String,
    pub contents: String,
    pub revision: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocumentsError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// The host-owned registry that establishes which project roots are in scope.
pub trait ProjectCatalog: Send + Sync {
    fn registered_project_paths(&self) -> Result<Vec<String>, String>;
}

impl ProjectCatalog for WorkspaceManager {
    fn registered_project_paths(&self) -> Result<Vec<String>, String> {
        self.list_repos()
            .map(|repos| repos.into_iter().map(|repo| repo.path).collect())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProjectDocumentGrant {
    Read,
    Write,
}

#[derive(Clone, Debug)]
struct ProjectDocumentPolicy {
    module_id: &'static str,
    grants: &'static [ProjectDocumentGrant],
}

#[cfg(test)]
const READ_ONLY: &[ProjectDocumentGrant] = &[ProjectDocumentGrant::Read];
const READ_AND_WRITE: &[ProjectDocumentGrant] =
    &[ProjectDocumentGrant::Read, ProjectDocumentGrant::Write];
const DEFAULT_POLICIES: &[ProjectDocumentPolicy] = &[
    ProjectDocumentPolicy {
        module_id: "core",
        grants: READ_AND_WRITE,
    },
    ProjectDocumentPolicy {
        module_id: "shipctl.todos",
        grants: READ_AND_WRITE,
    },
];

#[derive(Default)]
struct ProjectDocumentsState {
    released_activations: HashSet<String>,
}

struct ProjectDocumentsServiceInner {
    projects: Arc<dyn ProjectCatalog>,
    policies: Vec<ProjectDocumentPolicy>,
    state: Mutex<ProjectDocumentsState>,
    write_lock: Mutex<()>,
}

#[derive(Clone)]
pub struct ProjectDocumentsService {
    inner: Arc<ProjectDocumentsServiceInner>,
}

impl ProjectDocumentsService {
    pub fn workspace(workspace: WorkspaceManager) -> Self {
        Self::new(Arc::new(workspace))
    }

    pub fn new(projects: Arc<dyn ProjectCatalog>) -> Self {
        Self::with_policies(projects, DEFAULT_POLICIES.to_vec())
    }

    fn with_policies(
        projects: Arc<dyn ProjectCatalog>,
        policies: Vec<ProjectDocumentPolicy>,
    ) -> Self {
        Self {
            inner: Arc::new(ProjectDocumentsServiceInner {
                projects,
                policies,
                state: Mutex::new(ProjectDocumentsState::default()),
                write_lock: Mutex::new(()),
            }),
        }
    }

    pub fn discover_documents(
        &self,
        actor: &ProjectDocumentsActor,
        input: DiscoverProjectDocumentsInput,
    ) -> Result<Vec<ProjectDocument>, ProjectDocumentsError> {
        self.authorize(actor, ProjectDocumentGrant::Read)?;
        let root = self.project_root(&input.project_id)?;
        let names = validate_discovery_names(&input.file_names)?;
        let mut found = Vec::new();
        scan_document_paths(&root, 0, &names, &mut found);
        found.sort_by_key(|path| {
            let relative = path.strip_prefix(&root).unwrap_or(path);
            (relative.components().count(), relative.to_path_buf())
        });
        found.truncate(MAX_DOCUMENTS);
        found
            .into_iter()
            .filter_map(|path| {
                let relative = path.strip_prefix(&root).ok()?.to_string_lossy().to_string();
                Some(
                    existing_document_path(&root, &relative).and_then(|canonical| {
                        read_document(&input.project_id, &relative, &canonical)
                    }),
                )
            })
            .collect()
    }

    pub fn read_document(
        &self,
        actor: &ProjectDocumentsActor,
        input: ReadProjectDocumentInput,
    ) -> Result<ProjectDocument, ProjectDocumentsError> {
        self.authorize(actor, ProjectDocumentGrant::Read)?;
        let root = self.project_root(&input.project_id)?;
        let path = existing_document_path(&root, &input.relative_path)?;
        read_document(&input.project_id, &input.relative_path, &path)
    }

    pub fn write_document(
        &self,
        actor: &ProjectDocumentsActor,
        input: WriteProjectDocumentInput,
    ) -> Result<ProjectDocument, ProjectDocumentsError> {
        self.authorize(actor, ProjectDocumentGrant::Write)?;
        if input.contents.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(error(
                PROJECT_DOCUMENTS_TOO_LARGE,
                format!("Document exceeds {MAX_DOCUMENT_BYTES} bytes"),
            ));
        }

        let _guard = self.inner.write_lock.lock().map_err(|_| {
            error(
                PROJECT_DOCUMENTS_TRANSPORT_FAILED,
                "Project document write lock is unavailable",
            )
        })?;
        // Recheck after waiting for another activation's write. Disposal and
        // revision conflicts must be observed at the publication boundary.
        self.authorize(actor, ProjectDocumentGrant::Write)?;

        let root = self.project_root(&input.project_id)?;
        let relative = relative_document_path(&input.relative_path)?;
        let requested_target = root.join(relative);
        let current = if requested_target.exists() {
            let canonical = existing_document_path(&root, &input.relative_path)?;
            Some(read_document(
                &input.project_id,
                &input.relative_path,
                &canonical,
            )?)
        } else {
            None
        };
        let revision_matches = match (&input.expected_revision, &current) {
            (None, None) => true,
            (Some(expected), Some(document)) => expected == &document.revision,
            _ => false,
        };
        if !revision_matches {
            return Err(error(
                PROJECT_DOCUMENTS_CONFLICT,
                "Project document revision does not match",
            ));
        }

        let parent = requested_target.parent().ok_or_else(|| {
            error(
                PROJECT_DOCUMENTS_INVALID_PATH,
                "Document path has no project-relative parent",
            )
        })?;
        let canonical_parent = fs::canonicalize(parent).map_err(|source| {
            error(
                PROJECT_DOCUMENTS_INVALID_PATH,
                format!("Document parent does not exist: {source}"),
            )
        })?;
        if !canonical_parent.starts_with(&root) {
            return Err(error(
                PROJECT_DOCUMENTS_DENIED,
                "Document parent is outside the granted project path",
            ));
        }
        let file_name = relative.file_name().ok_or_else(|| {
            error(
                PROJECT_DOCUMENTS_INVALID_PATH,
                "Document path has no file name",
            )
        })?;
        let publish_target = canonical_parent.join(file_name);

        let mut temporary =
            tempfile::NamedTempFile::new_in(&canonical_parent).map_err(|source| {
                error(
                    PROJECT_DOCUMENTS_TRANSPORT_FAILED,
                    format!("Failed to create temporary document: {source}"),
                )
            })?;
        if let Some(document) = &current {
            let current_path = existing_document_path(&root, &document.relative_path)?;
            let permissions = fs::metadata(current_path)
                .map_err(|source| {
                    error(
                        PROJECT_DOCUMENTS_TRANSPORT_FAILED,
                        format!("Failed to inspect document permissions: {source}"),
                    )
                })?
                .permissions();
            temporary
                .as_file()
                .set_permissions(permissions)
                .map_err(|source| {
                    error(
                        PROJECT_DOCUMENTS_TRANSPORT_FAILED,
                        format!("Failed to preserve document permissions: {source}"),
                    )
                })?;
        }
        temporary
            .write_all(input.contents.as_bytes())
            .and_then(|_| temporary.flush())
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|source| {
                error(
                    PROJECT_DOCUMENTS_TRANSPORT_FAILED,
                    format!("Failed to write temporary document: {source}"),
                )
            })?;
        temporary.persist(&publish_target).map_err(|source| {
            error(
                PROJECT_DOCUMENTS_TRANSPORT_FAILED,
                format!("Failed to publish project document: {}", source.error),
            )
        })?;
        let _ = fs::File::open(&canonical_parent).and_then(|directory| directory.sync_all());
        read_document(&input.project_id, &input.relative_path, &publish_target)
    }

    /// Revoke one activation without changing any project-owned document.
    pub fn release_activation(
        &self,
        actor: &ProjectDocumentsActor,
    ) -> Result<bool, ProjectDocumentsError> {
        validate_actor(actor)?;
        self.require_known_actor(&actor.module_id)?;
        Ok(self
            .lock_state()?
            .released_activations
            .insert(actor.activation_id.clone()))
    }

    fn authorize(
        &self,
        actor: &ProjectDocumentsActor,
        grant: ProjectDocumentGrant,
    ) -> Result<(), ProjectDocumentsError> {
        validate_actor(actor)?;
        self.require_grant(&actor.module_id, grant)?;
        if self
            .lock_state()?
            .released_activations
            .contains(&actor.activation_id)
        {
            return Err(error(
                PROJECT_DOCUMENTS_ACTIVATION_DISPOSED,
                "The project documents capability activation is disposed",
            ));
        }
        Ok(())
    }

    fn require_known_actor(&self, module_id: &str) -> Result<(), ProjectDocumentsError> {
        self.inner
            .policies
            .iter()
            .any(|policy| policy.module_id == module_id)
            .then_some(())
            .ok_or_else(|| {
                error(
                    PROJECT_DOCUMENTS_DENIED,
                    "Project document capability access was denied",
                )
            })
    }

    fn require_grant(
        &self,
        module_id: &str,
        grant: ProjectDocumentGrant,
    ) -> Result<(), ProjectDocumentsError> {
        self.inner
            .policies
            .iter()
            .find(|policy| policy.module_id == module_id && policy.grants.contains(&grant))
            .map(|_| ())
            .ok_or_else(|| {
                error(
                    PROJECT_DOCUMENTS_DENIED,
                    "Project document capability access was denied",
                )
            })
    }

    fn project_root(&self, project_id: &str) -> Result<PathBuf, ProjectDocumentsError> {
        let projects = self
            .inner
            .projects
            .registered_project_paths()
            .map_err(|source| {
                error(
                    PROJECT_DOCUMENTS_TRANSPORT_FAILED,
                    format!("Failed to inspect registered projects: {source}"),
                )
            })?;
        let registered = projects
            .iter()
            .find(|candidate| candidate.as_str() == project_id)
            .ok_or_else(|| {
                error(
                    PROJECT_DOCUMENTS_INVALID_PROJECT,
                    "Project is not registered with Shipctl",
                )
            })?;
        let root = fs::canonicalize(registered).map_err(|source| {
            error(
                PROJECT_DOCUMENTS_INVALID_PROJECT,
                format!("Registered project cannot be resolved: {source}"),
            )
        })?;
        if !root.is_dir() {
            return Err(error(
                PROJECT_DOCUMENTS_INVALID_PROJECT,
                "Registered project is not a directory",
            ));
        }
        Ok(root)
    }

    fn lock_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, ProjectDocumentsState>, ProjectDocumentsError> {
        self.inner.state.lock().map_err(|_| {
            error(
                PROJECT_DOCUMENTS_TRANSPORT_FAILED,
                "Project document capability state lock is poisoned",
            )
        })
    }
}

fn validate_actor(actor: &ProjectDocumentsActor) -> Result<(), ProjectDocumentsError> {
    validate_identity(&actor.module_id, "module ID")?;
    validate_identity(&actor.activation_id, "activation ID")?;
    if !actor
        .activation_id
        .starts_with(&format!("{}@", actor.module_id))
    {
        return Err(error(
            PROJECT_DOCUMENTS_DENIED,
            "Project document activation does not belong to the requesting module",
        ));
    }
    Ok(())
}

fn validate_identity(value: &str, label: &str) -> Result<(), ProjectDocumentsError> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        Err(error(
            PROJECT_DOCUMENTS_INVALID_REQUEST,
            format!("Project document {label} is invalid"),
        ))
    } else {
        Ok(())
    }
}

fn relative_document_path(relative_path: &str) -> Result<&Path, ProjectDocumentsError> {
    let path = Path::new(relative_path);
    let valid = !relative_path.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)));
    if !valid {
        return Err(error(
            PROJECT_DOCUMENTS_INVALID_PATH,
            "Document path must be a normalized relative path",
        ));
    }
    Ok(path)
}

fn existing_document_path(
    root: &Path,
    relative_path: &str,
) -> Result<PathBuf, ProjectDocumentsError> {
    let relative = relative_document_path(relative_path)?;
    let candidate = root.join(relative);
    let metadata = fs::symlink_metadata(&candidate).map_err(|source| {
        let code = if source.kind() == std::io::ErrorKind::NotFound {
            PROJECT_DOCUMENTS_NOT_FOUND
        } else {
            PROJECT_DOCUMENTS_TRANSPORT_FAILED
        };
        error(code, format!("Failed to inspect {relative_path}: {source}"))
    })?;
    if metadata.file_type().is_symlink() {
        return Err(error(
            PROJECT_DOCUMENTS_DENIED,
            "Symbolic-link documents are outside the granted path scope",
        ));
    }
    let canonical = fs::canonicalize(&candidate).map_err(|source| {
        error(
            PROJECT_DOCUMENTS_TRANSPORT_FAILED,
            format!("Failed to resolve {relative_path}: {source}"),
        )
    })?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(error(
            PROJECT_DOCUMENTS_DENIED,
            "Document is outside the granted project path",
        ));
    }
    Ok(canonical)
}

fn revision(contents: &str) -> String {
    format!("{:x}", Sha256::digest(contents.as_bytes()))
}

fn read_document(
    project_id: &str,
    relative_path: &str,
    path: &Path,
) -> Result<ProjectDocument, ProjectDocumentsError> {
    let metadata = fs::metadata(path).map_err(|source| {
        error(
            PROJECT_DOCUMENTS_TRANSPORT_FAILED,
            format!("Failed to inspect {relative_path}: {source}"),
        )
    })?;
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(error(
            PROJECT_DOCUMENTS_TOO_LARGE,
            format!("Document exceeds {MAX_DOCUMENT_BYTES} bytes"),
        ));
    }
    let contents = fs::read_to_string(path).map_err(|source| {
        error(
            PROJECT_DOCUMENTS_INVALID_CONTENT,
            format!("Document is not valid UTF-8 text: {source}"),
        )
    })?;
    Ok(ProjectDocument {
        project_id: project_id.to_string(),
        relative_path: relative_path.to_string(),
        revision: revision(&contents),
        contents,
    })
}

fn validate_discovery_names(file_names: &[String]) -> Result<Vec<String>, ProjectDocumentsError> {
    if file_names.is_empty() {
        return Err(error(
            PROJECT_DOCUMENTS_INVALID_PATH,
            "At least one discovery file name is required",
        ));
    }
    file_names
        .iter()
        .map(|name| {
            let path = relative_document_path(name)?;
            if path.components().count() != 1 {
                return Err(error(
                    PROJECT_DOCUMENTS_INVALID_PATH,
                    "Discovery entries must be file names",
                ));
            }
            Ok(name.to_lowercase())
        })
        .collect()
}

fn scan_document_paths(
    directory: &Path,
    depth: usize,
    file_names: &[String],
    found: &mut Vec<PathBuf>,
) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Ok(metadata) = entry.file_type() else {
            continue;
        };
        if metadata.is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if depth + 1 > MAX_SCAN_DEPTH
                || name.starts_with('.')
                || UNSCANNED_DIRECTORIES.contains(&name)
            {
                continue;
            }
            scan_document_paths(&path, depth + 1, file_names, found);
        } else if metadata.is_file() && file_names.contains(&name.to_lowercase()) {
            let small = entry
                .metadata()
                .map(|metadata| metadata.len() <= MAX_DOCUMENT_BYTES)
                .unwrap_or(false);
            if small {
                found.push(path);
            }
        }
    }
}

fn error(code: &str, message: impl Into<String>) -> ProjectDocumentsError {
    ProjectDocumentsError {
        code: code.to_string(),
        message: message.into(),
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    struct TestCatalog {
        paths: Vec<String>,
    }

    impl ProjectCatalog for TestCatalog {
        fn registered_project_paths(&self) -> Result<Vec<String>, String> {
            Ok(self.paths.clone())
        }
    }

    fn actor(module_id: &str, suffix: &str) -> ProjectDocumentsActor {
        ProjectDocumentsActor {
            module_id: module_id.to_string(),
            activation_id: format!("{module_id}@1.0.0#{suffix}"),
        }
    }

    fn service(root: &Path) -> ProjectDocumentsService {
        ProjectDocumentsService::new(Arc::new(TestCatalog {
            paths: vec![root.to_string_lossy().to_string()],
        }))
    }

    fn observed_contents(path: &Path) -> Option<String> {
        fs::read_to_string(path).ok()
    }

    #[test]
    fn discovery_preserves_root_first_case_insensitive_projection() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("TODO.md"), "root\n").unwrap();
        fs::create_dir(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/todos.md"), "nested\n").unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::write(root.path().join("node_modules/TODO.md"), "ignored\n").unwrap();
        let project_id = root.path().to_string_lossy().to_string();

        let documents = service(root.path())
            .discover_documents(
                &actor("shipctl.todos", "discovery"),
                DiscoverProjectDocumentsInput {
                    project_id: project_id.clone(),
                    file_names: vec!["todo.md".to_string(), "todos.md".to_string()],
                },
            )
            .unwrap();

        assert_eq!(
            documents
                .iter()
                .map(|document| document.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["TODO.md", "docs/todos.md"]
        );
        assert!(documents.iter().all(|document| {
            document.project_id == project_id && document.revision == revision(&document.contents)
        }));
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_documents_and_directories_fail_closed() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("TODO.md"), "outside\n").unwrap();
        symlink(outside.path().join("TODO.md"), root.path().join("TODO.md")).unwrap();
        symlink(outside.path(), root.path().join("linked")).unwrap();
        let project_id = root.path().to_string_lossy().to_string();
        let provider = service(root.path());

        let denied = provider
            .read_document(
                &actor("shipctl.todos", "symlink"),
                ReadProjectDocumentInput {
                    project_id: project_id.clone(),
                    relative_path: "TODO.md".to_string(),
                },
            )
            .unwrap_err();
        assert_eq!(denied.code, PROJECT_DOCUMENTS_DENIED);
        let discovered = provider
            .discover_documents(
                &actor("shipctl.todos", "symlink"),
                DiscoverProjectDocumentsInput {
                    project_id,
                    file_names: vec!["TODO.md".to_string()],
                },
            )
            .unwrap();
        assert!(discovered.is_empty());
    }

    #[test]
    fn traversal_and_unregistered_projects_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.md"), "outside\n").unwrap();
        let project_id = root.path().to_string_lossy().to_string();
        let provider = service(root.path());

        let traversal = provider
            .read_document(
                &actor("shipctl.todos", "traversal"),
                ReadProjectDocumentInput {
                    project_id,
                    relative_path: "../outside.md".to_string(),
                },
            )
            .unwrap_err();
        assert_eq!(traversal.code, PROJECT_DOCUMENTS_INVALID_PATH);

        let unregistered = provider
            .read_document(
                &actor("shipctl.todos", "unregistered"),
                ReadProjectDocumentInput {
                    project_id: outside.path().to_string_lossy().to_string(),
                    relative_path: "outside.md".to_string(),
                },
            )
            .unwrap_err();
        assert_eq!(unregistered.code, PROJECT_DOCUMENTS_INVALID_PROJECT);
        assert_eq!(
            fs::read_to_string(outside.path().join("outside.md")).unwrap(),
            "outside\n",
        );
    }

    #[test]
    fn concurrent_compare_and_write_publishes_one_complete_document() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("TODO.md");
        fs::write(&target, "initial\n").unwrap();
        let project_id = root.path().to_string_lossy().to_string();
        let provider = service(root.path());
        let expected_revision = revision("initial\n");
        let barrier = Arc::new(std::sync::Barrier::new(2));

        let writers = ["alpha\n", "beta\n"].map(|contents| {
            let provider = provider.clone();
            let project_id = project_id.clone();
            let expected_revision = expected_revision.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                provider.write_document(
                    &actor("shipctl.todos", contents.trim()),
                    WriteProjectDocumentInput {
                        project_id,
                        relative_path: "TODO.md".to_string(),
                        expected_revision: Some(expected_revision),
                        contents: contents.to_string(),
                    },
                )
            })
        });
        let results = writers.map(|writer| writer.join().unwrap());

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .map(|error| error.code.as_str())
                .collect::<Vec<_>>(),
            vec![PROJECT_DOCUMENTS_CONFLICT],
        );
        let published = fs::read_to_string(target).unwrap();
        assert!(published == "alpha\n" || published == "beta\n");
    }

    proptest! {
        #[test]
        fn architecture_provider_project_documents_parity_property(
            initial in proptest::option::of(any::<String>()),
            operations in proptest::collection::vec((0u8..3, any::<String>()), 0..20),
        ) {
            let root = tempfile::tempdir().unwrap();
            let target = root.path().join("TODO.md");
            if let Some(contents) = &initial {
                fs::write(&target, contents).unwrap();
            }
            let project_id = root.path().to_string_lossy().to_string();
            let provider = service(root.path());
            let actor = actor("shipctl.todos", "parity");
            let mut legacy_model = initial;

            for (expectation, next_contents) in operations {
                let expected_revision = match expectation {
                    0 => None,
                    1 => legacy_model.as_ref().map(|contents| revision(contents)),
                    _ => Some("stale-revision".to_string()),
                };
                let legacy_allows = match (&expected_revision, &legacy_model) {
                    (None, None) => true,
                    (Some(expected), Some(contents)) => expected == &revision(contents),
                    _ => false,
                };
                let actual = provider.write_document(
                    &actor,
                    WriteProjectDocumentInput {
                        project_id: project_id.clone(),
                        relative_path: "TODO.md".to_string(),
                        expected_revision,
                        contents: next_contents.clone(),
                    },
                );

                if legacy_allows {
                    let document = actual.unwrap();
                    prop_assert_eq!(&document.contents, &next_contents);
                    prop_assert_eq!(document.revision, revision(&next_contents));
                    legacy_model = Some(next_contents);
                } else {
                    prop_assert_eq!(actual.unwrap_err().code, PROJECT_DOCUMENTS_CONFLICT);
                }
                prop_assert_eq!(observed_contents(&target), legacy_model.clone());
            }
        }

        #[test]
        fn architecture_provider_project_documents_authority_property(
            module_index in 0usize..3,
            write in any::<bool>(),
            matching_activation in any::<bool>(),
            disposed in any::<bool>(),
            registered_scope in any::<bool>(),
        ) {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            fs::write(root.path().join("TODO.md"), "registered\n").unwrap();
            fs::write(outside.path().join("TODO.md"), "outside\n").unwrap();
            let policies = vec![
                ProjectDocumentPolicy {
                    module_id: "shipctl.todos",
                    grants: READ_AND_WRITE,
                },
                ProjectDocumentPolicy {
                    module_id: "shipctl.reader",
                    grants: READ_ONLY,
                },
            ];
            let provider = ProjectDocumentsService::with_policies(
                Arc::new(TestCatalog {
                    paths: vec![root.path().to_string_lossy().to_string()],
                }),
                policies,
            );
            let modules = ["shipctl.todos", "shipctl.reader", "shipctl.unknown"];
            let module_id = modules[module_index];
            let mut candidate = actor(module_id, "authority");
            if !matching_activation {
                candidate.activation_id = "shipctl.other@1.0.0#authority".to_string();
            }
            let known = module_id != "shipctl.unknown";
            if disposed && known && matching_activation {
                provider.release_activation(&candidate).unwrap();
            }
            let project_id = if registered_scope {
                root.path().to_string_lossy().to_string()
            } else {
                outside.path().to_string_lossy().to_string()
            };
            let result = if write {
                provider.write_document(
                    &candidate,
                    WriteProjectDocumentInput {
                        project_id,
                        relative_path: "TODO.md".to_string(),
                        expected_revision: Some(revision("registered\n")),
                        contents: "updated\n".to_string(),
                    },
                ).map(|_| ())
            } else {
                provider.read_document(
                    &candidate,
                    ReadProjectDocumentInput {
                        project_id,
                        relative_path: "TODO.md".to_string(),
                    },
                ).map(|_| ())
            };

            let expected_code = if !matching_activation
                || !known
                || (write && module_id == "shipctl.reader")
            {
                Some(PROJECT_DOCUMENTS_DENIED)
            } else if disposed {
                Some(PROJECT_DOCUMENTS_ACTIVATION_DISPOSED)
            } else if !registered_scope {
                Some(PROJECT_DOCUMENTS_INVALID_PROJECT)
            } else {
                None
            };
            match expected_code {
                Some(code) => prop_assert_eq!(result.unwrap_err().code, code),
                None => prop_assert!(result.is_ok()),
            }
            prop_assert_eq!(
                fs::read_to_string(outside.path().join("TODO.md")).unwrap(),
                "outside\n",
            );
        }

        #[test]
        fn architecture_provider_project_documents_ownership_property(
            release_first in any::<bool>(),
            contents in any::<String>(),
        ) {
            let root = tempfile::tempdir().unwrap();
            let target = root.path().join("TODO.md");
            fs::write(&target, &contents).unwrap();
            let project_id = root.path().to_string_lossy().to_string();
            let provider = service(root.path());
            let first = actor("shipctl.todos", "first");
            let second = actor("shipctl.todos", "second");
            let (released, live) = if release_first {
                (&first, &second)
            } else {
                (&second, &first)
            };

            prop_assert!(provider.release_activation(released).unwrap());
            prop_assert_eq!(fs::read_to_string(&target).unwrap(), contents.clone());
            let disposed = provider.read_document(
                released,
                ReadProjectDocumentInput {
                    project_id: project_id.clone(),
                    relative_path: "TODO.md".to_string(),
                },
            ).unwrap_err();
            prop_assert_eq!(disposed.code, PROJECT_DOCUMENTS_ACTIVATION_DISPOSED);
            let document = provider.read_document(
                live,
                ReadProjectDocumentInput {
                    project_id,
                    relative_path: "TODO.md".to_string(),
                },
            ).unwrap();
            prop_assert_eq!(document.contents, contents);
        }
    }
}
