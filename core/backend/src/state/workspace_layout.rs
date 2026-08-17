//! Instance-owned, revisioned persistence for Layman workspace snapshots.
//!
//! This is deliberately separate from appearance-oriented `UiStateStore`.
//! Each stored snapshot has two explicit versions: the host document schema
//! and Layman's current snapshot schema. Neither is silently upgraded.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::DurableWriteBarrier;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

pub const WORKSPACE_LAYOUT_SCHEMA_VERSION: u32 = 1;
pub const LAYMAN_SNAPSHOT_SCHEMA_VERSION: f64 = 2.0;
/// JavaScript transports revisions as IEEE-754 numbers. This is its exact
/// integer boundary, not a product quota.
pub const MAX_SAFE_LAYOUT_REVISION: u64 = 9_007_199_254_740_991;
pub const WORKSPACE_LAYOUT_CHANGED_EVENT: &str = "shipctl://workspace-layout-changed";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceLayoutRecord {
    pub schema_version: u32,
    pub workspace_id: String,
    pub revision: u64,
    pub origin_id: String,
    pub snapshot: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WorkspaceLayoutSaveResult {
    Saved { record: WorkspaceLayoutRecord },
    Conflict { current: WorkspaceLayoutRecord },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceLayoutError {
    code: &'static str,
    message: String,
}

impl WorkspaceLayoutError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub const fn code(&self) -> &'static str {
        self.code
    }

    fn storage(message: impl Into<String>) -> Self {
        Self::new("CANVAS_LAYOUT_STORAGE_ERROR", message)
    }

    fn invalid_document(message: impl Into<String>) -> Self {
        Self::new("CANVAS_LAYOUT_STORAGE_INVALID", message)
    }

    fn unsupported_document_schema(version: u32) -> Self {
        Self::new(
            "CANVAS_LAYOUT_STORAGE_SCHEMA_UNSUPPORTED",
            format!(
                "Workspace layout storage schema {version} is unsupported; expected {WORKSPACE_LAYOUT_SCHEMA_VERSION}."
            ),
        )
    }

    fn invalid_snapshot(message: impl Into<String>) -> Self {
        Self::new("CANVAS_LAYOUT_SNAPSHOT_INVALID", message)
    }

    fn unsupported_snapshot_schema(version: Value) -> Self {
        Self::new(
            "CANVAS_LAYOUT_SNAPSHOT_SCHEMA_UNSUPPORTED",
            format!(
                "Layman snapshot schema {version} is unsupported; expected {}.",
                LAYMAN_SNAPSHOT_SCHEMA_VERSION as u32
            ),
        )
    }

    fn invalid_identity(label: &str) -> Self {
        Self::new(
            "CANVAS_LAYOUT_IDENTITY_INVALID",
            format!("{label} must be a non-empty string."),
        )
    }

    fn invalid_revision(message: impl Into<String>) -> Self {
        Self::new("CANVAS_LAYOUT_REVISION_INVALID", message)
    }

    fn missing_conflict_record() -> Self {
        Self::new(
            "CANVAS_LAYOUT_CONFLICT_CURRENT_MISSING",
            "Workspace layout revision conflict has no current record.",
        )
    }
}

impl fmt::Display for WorkspaceLayoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkspaceLayoutError {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceLayoutDocument {
    schema_version: u32,
    records: BTreeMap<String, WorkspaceLayoutRecord>,
}

impl Default for WorkspaceLayoutDocument {
    fn default() -> Self {
        Self {
            schema_version: WORKSPACE_LAYOUT_SCHEMA_VERSION,
            records: BTreeMap::new(),
        }
    }
}

/// The host authority for one instance's stored workspace layouts.
pub struct WorkspaceLayoutStore {
    path: PathBuf,
    lock: Mutex<()>,
    durable_writes: DurableWriteBarrier,
}

impl WorkspaceLayoutStore {
    pub fn new(path: PathBuf) -> Self {
        Self::new_with_barrier(path, DurableWriteBarrier::default())
    }

