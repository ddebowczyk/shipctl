use shipctl_core::module_control::artifact::PLUGIN_API_VERSION;
use shipctl_core::module_control::registry::{ModuleRegistry, RegistryMutation};
use shipctl_core::module_control::repository::{ArtifactRepository, OfflineArtifactAddReport};
use shipctl_core::module_control::{
    DesiredModuleState, ModuleIdentity, ModuleOperationKind, ModuleRuntimeKind, ModuleSource,
    MODULE_CONTROL_SCHEMA_VERSION,
};
use shipctl_core::state::paths::ShipctlPaths;
use shipctl_module_api::DurableWriteBarrier;
use uuid::Uuid;

pub(super) struct BundledArtifact {
    module_id: &'static str,
    archive: &'static [u8],
}

#[cfg(shipctl_bundled_modules)]
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/generated/bundled_modules.rs"
));

#[cfg(not(shipctl_bundled_modules))]
const BUNDLED_ARTIFACTS: &[BundledArtifact] = &[];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BundledSelection {
    EnableInitial,
    ReplacePreservingState,
    PreserveUserSelection,
    PreserveRemoval,
    Unchanged,
}

fn selection_policy(
    current: Option<&DesiredModuleState>,
    target: &ModuleIdentity,
    target_selected_by_install: bool,
    selected_sources: &[ModuleSource],
) -> BundledSelection {
    let Some(current) = current else {
        return BundledSelection::EnableInitial;
    };
    let Some(selected) = current.selected_artifact.as_ref() else {
        return BundledSelection::PreserveRemoval;
    };
    if selected == target {
        return if target_selected_by_install
            && !current.enabled
            && current.configuration_revision == 1
        {
            BundledSelection::EnableInitial
        } else {
            BundledSelection::Unchanged
        };
    }
    if selected.runtime_kind == ModuleRuntimeKind::StaticBuiltin
        || (!selected_sources.is_empty()
            && selected_sources
                .iter()
                .all(|source| *source == ModuleSource::Bundled))
    {
        BundledSelection::ReplacePreservingState
    } else {
        BundledSelection::PreserveUserSelection
    }
}

