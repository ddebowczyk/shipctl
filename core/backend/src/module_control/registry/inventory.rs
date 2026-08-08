use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::*;
use crate::module_control::{
    Diagnostic, DiagnosticSeverity, ModuleLifecycleState, ModuleRuntimeKind, ModuleSource,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticModuleRecord {
    pub identity: ModuleIdentity,
    pub source: ModuleSource,
    pub build_provenance: String,
    pub native_compiled: bool,
    pub frontend_shipped: bool,
    pub lifecycle: ModuleLifecycleState,
    pub live_loadable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StaticBuildInventory {
    pub build_provenance: String,
    pub modules: Vec<StaticModuleRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuildModuleMembership {
    pub module_id: String,
    pub native_compiled: bool,
    pub frontend_shipped: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InventorySeedResult {
    pub registry_revision: u64,
    pub changed: bool,
}

impl StaticBuildInventory {
    pub fn from_build_composition(
        build_identity: &str,
        module_version: &str,
        mut membership: Vec<BuildModuleMembership>,
    ) -> Result<Self, RegistryError> {
        membership.retain(|module| module.native_compiled || module.frontend_shipped);
        membership.sort_by(|left, right| left.module_id.cmp(&right.module_id));
        let composition = membership
            .iter()
            .map(|module| {
                format!(
                    "{}:{}:{}",
                    module.module_id, module.native_compiled, module.frontend_shipped
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let composition_digest = format!("{:x}", Sha256::digest(composition.as_bytes()));
        let build_provenance = format!("{build_identity}:composition-sha256:{composition_digest}");
        let modules = membership
            .into_iter()
            .map(|module| {
                let artifact_fingerprint = format!(
                    "static_builtin\n{build_provenance}\n{}\n{}\n{}",
                    module.module_id, module.native_compiled, module.frontend_shipped
                );
                StaticModuleRecord {
                    identity: ModuleIdentity {
                        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                        id: module.module_id,
                        version: module_version.to_string(),
                        content_digest: format!(
                            "{:x}",
                            Sha256::digest(artifact_fingerprint.as_bytes())
                        ),
                        runtime_kind: ModuleRuntimeKind::StaticBuiltin,
                    },
                    source: ModuleSource::Bundled,
                    build_provenance: build_provenance.clone(),
                    native_compiled: module.native_compiled,
                    frontend_shipped: module.frontend_shipped,
                    lifecycle: ModuleLifecycleState::RestartRequired,
                    live_loadable: false,
                }
            })
            .collect();
        normalize_inventory(&Self {
            build_provenance,
            modules,
        })
    }
}

impl ModuleRegistry {
    /// Replace only the current build-composition projection. Immutable
    /// artifacts, desired state, observations, and operation history remain.
    pub fn seed_static_inventory(
        &mut self,
        inventory: &StaticBuildInventory,
    ) -> Result<InventorySeedResult, RegistryError> {
        if self.access != Access::Writable {
            return Err(RegistryError::new(
                REGISTRY_TRANSACTION_FAILED,
                "Cannot seed inventory through a read-only registry",
            ));
        }
        let expected = normalize_inventory(inventory)?;
        let transaction = self.connection.transaction().map_err(transaction_error)?;
        let current_revision = read_revision(&transaction)?;
        let (stored_provenance, stored) = load_static_inventory(&transaction)?;
        if stored_provenance.as_deref() == Some(expected.build_provenance.as_str())
            && stored == expected.modules
        {
            return Ok(InventorySeedResult {
                registry_revision: current_revision,
                changed: false,
            });
        }

        for record in &expected.modules {
            insert_immutable_artifact(
                &transaction,
                &ArtifactAcquisition {
                    identity: record.identity.clone(),
                    source: record.source,
                },
            )?;
        }
        transaction
            .execute("DELETE FROM static_inventory", [])
            .map_err(transaction_error)?;
        for record in &expected.modules {
            transaction
                .execute(
                    "INSERT INTO static_inventory(module_id, identity_digest, build_provenance, native_compiled, frontend_shipped, record_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        record.identity.id,
                        record.identity.content_digest,
                        record.build_provenance,
                        record.native_compiled,
                        record.frontend_shipped,
                        serde_json::to_string(record).map_err(|error| RegistryError::new(
                            REGISTRY_CONTRACT_INVALID,
                            format!("Cannot serialize static inventory record: {error}"),
                        ))?,
                    ],
                )
                .map_err(transaction_error)?;
        }

        transaction
            .execute(
                "INSERT INTO registry_metadata(key, value) VALUES ('static_build_provenance', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![expected.build_provenance],
            )
            .map_err(transaction_error)?;
        let next_revision = current_revision.checked_add(1).ok_or_else(|| {
            RegistryError::new(
                REGISTRY_TRANSACTION_FAILED,
                "Registry revision cannot advance beyond u64::MAX",
            )
        })?;
        transaction
            .execute(
                "INSERT INTO registry_revisions(revision, change_kind, request_id) VALUES (?1, 'inventory', NULL)",
                params![sql_integer(next_revision, "registry revision")?],
            )
            .map_err(transaction_error)?;
        transaction
            .execute(
                "UPDATE registry_metadata SET value = ?1 WHERE key = 'current_revision'",
                params![next_revision.to_string()],
            )
            .map_err(transaction_error)?;
        transaction.commit().map_err(transaction_error)?;

        Ok(InventorySeedResult {
            registry_revision: next_revision,
            changed: true,
        })
    }

    pub fn static_inventory_diagnostics(&self, expected: &StaticBuildInventory) -> Vec<Diagnostic> {
        let expected = match normalize_inventory(expected) {
            Ok(expected) => expected,
            Err(error) => {
                return vec![inventory_diagnostic(error.code, error.message, self.path())]
            }
        };
        let snapshot = match self.snapshot() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                return vec![inventory_diagnostic(error.code, error.message, self.path())]
            }
        };
        match snapshot.static_build_provenance {
            None => vec![inventory_diagnostic(
                REGISTRY_INVENTORY_ABSENT,
                "Registry has no static build inventory".to_string(),
                self.path(),
            )],
            Some(provenance) if provenance != expected.build_provenance => {
                vec![inventory_diagnostic(
                    REGISTRY_INVENTORY_STALE,
                    format!(
                        "Recorded build provenance {provenance:?} differs from the running host"
                    ),
                    self.path(),
                )]
            }
            Some(_) if snapshot.static_inventory != expected.modules => vec![inventory_diagnostic(
                REGISTRY_INVENTORY_MISMATCH,
                "Recorded static module membership differs from the running host".to_string(),
                self.path(),
            )],
            Some(_) => Vec::new(),
        }
    }
}

pub(super) fn load_static_inventory(
    connection: &Connection,
) -> Result<(Option<String>, Vec<StaticModuleRecord>), RegistryError> {
    let provenance = connection
        .query_row(
            "SELECT value FROM registry_metadata WHERE key = 'static_build_provenance'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(transaction_error)?;
    let mut statement = connection
        .prepare(
            "SELECT module_id, identity_digest, build_provenance, native_compiled, frontend_shipped, record_json
             FROM static_inventory ORDER BY module_id",
        )
        .map_err(transaction_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(transaction_error)?;
    let records = rows
        .map(|row| {
            let (module_id, digest, provenance, native, frontend, json) =
                row.map_err(transaction_error)?;
            let record: StaticModuleRecord = serde_json::from_str(&json).map_err(|error| {
                RegistryError::new(
                    REGISTRY_CONTRACT_INVALID,
                    format!("Stored static inventory record is invalid: {error}"),
                )
            })?;
            if record.identity.id != module_id
                || record.identity.content_digest != digest
                || record.build_provenance != provenance
                || record.native_compiled != native
                || record.frontend_shipped != frontend
            {
                return Err(RegistryError::new(
                    REGISTRY_INVENTORY_MISMATCH,
                    format!("Static inventory row for {module_id} disagrees with its record"),
                ));
            }
            validate_contract(&record.identity)?;
            Ok(record)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((provenance, records))
}

fn normalize_inventory(
    inventory: &StaticBuildInventory,
) -> Result<StaticBuildInventory, RegistryError> {
    if inventory.build_provenance.trim().is_empty() {
        return Err(RegistryError::new(
            REGISTRY_CONTRACT_INVALID,
            "Static inventory requires build provenance",
        ));
    }
    let mut modules = inventory.modules.clone();
    modules.sort_by(|left, right| left.identity.id.cmp(&right.identity.id));
    for (index, record) in modules.iter().enumerate() {
        validate_contract(&record.identity)?;
        if record.source != ModuleSource::Bundled
            || record.identity.runtime_kind != ModuleRuntimeKind::StaticBuiltin
            || record.build_provenance != inventory.build_provenance
            || (!record.native_compiled && !record.frontend_shipped)
            || record.lifecycle != ModuleLifecycleState::RestartRequired
            || record.live_loadable
        {
            return Err(RegistryError::new(
                REGISTRY_CONTRACT_INVALID,
                format!(
                    "Static module {} must be bundled, present in the build, restart-bound, and not live-loadable",
                    record.identity.id
                ),
            ));
        }
        if index > 0 && modules[index - 1].identity.id == record.identity.id {
            return Err(RegistryError::new(
                REGISTRY_INVENTORY_MISMATCH,
                format!("Static inventory repeats module {}", record.identity.id),
            ));
        }
    }
    Ok(StaticBuildInventory {
        build_provenance: inventory.build_provenance.clone(),
        modules,
    })
}

fn inventory_diagnostic(code: &'static str, summary: String, path: &Path) -> Diagnostic {
    let mut diagnostic = super::diagnostics::registry_diagnostic(
        code,
        DiagnosticSeverity::Error,
        "static_build_inventory",
        summary,
        path,
        Some("Reseed from the running shipctl-ui build composition".to_string()),
    );
    diagnostic.evidence.fields.insert(
        "runtimePolicy".to_string(),
        "restart_required_not_live_loadable".to_string(),
    );
    diagnostic
}
