//! Application lifecycle. `shutdown_and_quit` spans the terminal capability,
//! the projects watcher and the Tauri app handle at once, so it belongs to the
//! shell that composes them rather than to any one capability.

use shipctl_core::instance::control::terminal_control_error;
use shipctl_core::instance::{
    ActiveWorkBlocker, CapabilityCommand, ControlError, ControlHandler, ControlRequestId,
    ControlResponseResult, ControlStream, MessageCommand, ModuleCommand, ModuleControlStatus,
    OperationCommand, ScheduleCommand, TerminalInspectResult,
};
use shipctl_core::message_bus::{
    diagnose_message_runtime, MessageBusBridgeService, MessageModuleInspection,
    MessageRuntimeInspection,
};
use shipctl_core::module_control::agent::AgentCapabilityService;
use shipctl_core::module_control::codes::MUTATION_UNAVAILABLE;
use shipctl_core::module_control::live::ModuleControlService;
use shipctl_core::projects::watcher::GitWatcher;
use shipctl_core::scheduler::{SchedulerControlError, SchedulerService};
use shipctl_core::state::archive::{StateArchiveInspection, StateArchiveService};
use shipctl_core::terminal::{
    TerminalAgentActivity, TerminalAgentReportRequest, TerminalAttachment, TerminalAttachmentId,
    TerminalCloseResult, TerminalDescriptor, TerminalEventSink, TerminalId, TerminalService,
};
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;

pub struct TauriControlHandler {
    app: tauri::AppHandle,
}

impl TauriControlHandler {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    fn module_service(&self) -> ModuleControlService {
        self.app.state::<ModuleControlService>().inner().clone()
    }

    fn message_inspection(&self) -> MessageRuntimeInspection {
        let bridges = self.app.state::<MessageBusBridgeService>().inner().clone();
        let module_service = self.module_service();
        tauri::async_runtime::block_on(async move {
            let runtime = bridges.inspect().await;
            let modules = runtime
                .registrations
                .iter()
                .cloned()
                .map(|registration| MessageModuleInspection {
                    module: module_service.inspect(&registration.module_id).ok(),
                    registration,
                })
                .collect();
            MessageRuntimeInspection::new(runtime, modules)
        })
    }
}

impl ControlHandler for TauriControlHandler {
    fn active_work(&self) -> Vec<ActiveWorkBlocker> {
        let count = self.app.state::<TerminalService>().active_count();
        if count == 0 {
            Vec::new()
        } else {
            vec![ActiveWorkBlocker {
                kind: "pty_sessions".to_string(),
                count,
                message: "Running terminal sessions require an explicit forced stop".to_string(),
            }]
        }
    }

    fn state_fingerprint(&self) -> Result<Option<String>, ControlError> {
        self.app
            .state::<StateArchiveService>()
            .fingerprint_current()
            .map(Some)
    }

    fn workspace_identities(&self) -> Vec<String> {
        let mut workspaces = self
            .app
            .state::<shipctl_core::workspace::manager::WorkspaceManager>()
            .list_repos()
            .unwrap_or_default()
            .into_iter()
            .map(|repo| repo.path)
            .collect::<Vec<_>>();
        workspaces.sort();
        workspaces
    }

    fn module_control_status(&self) -> ModuleControlStatus {
        self.module_service().status()
    }

    fn instance_diagnostics(&self) -> Vec<shipctl_core::module_control::Diagnostic> {
        self.module_service().diagnose_instance()
    }

    fn module_control(&self, command: ModuleCommand) -> Result<ControlStream, ControlError> {
        let service = self.module_service();
        match command {
            ModuleCommand::Inspect { module_id } => Ok(ControlStream::result(
                ControlResponseResult::ModuleInspection(service.inspect(&module_id)?),
            )),
            ModuleCommand::Diagnose { module_id } => Ok(ControlStream::result(
                ControlResponseResult::ModuleDiagnostics(service.diagnose_module(&module_id)?),
            )),
            ModuleCommand::Lifecycle { .. } => Err(ControlError::new(
                MUTATION_UNAVAILABLE,
                "Runtime module mutation is disabled until the reconciler is installed",
            )),
        }
    }

    fn message_control(&self, command: MessageCommand) -> Result<ControlStream, ControlError> {
        let inspection = self.message_inspection();
        Ok(ControlStream::result(match command {
            MessageCommand::Inspect {} => ControlResponseResult::MessageInspection(inspection),
            MessageCommand::Diagnose {} => {
                ControlResponseResult::MessageDiagnostics(diagnose_message_runtime(inspection))
            }
        }))
    }

    fn capability_control(
        &self,
        command: CapabilityCommand,
    ) -> Result<ControlStream, ControlError> {
        let service = self.app.state::<AgentCapabilityService>().inner().clone();
        match command {
            CapabilityCommand::List {} => Ok(ControlStream::result(
                ControlResponseResult::CapabilityCatalog(service.list()?),
            )),
            CapabilityCommand::Inspect { capability_id } => Ok(ControlStream::result(
                ControlResponseResult::CapabilityInspection(service.inspect(&capability_id)?),
            )),
            CapabilityCommand::Call {
                capability_id,
                port_id,
                payload,
            } => tauri::async_runtime::block_on(async move {
                service
                    .call(&capability_id, &port_id, payload)
                    .await
                    .map(ControlResponseResult::CapabilityInvocation)
                    .map(ControlStream::result)
            }),
        }
    }