fn select_bundled_artifact(
    paths: &ShipctlPaths,
    instance_id: Uuid,
    report: &OfflineArtifactAddReport,
) -> Result<(), String> {
    let mut registry = ModuleRegistry::open_writable(paths).map_err(|error| error.to_string())?;
    let snapshot = registry.snapshot().map_err(|error| error.to_string())?;
    let target = &report.artifact.identity;
    let current = snapshot
        .desired
        .iter()
        .find(|desired| desired.module_id == target.id);
    let selected_sources = current
        .and_then(|desired| desired.selected_artifact.as_ref())
        .and_then(|selected| {
            snapshot
                .runtime_artifacts
                .iter()
                .find(|entry| entry.identity() == *selected)
        })
        .map(|entry| entry.sources.as_slice())
        .unwrap_or_default();
    let selection = selection_policy(
        current,
        target,
        report.receipt.selected_by_install,
        selected_sources,
    );
    if matches!(
        selection,
        BundledSelection::Unchanged
            | BundledSelection::PreserveUserSelection
            | BundledSelection::PreserveRemoval
    ) {
        return Ok(());
    }

    let enabled = match selection {
        BundledSelection::EnableInitial => true,
        BundledSelection::ReplacePreservingState => current.is_some_and(|state| state.enabled),
        BundledSelection::PreserveUserSelection
        | BundledSelection::PreserveRemoval
        | BundledSelection::Unchanged => unreachable!(),
    };
    let configuration_revision = match current {
        Some(state) => state
            .configuration_revision
            .checked_add(1)
            .ok_or_else(|| "Bundled module configuration revision is exhausted".to_string())?,
        None => 1,
    };
    let request_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!(
            "shipctl:bundled-selection:{}:{}:{configuration_revision}:{enabled}",
            target.id, target.content_digest,
        )
        .as_bytes(),
    );
    registry
        .commit(&RegistryMutation {
            request_id,
            module_id: target.id.clone(),
            instance_id,
            kind: if matches!(selection, BundledSelection::EnableInitial) {
                ModuleOperationKind::Enable
            } else {
                ModuleOperationKind::Update
            },
            artifacts: Vec::new(),
            desired: Some(DesiredModuleState {
                schema_version: MODULE_CONTROL_SCHEMA_VERSION,
                module_id: target.id.clone(),
                selected_artifact: Some(target.clone()),
                enabled,
                configuration_revision,
            }),
            observations: Vec::new(),
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub fn seed_bundled_artifacts(
    paths: &ShipctlPaths,
    instance_id: Uuid,
    durable_writes: DurableWriteBarrier,
) -> Result<(), String> {
    let repository =
        ArtifactRepository::for_host(paths.clone(), durable_writes.clone(), PLUGIN_API_VERSION);
    for artifact in BUNDLED_ARTIFACTS {
        let report = repository
            .ensure_bundled_archive(artifact.archive)
            .map_err(|error| error.to_string())?;
        if report.artifact.identity.id != artifact.module_id {
            return Err(format!(
                "Bundled artifact {} declared unexpected module {}",
                artifact.module_id, report.artifact.identity.id,
            ));
        }
        let _update = durable_writes
            .enter_update()
            .map_err(|error| error.to_string())?;
        select_bundled_artifact(paths, instance_id, &report)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(shipctl_bundled_modules)]
    use shipctl_core::module_control::live::ModuleControlService;

    fn identity(kind: ModuleRuntimeKind, marker: char) -> ModuleIdentity {
        ModuleIdentity {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            id: "shipctl.commands".to_string(),
            version: "0.0.0".to_string(),
            content_digest: marker.to_string().repeat(64),
            runtime_kind: kind,
        }
    }

    fn desired(artifact: ModuleIdentity, enabled: bool, revision: u64) -> DesiredModuleState {
        DesiredModuleState {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            module_id: artifact.id.clone(),
            selected_artifact: Some(artifact),
            enabled,
            configuration_revision: revision,
        }
    }

    #[test]
    fn bundled_selection_enables_only_its_fresh_install() {
        let target = identity(ModuleRuntimeKind::FrontendEsm, 'a');
        let fresh = desired(target.clone(), false, 1);
        assert_eq!(
            selection_policy(Some(&fresh), &target, true, &[ModuleSource::Bundled]),
            BundledSelection::EnableInitial,
        );
        let disabled = desired(target.clone(), false, 2);
        assert_eq!(
            selection_policy(Some(&disabled), &target, true, &[ModuleSource::Bundled]),
            BundledSelection::Unchanged,
        );
    }

    #[test]
    fn bundled_selection_updates_only_static_or_exclusively_bundled_choices() {
        let target = identity(ModuleRuntimeKind::FrontendEsm, 'a');
        let static_choice = desired(identity(ModuleRuntimeKind::StaticBuiltin, 'b'), false, 4);
        assert_eq!(
            selection_policy(
                Some(&static_choice),
                &target,
                false,
                &[ModuleSource::Bundled]
            ),
            BundledSelection::ReplacePreservingState,
        );
        let bundled_choice = desired(identity(ModuleRuntimeKind::FrontendEsm, 'c'), true, 3);
        assert_eq!(
            selection_policy(
                Some(&bundled_choice),
                &target,
                false,
                &[ModuleSource::Bundled]
            ),
            BundledSelection::ReplacePreservingState,
        );
        assert_eq!(
            selection_policy(Some(&bundled_choice), &target, false, &[ModuleSource::User]),
            BundledSelection::PreserveUserSelection,
        );
    }

    #[test]
    fn bundled_selection_preserves_an_explicit_removal_tombstone() {
        let target = identity(ModuleRuntimeKind::FrontendEsm, 'a');
        let removed = DesiredModuleState {
            schema_version: MODULE_CONTROL_SCHEMA_VERSION,
            module_id: target.id.clone(),
            selected_artifact: None,
            enabled: false,
            configuration_revision: 2,
        };
        assert_eq!(
            selection_policy(Some(&removed), &target, true, &[ModuleSource::Bundled]),
            BundledSelection::PreserveRemoval,
        );
    }

    #[cfg(shipctl_bundled_modules)]
    #[test]
    fn generated_bundled_archives_seed_enabled_startup_descriptors() {
        let root = std::env::temp_dir().join(format!(
            "shipctl-bundled-artifact-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test"),
        ));
        let _ = std::fs::remove_dir_all(&root);
        let paths = ShipctlPaths::new(root.join("state"), root.join("runtime"));
        let instance_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, root.to_string_lossy().as_bytes());

        seed_bundled_artifacts(&paths, instance_id, DurableWriteBarrier::default()).unwrap();

        let registry = ModuleRegistry::open_read_only(&paths).unwrap();
        let snapshot = registry.snapshot().unwrap();
        for module_id in [
            "shipctl.assistants",
            "shipctl.commands",
            "shipctl.git",
            "shipctl.ports",
            "shipctl.semantic-terminal",
            "shipctl.skills",
            "shipctl.thin-terminal",
            "shipctl.todos",
            "shipctl.usage",
        ] {
            let desired = snapshot.effective_desired(module_id).unwrap();
            assert!(desired.enabled);
            assert_eq!(
                desired.selected_artifact.as_ref().unwrap().runtime_kind,
                ModuleRuntimeKind::FrontendEsm,
            );
            let registered = snapshot
                .runtime_artifacts
                .iter()
                .find(|artifact| artifact.identity().id == module_id)
                .unwrap();
            assert_eq!(registered.sources, vec![ModuleSource::Bundled]);
        }
        drop(registry);

        let service = ModuleControlService::initialize(paths.clone(), instance_id).unwrap();
        let catalog = service.runtime_modules().unwrap();
        let assistants = catalog
            .modules
            .iter()
            .find(|module| module.module_id == "shipctl.assistants")
            .unwrap();
        assert_eq!(
            assistants.manifest.application.role,
            shipctl_core::module_control::artifact::RuntimePluginRole::Compound,
        );
        assert!(assistants.style_paths.is_empty());
        assert!(assistants.entry_path.is_file());
        assert_eq!(
            assistants
                .manifest
                .application
                .required_services
                .iter()
                .map(|service| (service.id.as_str(), service.version))
                .collect::<Vec<_>>(),
            vec![
                ("shipctl.assistant-launch", 1),
                ("shipctl.credential-store", 1),
                ("shipctl.processes", 1),
                ("shipctl.terminal-sessions", 1),
            ],
        );
        assert_eq!(
            assistants.manifest.requested_grants,
            vec![
                "assistant.launch".to_string(),
                "assistant.session-record".to_string(),
                "credential.inspect".to_string(),
                "credential.write".to_string(),
                "terminal.start".to_string(),
                "terminal.attach".to_string(),
            ],
        );
        let commands = catalog
            .modules
            .iter()
            .find(|module| module.module_id == "shipctl.commands")
            .unwrap();
        assert_eq!(
            commands.manifest.application.role,
            shipctl_core::module_control::artifact::RuntimePluginRole::Compound,
        );
        assert!(!commands.style_paths.is_empty());
        assert!(commands.entry_path.is_file());
        assert!(commands.style_paths.iter().all(|style| style.is_file()));
        let git = catalog
            .modules
            .iter()
            .find(|module| module.module_id == "shipctl.git")
            .unwrap();
        assert_eq!(
            git.manifest.application.role,
            shipctl_core::module_control::artifact::RuntimePluginRole::Compound,
        );
        assert!(!git.style_paths.is_empty());
        assert!(git.entry_path.is_file());
        assert!(git.style_paths.iter().all(|style| style.is_file()));
        assert!(git
            .manifest
            .application
            .required_services
            .iter()
            .any(|service| service.id == "shipctl.git" && service.version == 1));
        let semantic_terminal = catalog
            .modules
            .iter()
            .find(|module| module.module_id == "shipctl.semantic-terminal")
            .unwrap();
        assert_eq!(
            semantic_terminal.manifest.application.role,
            shipctl_core::module_control::artifact::RuntimePluginRole::Presentation,
        );
        assert_eq!(semantic_terminal.style_paths.len(), 1);
        assert!(semantic_terminal.entry_path.is_file());
        assert!(semantic_terminal.style_paths[0].is_file());
        assert_eq!(
            semantic_terminal
                .manifest
                .application
                .required_services
                .iter()
                .map(|service| (service.id.as_str(), service.version))
                .collect::<Vec<_>>(),
            vec![
                ("shipctl.semantic-terminals", 1),
                ("shipctl.terminal-sessions", 1),
            ],
        );
        assert_eq!(
            semantic_terminal.manifest.requested_grants,
            vec![
                "terminal.attach".to_string(),
                "terminal.input".to_string(),
                "terminal.resize".to_string(),
                "semantic-terminal.attach".to_string(),
                "semantic-terminal.input".to_string(),
                "semantic-terminal.inspect".to_string(),
            ],
        );
        let ports = catalog
            .modules
            .iter()
            .find(|module| module.module_id == "shipctl.ports")
            .unwrap();
        assert_eq!(
            ports.manifest.application.role,
            shipctl_core::module_control::artifact::RuntimePluginRole::Presentation,
        );
        assert!(ports.style_paths.is_empty());
        assert!(ports.entry_path.is_file());
        assert!(ports
            .manifest
            .application
            .required_services
            .iter()
            .any(|service| service.id == "shipctl.processes" && service.version == 1));
        let skills = catalog
            .modules
            .iter()
            .find(|module| module.module_id == "shipctl.skills")
            .unwrap();
        assert_eq!(
            skills.manifest.application.role,
            shipctl_core::module_control::artifact::RuntimePluginRole::Compound,
        );
        assert!(skills.style_paths.is_empty());
        assert!(skills.entry_path.is_file());
        assert!(skills
            .manifest
            .application
            .required_services
            .iter()
            .any(|service| { service.id == "shipctl.skill-installation" && service.version == 2 }));
        let thin_terminal = catalog
            .modules
            .iter()
            .find(|module| module.module_id == "shipctl.thin-terminal")
            .unwrap();
        assert_eq!(
            thin_terminal.manifest.application.role,
            shipctl_core::module_control::artifact::RuntimePluginRole::Presentation,
        );
        assert_eq!(thin_terminal.style_paths.len(), 1);
        assert!(thin_terminal.entry_path.is_file());
        assert!(thin_terminal.style_paths[0].is_file());
        assert!(thin_terminal
            .manifest
            .application
            .required_services
            .iter()
            .any(|service| { service.id == "shipctl.terminal-sessions" && service.version == 1 }));
        assert_eq!(
            thin_terminal.manifest.requested_grants,
            vec![
                "terminal.attach".to_string(),
                "terminal.input".to_string(),
                "terminal.resize".to_string(),
            ],
        );
        let todos = catalog
            .modules
            .iter()
            .find(|module| module.module_id == "shipctl.todos")
            .unwrap();
        assert_eq!(
            todos.manifest.application.role,
            shipctl_core::module_control::artifact::RuntimePluginRole::Compound,
        );
        assert!(!todos.style_paths.is_empty());
        assert!(todos.entry_path.is_file());
        assert!(todos.style_paths.iter().all(|style| style.is_file()));
        assert!(todos
            .manifest
            .application
            .required_services
            .iter()
            .any(|service| service.id == "shipctl.project-documents" && service.version == 1));
        let usage = catalog
            .modules
            .iter()
            .find(|module| module.module_id == "shipctl.usage")
            .unwrap();
        assert_eq!(
            usage.manifest.application.role,
            shipctl_core::module_control::artifact::RuntimePluginRole::Compound,
        );
        assert_eq!(usage.style_paths.len(), 1);
        assert!(usage.entry_path.is_file());
        assert!(usage.style_paths[0].is_file());
        assert_eq!(
            usage
                .manifest
                .application
                .required_services
                .iter()
                .map(|service| (service.id.as_str(), service.version))
                .collect::<Vec<_>>(),
            vec![
                ("shipctl.usage-sources", 2),
                ("shipctl.plugin-data", 1),
                ("shipctl.messages", 1),
                ("shipctl.scheduler", 1),
            ],
        );
        assert_eq!(
            usage.manifest.requested_grants,
            vec![
                "usage-source.read".to_string(),
                "usage-source.refresh".to_string(),
                "usage-source.observe".to_string(),
                "plugin-data.read".to_string(),
                "plugin-data.write".to_string(),
                "message.send.usage.refresh-request".to_string(),
                "message.publish.usage.ingest-completed".to_string(),
                "message.subscribe.usage.ingest-completed".to_string(),
                "schedule.register".to_string(),
            ],
        );
        drop(service);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(shipctl_bundled_modules)]
    #[test]
    fn generated_bundled_archive_does_not_reselect_a_removed_module() {
        let root = std::env::temp_dir().join(format!(
            "shipctl-bundled-artifact-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test"),
        ));
        let _ = std::fs::remove_dir_all(&root);
        let paths = ShipctlPaths::new(root.join("state"), root.join("runtime"));
        let instance_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, root.to_string_lossy().as_bytes());
        let writes = DurableWriteBarrier::default();

        seed_bundled_artifacts(&paths, instance_id, writes.clone()).unwrap();
        let service = ModuleControlService::initialize(paths.clone(), instance_id).unwrap();
        let removed_revision = service.status().registry_revision.unwrap() + 1;
        service
            .transition_module(
                "shipctl.commands",
                ModuleOperationKind::Remove,
                removed_revision,
                None,
            )
            .unwrap();

        seed_bundled_artifacts(&paths, Uuid::new_v4(), writes).unwrap();

        let snapshot = ModuleRegistry::open_read_only(&paths)
            .unwrap()
            .snapshot()
            .unwrap();
        let removed = snapshot
            .desired
            .iter()
            .find(|state| state.module_id == "shipctl.commands")
            .unwrap();
        assert!(!removed.enabled);
        assert!(removed.selected_artifact.is_none());
        assert_eq!(snapshot.registry_revision, removed_revision);
        drop(snapshot);

        let restarted = ModuleControlService::initialize(paths.clone(), Uuid::new_v4()).unwrap();
        let runtime_module_ids = restarted
            .runtime_modules()
            .unwrap()
            .modules
            .into_iter()
            .map(|module| module.module_id)
            .collect::<Vec<_>>();
        assert_eq!(
            runtime_module_ids,
            vec![
                "shipctl.assistants",
                "shipctl.git",
                "shipctl.ports",
                "shipctl.semantic-terminal",
                "shipctl.skills",
                "shipctl.thin-terminal",
                "shipctl.todos",
                "shipctl.usage"
            ]
        );

        std::fs::remove_dir_all(root).unwrap();
    }
}