    pub fn new_with_barrier(path: PathBuf, durable_writes: DurableWriteBarrier) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
            durable_writes,
        }
    }

    pub fn load(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceLayoutRecord>, WorkspaceLayoutError> {
        validate_identity(workspace_id, "workspaceId")?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| WorkspaceLayoutError::storage("Workspace layout lock is poisoned."))?;
        let document = read_document(&self.path)?;
        Ok(document.records.get(workspace_id).cloned())
    }

    pub fn save(
        &self,
        workspace_id: String,
        expected_revision: u64,
        origin_id: String,
        snapshot: Value,
    ) -> Result<WorkspaceLayoutSaveResult, WorkspaceLayoutError> {
        validate_identity(&workspace_id, "workspaceId")?;
        validate_identity(&origin_id, "originId")?;
        validate_revision(expected_revision)?;
        validate_layman_snapshot(&snapshot)?;

        let _durable_update = self.durable_writes.enter_update().map_err(|message| {
            WorkspaceLayoutError::storage(format!(
                "Workspace layout write is unavailable: {message}"
            ))
        })?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| WorkspaceLayoutError::storage("Workspace layout lock is poisoned."))?;
        let mut document = read_document(&self.path)?;
        let current = document.records.get(&workspace_id).cloned();
        let current_revision = current.as_ref().map_or(0, |record| record.revision);

        if expected_revision != current_revision {
            let current = current.ok_or_else(WorkspaceLayoutError::missing_conflict_record)?;
            return Ok(WorkspaceLayoutSaveResult::Conflict { current });
        }
        let revision = current_revision.checked_add(1).ok_or_else(|| {
            WorkspaceLayoutError::invalid_revision(
                "Workspace layout revision cannot advance safely.",
            )
        })?;
        validate_revision(revision)?;

        let record = WorkspaceLayoutRecord {
            schema_version: WORKSPACE_LAYOUT_SCHEMA_VERSION,
            workspace_id: workspace_id.clone(),
            revision,
            origin_id,
            snapshot,
        };
        validate_record(&record)?;
        document.records.insert(workspace_id, record.clone());
        write_document(&self.path, &document)?;
        Ok(WorkspaceLayoutSaveResult::Saved { record })
    }

    pub fn validate_serialized_document(payload: &[u8]) -> Result<(), String> {
        decode_document(payload)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

fn read_document(path: &Path) -> Result<WorkspaceLayoutDocument, WorkspaceLayoutError> {
    if !path.exists() {
        return Ok(WorkspaceLayoutDocument::default());
    }
    let source = fs::read(path).map_err(|error| {
        WorkspaceLayoutError::storage(format!(
            "Could not read workspace layout storage {}: {error}",
            path.display()
        ))
    })?;
    decode_document(&source)
}

fn decode_document(payload: &[u8]) -> Result<WorkspaceLayoutDocument, WorkspaceLayoutError> {
    let document = serde_json::from_slice::<WorkspaceLayoutDocument>(payload).map_err(|error| {
        WorkspaceLayoutError::invalid_document(format!(
            "Workspace layout storage is invalid JSON: {error}"
        ))
    })?;
    validate_document(&document)?;
    Ok(document)
}

fn write_document(
    path: &Path,
    document: &WorkspaceLayoutDocument,
) -> Result<(), WorkspaceLayoutError> {
    let parent = path.parent().ok_or_else(|| {
        WorkspaceLayoutError::storage("Workspace layout storage path has no parent directory.")
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        WorkspaceLayoutError::storage(format!(
            "Could not create workspace layout directory: {error}"
        ))
    })?;
    let temporary = parent.join(format!(".workspace-layouts-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(document).map_err(|error| {
            WorkspaceLayoutError::storage(format!(
                "Could not serialize workspace layout storage: {error}"
            ))
        })?;
        fs::write(&temporary, bytes).map_err(|error| {
            WorkspaceLayoutError::storage(format!(
                "Could not stage workspace layout storage {}: {error}",
                temporary.display()
            ))
        })?;
        fs::rename(&temporary, path).map_err(|error| {
            WorkspaceLayoutError::storage(format!(
                "Could not publish workspace layout storage {}: {error}",
                path.display()
            ))
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_document(document: &WorkspaceLayoutDocument) -> Result<(), WorkspaceLayoutError> {
    if document.schema_version != WORKSPACE_LAYOUT_SCHEMA_VERSION {
        return Err(WorkspaceLayoutError::unsupported_document_schema(
            document.schema_version,
        ));
    }
    for (workspace_id, record) in &document.records {
        if workspace_id != &record.workspace_id {
            return Err(WorkspaceLayoutError::invalid_document(
                "A workspace layout storage key does not match its record workspaceId.",
            ));
        }
        validate_record(record)?;
    }
    Ok(())
}

fn validate_record(record: &WorkspaceLayoutRecord) -> Result<(), WorkspaceLayoutError> {
    if record.schema_version != WORKSPACE_LAYOUT_SCHEMA_VERSION {
        return Err(WorkspaceLayoutError::unsupported_document_schema(
            record.schema_version,
        ));
    }
    validate_identity(&record.workspace_id, "workspaceId")?;
    validate_identity(&record.origin_id, "originId")?;
    validate_persisted_revision(record.revision)?;
    validate_layman_snapshot(&record.snapshot)
}

fn validate_identity(value: &str, label: &str) -> Result<(), WorkspaceLayoutError> {
    if value.trim().is_empty() {
        return Err(WorkspaceLayoutError::invalid_identity(label));
    }
    Ok(())
}

fn validate_revision(revision: u64) -> Result<(), WorkspaceLayoutError> {
    if revision > MAX_SAFE_LAYOUT_REVISION {
        return Err(WorkspaceLayoutError::invalid_revision(format!(
            "Workspace layout revision exceeds the JavaScript safe integer boundary {MAX_SAFE_LAYOUT_REVISION}."
        )));
    }
    Ok(())
}

fn validate_persisted_revision(revision: u64) -> Result<(), WorkspaceLayoutError> {
    if revision == 0 {
        return Err(WorkspaceLayoutError::invalid_revision(
            "Persisted workspace layout revisions must be at least 1.",
        ));
    }
    validate_revision(revision)
}

fn validate_layman_snapshot(snapshot: &Value) -> Result<(), WorkspaceLayoutError> {
    let object = object(snapshot, "snapshot")?;
    exact_keys(
        object,
        &["schemaVersion", "layout", "floatingWindows"],
        "snapshot",
    )?;
    let schema = required(object, "schemaVersion", "snapshot")?;
    let schema_number = finite_number(schema, "snapshot schemaVersion")?;
    if schema_number != LAYMAN_SNAPSHOT_SCHEMA_VERSION {
        return Err(WorkspaceLayoutError::unsupported_snapshot_schema(
            schema.clone(),
        ));
    }
    let layout = required(object, "layout", "snapshot")?;
    let floating_windows = array(
        required(object, "floatingWindows", "snapshot")?,
        "snapshot floatingWindows",
    )?;

    let mut window_ids = BTreeSet::new();
    let mut tab_ids = BTreeSet::new();
    let mut split_ids = BTreeSet::new();
    validate_layout(layout, &mut window_ids, &mut tab_ids, &mut split_ids, true)?;
    for (index, floating) in floating_windows.iter().enumerate() {
        validate_floating_window(floating, index, &mut window_ids, &mut tab_ids, &split_ids)?;
    }
    Ok(())
}

fn validate_layout(
    value: &Value,
    window_ids: &mut BTreeSet<String>,
    tab_ids: &mut BTreeSet<String>,
    split_ids: &mut BTreeSet<String>,
    allow_empty: bool,
) -> Result<(), WorkspaceLayoutError> {
    if value.is_null() {
        return if allow_empty {
            Ok(())
        } else {
            Err(WorkspaceLayoutError::invalid_snapshot(
                "Split children must be layout trees.",
            ))
        };
    }
    let layout = object(value, "layout")?;
    let kind = required_string(layout, "kind", "layout")?;
    match kind {
        "window" => {
            exact_keys(
                layout,
                &["kind", "id", "tabs", "selectedTabId", "viewPercent"],
                "layout window",
            )?;
            validate_optional_view_percent(layout, "layout window")?;
            let id = required_id(layout, "id", "layout window")?;
            if window_ids.contains(&id) || split_ids.contains(&id) {
                return Err(WorkspaceLayoutError::invalid_snapshot(format!(
                    "Duplicate layout id '{id}'."
                )));
            }
            window_ids.insert(id);
            let tabs = array(
                required(layout, "tabs", "layout window")?,
                "layout window tabs",
            )?;
            let tab_ids_here = validate_tabs(tabs, tab_ids)?;
            validate_selection(
                &tab_ids_here,
                required(layout, "selectedTabId", "layout window")?,
                "layout window",
            )
        }
        "node" => {
            exact_keys(
                layout,
                &["kind", "id", "direction", "children", "viewPercent"],
                "layout node",
            )?;
            validate_optional_view_percent(layout, "layout node")?;
            let id = required_id(layout, "id", "layout node")?;
            let direction = required_string(layout, "direction", "layout node")?;
            if direction != "row" && direction != "column" {
                return Err(WorkspaceLayoutError::invalid_snapshot(
                    "Split node direction must be row or column.",
                ));
            }
            if split_ids.contains(&id) || window_ids.contains(&id) {
                return Err(WorkspaceLayoutError::invalid_snapshot(format!(
                    "Duplicate layout id '{id}'."
                )));
            }
            split_ids.insert(id);
            let children = array(
                required(layout, "children", "layout node")?,
                "layout node children",
            )?;
            if children.len() < 2 {
                return Err(WorkspaceLayoutError::invalid_snapshot(
                    "Split nodes need at least two children.",
                ));
            }
            for child in children {
                validate_layout(child, window_ids, tab_ids, split_ids, false)?;
            }
            Ok(())
        }
        _ => Err(WorkspaceLayoutError::invalid_snapshot(
            "Layout node kind must be window or node.",
        )),
    }
}

fn validate_floating_window(
    value: &Value,
    index: usize,
    window_ids: &mut BTreeSet<String>,
    tab_ids: &mut BTreeSet<String>,
    split_ids: &BTreeSet<String>,
) -> Result<(), WorkspaceLayoutError> {
    let label = format!("floating window {index}");
    let window = object(value, &label)?;
    exact_keys(
        window,
        &["id", "tabs", "selectedTabId", "position", "zIndex"],
        &label,
    )?;
    let id = required_id(window, "id", &label)?;
    if window_ids.contains(&id) || split_ids.contains(&id) {
        return Err(WorkspaceLayoutError::invalid_snapshot(format!(
            "Duplicate layout id '{id}'."
        )));
    }
    window_ids.insert(id);
    let tabs = array(required(window, "tabs", &label)?, &format!("{label} tabs"))?;
    let tab_ids_here = validate_tabs(tabs, tab_ids)?;
    validate_selection(
        &tab_ids_here,
        required(window, "selectedTabId", &label)?,
        &label,
    )?;
    validate_position(required(window, "position", &label)?, &label)?;
    let _ = finite_number(
        required(window, "zIndex", &label)?,
        &format!("{label} zIndex"),
    )?;
    Ok(())
}

fn validate_tabs(
    tabs: &[Value],
    tab_ids: &mut BTreeSet<String>,
) -> Result<BTreeSet<String>, WorkspaceLayoutError> {
    let mut tab_ids_here = BTreeSet::new();
    for tab in tabs {
        let tab = object(tab, "tab")?;
        exact_keys(tab, &["id", "title", "data"], "tab")?;
        let id = required_id(tab, "id", "tab")?;
        if !tab_ids.insert(id.clone()) {
            return Err(WorkspaceLayoutError::invalid_snapshot(format!(
                "Duplicate tab id '{id}'."
            )));
        }
        tab_ids_here.insert(id);
        if !required(tab, "title", "tab")?.is_string() {
            return Err(WorkspaceLayoutError::invalid_snapshot(
                "Tab title must be a string.",
            ));
        }
        let _ = required(tab, "data", "tab")?;
    }
    Ok(tab_ids_here)
}

fn validate_selection(
    tab_ids: &BTreeSet<String>,
    selected: &Value,
    label: &str,
) -> Result<(), WorkspaceLayoutError> {
    let selected_id = match selected {
        Value::Null => None,
        Value::String(value) if !value.trim().is_empty() => Some(value),
        _ => {
            return Err(WorkspaceLayoutError::invalid_snapshot(format!(
                "{label} selectedTabId must be a non-empty string or null."
            )))
        }
    };
    if tab_ids.is_empty() && selected_id.is_some() {
        return Err(WorkspaceLayoutError::invalid_snapshot(format!(
            "An empty {label} must not select a tab."
        )));
    }
    if !tab_ids.is_empty() && selected_id.is_none() {
        return Err(WorkspaceLayoutError::invalid_snapshot(format!(
            "A non-empty {label} must select a tab."
        )));
    }
    if let Some(id) = selected_id {
        if !tab_ids.contains(id) {
            return Err(WorkspaceLayoutError::invalid_snapshot(format!(
                "{label} selects unknown tab id '{id}'."
            )));
        }
    }
    Ok(())
}

fn validate_position(value: &Value, label: &str) -> Result<(), WorkspaceLayoutError> {
    let position = object(value, &format!("{label} position"))?;
    exact_keys(
        position,
        &["top", "left", "width", "height"],
        &format!("{label} position"),
    )?;
    let _ = finite_number(
        required(position, "top", label)?,
        &format!("{label} position.top"),
    )?;
    let _ = finite_number(
        required(position, "left", label)?,
        &format!("{label} position.left"),
    )?;
    let width = finite_number(
        required(position, "width", label)?,
        &format!("{label} position.width"),
    )?;
    let height = finite_number(
        required(position, "height", label)?,
        &format!("{label} position.height"),
    )?;
    if width <= 0.0 || height <= 0.0 {
        return Err(WorkspaceLayoutError::invalid_snapshot(format!(
            "{label} position width and height must be greater than zero."
        )));
    }
    Ok(())
}

fn validate_optional_view_percent(
    value: &Map<String, Value>,
    label: &str,
) -> Result<(), WorkspaceLayoutError> {
    if let Some(view_percent) = value.get("viewPercent") {
        if finite_number(view_percent, &format!("{label} viewPercent"))? <= 0.0 {
            return Err(WorkspaceLayoutError::invalid_snapshot(
                "viewPercent must be a positive finite number.",
            ));
        }
    }
    Ok(())
}

fn object<'a>(
    value: &'a Value,
    label: &str,
) -> Result<&'a Map<String, Value>, WorkspaceLayoutError> {
    value.as_object().ok_or_else(|| {
        WorkspaceLayoutError::invalid_snapshot(format!("{label} must be an object."))
    })
}

fn array<'a>(value: &'a Value, label: &str) -> Result<&'a [Value], WorkspaceLayoutError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| WorkspaceLayoutError::invalid_snapshot(format!("{label} must be an array.")))
}

