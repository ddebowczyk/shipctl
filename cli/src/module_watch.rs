//! Event-driven desired/applied module-state stream for agents.

use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::mpsc;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use shipctl_core::instance::{ControlError, InstanceRecord};
use shipctl_core::module_control::registry::{
    ModuleRegistry, ReconciliationFailureRecord, RegistrySnapshot, RuntimeAcceptanceRecord,
};
use shipctl_core::module_control::{DesiredModuleState, ModuleOperation};
use shipctl_core::state::paths::ShipctlPaths;

use crate::args::ModuleWatchArgs;
use crate::output::OutputFormat;

const OPERATION: &str = "modules.watch";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModuleWatchEvent {
    schema_version: u32,
    instance_id: uuid::Uuid,
    instance_name: String,
    registry_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    applied_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision_lag: Option<u64>,
    desired: Vec<DesiredModuleState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_applied: Option<RuntimeAcceptanceRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reconciliation_failure: Option<ReconciliationFailureRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<ModuleOperation>,
}

pub fn run(args: ModuleWatchArgs, format: OutputFormat, format_was_requested: bool) -> ExitCode {
    if format_was_requested && format != OutputFormat::Jsonl {
        return crate::emit_usage_message(
            format,
            OPERATION,
            "`modules watch` is a stream. Drop `--output` or pass `--output jsonl`.",
        );
    }
    let instance =
        match crate::instances::inspect(args.runtime_root.as_deref(), args.instance.as_deref()) {
            Ok(instance) => instance,
            Err(error) => {
                return crate::emit_failure(OutputFormat::Jsonl, OPERATION, &error, false)
            }
        };
    watch(instance, args.runtime_root.as_deref())
}

fn watch(instance: InstanceRecord, runtime_root: Option<&Path>) -> ExitCode {
    let paths = ShipctlPaths::new(instance.state_root.clone(), instance.runtime_root.clone());
    let (sender, receiver) = mpsc::channel();
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    }) {
        Ok(watcher) => watcher,
        Err(error) => return watch_error(format!("Could not create the module watcher: {error}")),
    };
    if let Err(error) = watcher.watch(&paths.module_registry_database, RecursiveMode::NonRecursive)
    {
        return watch_error(format!("Could not watch module state: {error}"));
    }

    let mut last = None;
    loop {
        match snapshot_event(&instance, &paths, runtime_root) {
            Ok(event) if last.as_ref() != Some(&event) => {
                if let Err(code) = print_line(&event) {
                    return code;
                }
                last = Some(event);
            }
            Ok(_) => {}
            Err(error) => {
                return crate::emit_failure(OutputFormat::Jsonl, OPERATION, &error, false)
            }
        }
        match receiver.recv() {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                return watch_error(format!("Module state observation failed: {error}"))
            }
            Err(error) => return watch_error(format!("The module watch channel closed: {error}")),
        }
    }
}

fn snapshot_event(
    selected: &InstanceRecord,
    paths: &ShipctlPaths,
    runtime_root: Option<&Path>,
) -> Result<ModuleWatchEvent, ControlError> {
    // A watch is an observation of module state, not a request for a complete
    // cross-provider state fingerprint. Discovery performs the authenticated
    // hello exchange and remains available while another provider is staging
    // an update.
    let live = crate::instances::list(runtime_root)?
        .instances
        .into_iter()
        .find(|instance| instance.instance_id == selected.instance_id)
        .ok_or_else(|| {
            ControlError::new(
                "module.control.instance_unavailable",
                "The selected Shipctl instance stopped while module state was observed",
            )
        })?;
    if live.instance_id != selected.instance_id {
        return Err(ControlError::new(
            "module.control.instance_changed",
            "The selected Shipctl instance changed while module state was observed",
        ));
    }
    let registry = ModuleRegistry::open_read_only(paths).map_err(registry_error)?;
    let mut snapshot = registry.snapshot().map_err(registry_error)?;
    snapshot
        .desired
        .sort_by(|left, right| left.module_id.cmp(&right.module_id));
    let operation = latest_operation(&snapshot).and_then(|operation| {
        crate::instances::inspect_operation(
            runtime_root,
            Some(&selected.instance_id.to_string()),
            operation.request_id,
        )
        .ok()
    });
    let last_applied = snapshot.runtime_acceptance;
    let applied_revision = last_applied
        .as_ref()
        .map(|acceptance| acceptance.registry_revision);
    let revision_lag =
        applied_revision.map(|revision| snapshot.registry_revision.saturating_sub(revision));
    Ok(ModuleWatchEvent {
        schema_version: 1,
        instance_id: live.instance_id,
        instance_name: live.name,
        registry_revision: snapshot.registry_revision,
        applied_revision,
        revision_lag,
        desired: snapshot.desired,
        last_applied,
        reconciliation_failure: snapshot.reconciliation_failures.into_iter().last(),
        operation,
    })
}

fn latest_operation(snapshot: &RegistrySnapshot) -> Option<&ModuleOperation> {
    snapshot.operations.iter().max_by(|left, right| {
        left.target_registry_revision
            .cmp(&right.target_registry_revision)
            .then_with(|| left.request_id.cmp(&right.request_id))
    })
}

fn registry_error(error: shipctl_core::module_control::registry::RegistryError) -> ControlError {
    ControlError::new(error.code, error.message)
}

fn watch_error(message: String) -> ExitCode {
    crate::emit_failure(
        OutputFormat::Jsonl,
        OPERATION,
        &ControlError::new("module.control.watch_failed", message),
        false,
    )
}

fn print_line(event: &ModuleWatchEvent) -> Result<(), ExitCode> {
    let line = serde_json::to_string(event).map_err(|error| {
        crate::emit_render_failure(OutputFormat::Jsonl, OPERATION, error.to_string())
    })?;
    let mut stdout = io::stdout().lock();
    match writeln!(stdout, "{line}").and_then(|()| stdout.flush()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Err(ExitCode::SUCCESS),
        Err(_) => Err(ExitCode::FAILURE),
    }
}