    fn schedule_control(
        &self,
        command: ScheduleCommand,
        request_id: ControlRequestId,
    ) -> Result<ControlStream, ControlError> {
        let scheduler = self.app.state::<SchedulerService>().inner().clone();
        match command {
            ScheduleCommand::List {} => Ok(ControlStream::result(
                ControlResponseResult::ScheduleInspection(scheduler.inspect()),
            )),
            ScheduleCommand::Inspect { schedule_id } => scheduler
                .inspect_schedule(&schedule_id)
                .map(ControlResponseResult::ScheduleInspection)
                .map(ControlStream::result)
                .map_err(scheduler_control_error),
            ScheduleCommand::Diagnose {} => Ok(ControlStream::result(
                ControlResponseResult::ScheduleDiagnostics(scheduler.diagnose()),
            )),
            ScheduleCommand::Verify {} => Ok(ControlStream::result(
                ControlResponseResult::ScheduleVerification(scheduler.verify()),
            )),
            ScheduleCommand::Refresh {} => tauri::async_runtime::block_on(async move {
                scheduler
                    .refresh_with_request_id(request_id)
                    .await
                    .map(ControlResponseResult::ScheduleRefresh)
                    .map(ControlStream::result)
                    .map_err(scheduler_control_error)
            }),
            ScheduleCommand::Trigger { schedule_id } => {
                tauri::async_runtime::block_on(async move {
                    scheduler
                        .trigger_with_request_id(&schedule_id, request_id)
                        .await
                        .map(ControlResponseResult::ScheduleTrigger)
                        .map(ControlStream::result)
                        .map_err(scheduler_control_error)
                })
            }
        }
    }

    fn operation_control(&self, command: OperationCommand) -> Result<ControlStream, ControlError> {
        let service = self.module_service();
        let OperationCommand::Inspect { operation_id } = command;
        Ok(ControlStream::result(
            ControlResponseResult::ModuleOperation(service.inspect_operation(operation_id)?),
        ))
    }

    fn terminal_list(&self) -> Result<Vec<TerminalDescriptor>, ControlError> {
        Ok(self.app.state::<TerminalService>().list())
    }

    fn terminal_get(&self, id: TerminalId) -> Result<TerminalDescriptor, ControlError> {
        self.app
            .state::<TerminalService>()
            .get(id)
            .map_err(terminal_control_error)
    }

    fn terminal_inspect(&self, id: TerminalId) -> Result<TerminalInspectResult, ControlError> {
        let terminals = self.app.state::<TerminalService>();
        Ok(TerminalInspectResult {
            terminal_id: id,
            descriptor: terminals.get(id).map_err(terminal_control_error)?,
            projection: terminals.project(id).map_err(terminal_control_error)?,
        })
    }

    fn terminal_write(&self, id: TerminalId, data: Vec<u8>) -> Result<(), ControlError> {
        self.app
            .state::<TerminalService>()
            .write(id, &data)
            .map_err(terminal_control_error)
    }

    fn terminal_report(
        &self,
        report: TerminalAgentReportRequest,
    ) -> Result<TerminalAgentActivity, ControlError> {
        self.app
            .state::<TerminalService>()
            .report_agent(report)
            .map_err(terminal_control_error)
    }

    fn terminal_close(&self, id: TerminalId) -> Result<TerminalCloseResult, ControlError> {
        self.app
            .state::<TerminalService>()
            .close(id)
            .map_err(terminal_control_error)
    }

    fn terminal_attach(
        &self,
        id: TerminalId,
        sink: Arc<dyn TerminalEventSink>,
    ) -> Result<TerminalAttachment, ControlError> {
        self.app
            .state::<TerminalService>()
            .attach(id, sink, false)
            .map_err(terminal_control_error)
    }

    fn terminal_detach(&self, attachment_id: TerminalAttachmentId) -> Result<(), ControlError> {
        self.app
            .state::<TerminalService>()
            .detach(attachment_id)
            .map_err(terminal_control_error)
    }

    fn save_state(&self, destination: &Path) -> Result<StateArchiveInspection, ControlError> {
        self.app.state::<StateArchiveService>().save(destination)
    }

    fn shutdown(&self, _force: bool) -> Result<(), ControlError> {
        perform_shutdown(&self.app);
        Ok(())
    }
}

fn scheduler_control_error(error: SchedulerControlError) -> ControlError {
    let message = error.diagnostic().map_or_else(
        || "Scheduler request identity conflicts with an existing mutation".to_string(),
        |diagnostic| format!("Scheduler control rejected: {}", diagnostic.code),
    );
    ControlError::new(error.code(), message)
}

fn perform_shutdown(app: &tauri::AppHandle) {
    let terminals = app.state::<TerminalService>();
    if !terminals.begin_shutdown() {
        return;
    }
    app.state::<SchedulerService>().shutdown();
    app.state::<GitWatcher>().shutdown();
    terminals.shutdown_all();
    app.exit(0);
}

#[tauri::command]
pub fn shutdown_and_quit(app: tauri::AppHandle) -> Result<(), String> {
    perform_shutdown(&app);
    Ok(())
}