fn required<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a Value, WorkspaceLayoutError> {
    object
        .get(key)
        .ok_or_else(|| WorkspaceLayoutError::invalid_snapshot(format!("{label} requires {key}.")))
}

fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a str, WorkspaceLayoutError> {
    required(object, key, label)?.as_str().ok_or_else(|| {
        WorkspaceLayoutError::invalid_snapshot(format!("{label} {key} must be a string."))
    })
}

fn required_id(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<String, WorkspaceLayoutError> {
    let id = required_string(object, key, label)?;
    if id.trim().is_empty() {
        return Err(WorkspaceLayoutError::invalid_snapshot(format!(
            "{label} {key} must be a non-empty string."
        )));
    }
    Ok(id.to_string())
}

fn finite_number(value: &Value, label: &str) -> Result<f64, WorkspaceLayoutError> {
    value
        .as_f64()
        .filter(|number| number.is_finite())
        .ok_or_else(|| {
            WorkspaceLayoutError::invalid_snapshot(format!("{label} must be a finite number."))
        })
}

fn exact_keys(
    object: &Map<String, Value>,
    allowed: &[&str],
    label: &str,
) -> Result<(), WorkspaceLayoutError> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(WorkspaceLayoutError::invalid_snapshot(format!(
                "{label} contains unknown property '{key}'."
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "shipctl-workspace-layout-{label}-{}",
            Uuid::new_v4()
        ))
    }

    fn snapshot() -> Value {
        json!({
            "schemaVersion": 2,
            "layout": {
                "kind": "window",
                "id": "shipctl.canvas.window",
                "tabs": [{
                    "id": "shipctl.canvas.tab",
                    "title": "Shipctl",
                    "data": {"kind": "shipctl.legacy-canvas"}
                }],
                "selectedTabId": "shipctl.canvas.tab"
            },
            "floatingWindows": []
        })
    }

    fn save(
        store: &WorkspaceLayoutStore,
        expected_revision: u64,
        origin_id: &str,
        snapshot: Value,
    ) -> WorkspaceLayoutSaveResult {
        store
            .save(
                "shipctl.canvas".into(),
                expected_revision,
                origin_id.into(),
                snapshot,
            )
            .unwrap()
    }

    #[test]
    fn missing_layout_loads_as_no_record() {
        let root = root("missing");
        let store = WorkspaceLayoutStore::new(root.join("workspace-layouts.json"));

        assert_eq!(store.load("shipctl.canvas").unwrap(), None);
        assert!(!root.exists());
    }

    #[test]
    fn valid_layout_round_trips_schema_origin_and_revision() {
        let root = root("round-trip");
        let path = root.join("workspace-layouts.json");
        let store = WorkspaceLayoutStore::new(path.clone());

        let saved = save(&store, 0, "webview-a", snapshot());
        let WorkspaceLayoutSaveResult::Saved { record } = saved else {
            panic!("first save must succeed");
        };
        assert_eq!(record.schema_version, WORKSPACE_LAYOUT_SCHEMA_VERSION);
        assert_eq!(record.workspace_id, "shipctl.canvas");
        assert_eq!(record.revision, 1);
        assert_eq!(record.origin_id, "webview-a");
        assert_eq!(store.load("shipctl.canvas").unwrap(), Some(record));
        assert!(path.exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_save_returns_current_record_without_replacing_it() {
        let root = root("conflict");
        let store = WorkspaceLayoutStore::new(root.join("workspace-layouts.json"));
        let _ = save(&store, 0, "webview-a", snapshot());
        let latest = save(&store, 1, "webview-b", snapshot());
        let WorkspaceLayoutSaveResult::Saved { record: latest } = latest else {
            panic!("second save must succeed");
        };

        let stale = save(&store, 1, "webview-a", snapshot());
        assert_eq!(
            stale,
            WorkspaceLayoutSaveResult::Conflict {
                current: latest.clone()
            }
        );
        assert_eq!(store.load("shipctl.canvas").unwrap(), Some(latest));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_current_record_fails_instead_of_serializing_a_null_conflict() {
        let root = root("missing-conflict-record");
        let store = WorkspaceLayoutStore::new(root.join("workspace-layouts.json"));

        let error = store
            .save("shipctl.canvas".into(), 1, "webview-a".into(), snapshot())
            .unwrap_err();
        assert_eq!(error.code(), "CANVAS_LAYOUT_CONFLICT_CURRENT_MISSING");
        assert_eq!(store.load("shipctl.canvas").unwrap(), None);
        assert!(!root.exists());
    }

    #[test]
    fn invalid_or_obsolete_snapshots_do_not_overwrite_a_valid_record() {
        let root = root("invalid-snapshot");
        let path = root.join("workspace-layouts.json");
        let store = WorkspaceLayoutStore::new(path.clone());
        let WorkspaceLayoutSaveResult::Saved { record: saved } =
            save(&store, 0, "webview-a", snapshot())
        else {
            panic!("first save must succeed");
        };
        let bytes = std::fs::read(&path).unwrap();
        let mut obsolete = snapshot();
        obsolete["schemaVersion"] = json!(1);

        let error = store
            .save("shipctl.canvas".into(), 1, "webview-b".into(), obsolete)
            .unwrap_err();
        assert_eq!(error.code(), "CANVAS_LAYOUT_SNAPSHOT_SCHEMA_UNSUPPORTED");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(store.load("shipctl.canvas").unwrap(), Some(saved));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn obsolete_storage_schema_is_rejected_instead_of_assumed_current() {
        let root = root("obsolete-storage");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("workspace-layouts.json");
        std::fs::write(&path, br#"{"schemaVersion":0,"records":{}}"#).unwrap();
        let store = WorkspaceLayoutStore::new(path);

        let error = store.load("shipctl.canvas").unwrap_err();
        assert_eq!(error.code(), "CANVAS_LAYOUT_STORAGE_SCHEMA_UNSUPPORTED");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persisted_revision_zero_is_rejected() {
        let root = root("revision-zero");
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("workspace-layouts.json");
        let document = json!({
            "schemaVersion": WORKSPACE_LAYOUT_SCHEMA_VERSION,
            "records": {
                "shipctl.canvas": {
                    "schemaVersion": WORKSPACE_LAYOUT_SCHEMA_VERSION,
                    "workspaceId": "shipctl.canvas",
                    "revision": 0,
                    "originId": "webview-a",
                    "snapshot": snapshot(),
                }
            }
        });
        std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        let store = WorkspaceLayoutStore::new(path);

        let error = store.load("shipctl.canvas").unwrap_err();
        assert_eq!(error.code(), "CANVAS_LAYOUT_REVISION_INVALID");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_instance_paths_do_not_share_layout_records() {
        let root = root("isolated");
        let first = WorkspaceLayoutStore::new(root.join("first/workspace-layouts.json"));
        let second = WorkspaceLayoutStore::new(root.join("second/workspace-layouts.json"));

        let _ = save(&first, 0, "webview-a", snapshot());
        assert!(first.load("shipctl.canvas").unwrap().is_some());
        assert_eq!(second.load("shipctl.canvas").unwrap(), None);

        std::fs::remove_dir_all(root).unwrap();
    }
}
