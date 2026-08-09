//! Stable machine-readable outcome and diagnostic codes for module control.

pub const SCHEMA_VERSION_UNSUPPORTED: &str = "module.contract.schema_version_unsupported";
pub const UNKNOWN_FIELD: &str = "module.contract.unknown_field";
pub const INVALID_JSON: &str = "module.contract.invalid_json";
pub const INVALID_IDENTITY: &str = "module.contract.identity.invalid";
pub const INVALID_DESIRED_STATE: &str = "module.contract.desired_state.invalid";
pub const INVALID_DIAGNOSTIC: &str = "module.contract.diagnostic.invalid";
pub const SECRET_LEAKAGE: &str = "module.contract.evidence.secret_leakage";
pub const INVALID_OFFLINE_RESPONSE: &str = "module.contract.offline_response.invalid";

pub const CONTROL_CAPABILITY_UNAVAILABLE: &str = "module.control.capability_unavailable";
pub const OPERATION_CAPABILITY_UNAVAILABLE: &str = "module.operation.capability_unavailable";
pub const MUTATION_UNAVAILABLE: &str = "module.control.mutation_unavailable";
pub const OPERATION_ABSENT: &str = "module.operation.absent";
pub const MODULE_ABSENT: &str = "module.registry.module.absent";
pub const DESIRED_STATE_ABSENT: &str = "module.registry.desired_state.absent";
pub const SNAPSHOT_UNAVAILABLE: &str = "module.runtime.snapshot.unavailable";
pub const SNAPSHOT_AVAILABLE: &str = "module.runtime.snapshot.available";
pub const MODULE_UNOBSERVED: &str = "module.runtime.module.unobserved";
pub const MODULE_ACTIVE: &str = "module.runtime.module.active";
pub const REVISION_LAG: &str = "module.runtime.revision.lag";
pub const REVISION_INVALID: &str = "module.runtime.revision.invalid";
pub const SNAPSHOT_INVALID: &str = "module.runtime.snapshot.invalid";
pub const BUILD_PROVENANCE: &str = "module.runtime.build.provenance";
pub const RUNTIME_OFFLINE: &str = "module.runtime.offline_unavailable";

pub const REGISTRY_ABSENT: &str = "module.registry.file.absent";
pub const REGISTRY_UNREADABLE: &str = "module.registry.file.unreadable";
pub const REGISTRY_SCHEMA_UNSUPPORTED: &str = "module.registry.schema.unsupported";
pub const REGISTRY_MIGRATION_FAILED: &str = "module.registry.migration.failed";
pub const REGISTRY_INTEGRITY_FAILED: &str = "module.registry.integrity.failed";
pub const REGISTRY_REVISION_DISCONTINUOUS: &str = "module.registry.revision.discontinuous";
pub const REGISTRY_ARTIFACT_REFERENCE_MISSING: &str = "module.registry.artifact.reference_missing";
pub const REGISTRY_ARTIFACT_IMMUTABLE: &str = "module.registry.artifact.immutable";
pub const REGISTRY_JOURNAL_INCONSISTENT: &str = "module.registry.journal.inconsistent";
pub const REGISTRY_CONTRACT_INVALID: &str = "module.registry.contract.invalid";
pub const REGISTRY_TRANSACTION_FAILED: &str = "module.registry.transaction.failed";
pub const REGISTRY_INVENTORY_ABSENT: &str = "module.registry.inventory.absent";
pub const REGISTRY_INVENTORY_STALE: &str = "module.registry.inventory.stale";
pub const REGISTRY_INVENTORY_MISMATCH: &str = "module.registry.inventory.composition_mismatch";
pub const REGISTRY_HEALTHY: &str = "module.registry.health.ok";
pub const REGISTRY_DIAGNOSTICS_FAILED: &str = "module.registry.diagnostics_failed";
pub const REGISTRY_STATE_ROOT_INVALID: &str = "module.registry.state_root.invalid";

pub const VERIFICATION_MISMATCH: &str = "module.verification.expectation_mismatch";
pub const VERIFICATION_MATCHED: &str = "module.verification.matched";
pub const VERIFICATION_EXPECTATION_MODULE_MISMATCH: &str =
    "module.verification.expectation_module_mismatch";
pub const VERIFICATION_EXPECTATION_UNREADABLE: &str = "module.verification.expectation_unreadable";

pub const REGISTRY_LISTED: &str = "module.registry.listed";
pub const REGISTRY_INSPECTED: &str = "module.registry.inspected";
pub const RUNTIME_INSPECTED: &str = "module.runtime.inspected";
pub const RUNTIME_DIAGNOSED: &str = "module.runtime.diagnosed";
pub const OPERATION_ACCEPTED: &str = "module.operation.accepted";
pub const OPERATION_INSPECTED: &str = "module.operation.inspected";

/// Offline runtime-artifact outcomes. These report admission metadata only;
/// none imply a loaded module, callable capability, or active route.
pub const ARTIFACT_PREFLIGHTED: &str = "module.artifact.preflighted";
pub const ARTIFACT_ADDED: &str = "module.artifact.added";
pub const ARTIFACT_DISABLED_INSPECTED: &str = "module.artifact.disabled_inspected";
pub const CAPABILITY_INSPECTED: &str = "module.capability.inspected";

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    #[test]
    fn public_codes_are_well_formed_and_unique() {
        let codes = [
            super::SCHEMA_VERSION_UNSUPPORTED,
            super::UNKNOWN_FIELD,
            super::INVALID_JSON,
            super::INVALID_IDENTITY,
            super::INVALID_DESIRED_STATE,
            super::INVALID_DIAGNOSTIC,
            super::SECRET_LEAKAGE,
            super::INVALID_OFFLINE_RESPONSE,
            super::CONTROL_CAPABILITY_UNAVAILABLE,
            super::OPERATION_CAPABILITY_UNAVAILABLE,
            super::MUTATION_UNAVAILABLE,
            super::OPERATION_ABSENT,
            super::MODULE_ABSENT,
            super::DESIRED_STATE_ABSENT,
            super::SNAPSHOT_UNAVAILABLE,
            super::SNAPSHOT_AVAILABLE,
            super::MODULE_UNOBSERVED,
            super::MODULE_ACTIVE,
            super::REVISION_LAG,
            super::REVISION_INVALID,
            super::SNAPSHOT_INVALID,
            super::BUILD_PROVENANCE,
            super::RUNTIME_OFFLINE,
            super::REGISTRY_ABSENT,
            super::REGISTRY_UNREADABLE,
            super::REGISTRY_SCHEMA_UNSUPPORTED,
            super::REGISTRY_MIGRATION_FAILED,
            super::REGISTRY_INTEGRITY_FAILED,
            super::REGISTRY_REVISION_DISCONTINUOUS,
            super::REGISTRY_ARTIFACT_REFERENCE_MISSING,
            super::REGISTRY_ARTIFACT_IMMUTABLE,
            super::REGISTRY_JOURNAL_INCONSISTENT,
            super::REGISTRY_CONTRACT_INVALID,
            super::REGISTRY_TRANSACTION_FAILED,
            super::REGISTRY_INVENTORY_ABSENT,
            super::REGISTRY_INVENTORY_STALE,
            super::REGISTRY_INVENTORY_MISMATCH,
            super::REGISTRY_HEALTHY,
            super::REGISTRY_DIAGNOSTICS_FAILED,
            super::REGISTRY_STATE_ROOT_INVALID,
            super::VERIFICATION_MISMATCH,
            super::VERIFICATION_MATCHED,
            super::VERIFICATION_EXPECTATION_MODULE_MISMATCH,
            super::VERIFICATION_EXPECTATION_UNREADABLE,
            super::REGISTRY_LISTED,
            super::REGISTRY_INSPECTED,
            super::RUNTIME_INSPECTED,
            super::RUNTIME_DIAGNOSED,
            super::OPERATION_ACCEPTED,
            super::OPERATION_INSPECTED,
            super::ARTIFACT_PREFLIGHTED,
            super::ARTIFACT_ADDED,
            super::ARTIFACT_DISABLED_INSPECTED,
            super::CAPABILITY_INSPECTED,
        ];
        let unique = codes.iter().copied().collect::<BTreeSet<_>>();
        assert_eq!(unique.len(), codes.len());
        assert!(codes.iter().all(|code| {
            code.starts_with("module.")
                && code.split('.').all(|segment| {
                    !segment.is_empty()
                        && segment
                            .chars()
                            .all(|character| character.is_ascii_lowercase() || character == '_')
                })
        }));
    }
}
