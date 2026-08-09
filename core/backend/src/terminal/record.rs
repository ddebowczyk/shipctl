use std::sync::{Arc, Condvar, Mutex};

use super::runtime::TerminalRuntimeHandle;
use super::types::{
    TerminalAgentActivity, TerminalAgentAttention, TerminalAgentAttentionKind,
    TerminalAgentReportKind, TerminalAgentReportRequest, TerminalAgentState, TerminalDescriptor,
    TerminalError, TerminalErrorCode, TerminalExit, TerminalExitReason, TerminalId,
    TerminalLaunchRequest, TerminalLifecycle, TerminalMetadata, TerminalRevision,
};

pub struct TerminalRecord {
    state: Mutex<RecordState>,
    runtime: Mutex<RuntimeState>,
    runtime_ready: Condvar,
}

#[derive(Default)]
struct RuntimeState {
    handle: Option<TerminalRuntimeHandle>,
    startup_complete: bool,
}

struct RecordState {
    descriptor: TerminalDescriptor,
    child_pid: Option<u32>,
}

impl TerminalRecord {
    pub fn new(id: TerminalId, request: &TerminalLaunchRequest) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(RecordState {
                descriptor: TerminalDescriptor {
                    id,
                    revision: TerminalRevision::default(),
                    lifecycle: TerminalLifecycle::Starting,
                    exit: None,
                    metadata: request.metadata.clone(),
                    columns: request.columns,
                    rows: request.rows,
                    last_output_at_ms: None,
                    agent_activity: None,
                },
                child_pid: None,
            }),
            runtime: Mutex::new(RuntimeState::default()),
            runtime_ready: Condvar::new(),
        })
    }

    pub fn id(&self) -> TerminalId {
        self.state().descriptor.id
    }

    pub fn descriptor(&self) -> TerminalDescriptor {
        self.state().descriptor.clone()
    }

    pub fn lifecycle(&self) -> TerminalLifecycle {
        self.state().descriptor.lifecycle
    }

    pub fn is_active(&self) -> bool {
        matches!(
            self.lifecycle(),
            TerminalLifecycle::Starting | TerminalLifecycle::Running | TerminalLifecycle::Closing
        )
    }

    pub fn install_running(&self, runtime: TerminalRuntimeHandle, child_pid: Option<u32>) {
        let mut runtime_state = self
            .runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        runtime_state.handle = Some(runtime);
        runtime_state.startup_complete = true;
        let mut state = self.state();
        state.child_pid = child_pid;
        if state.descriptor.lifecycle == TerminalLifecycle::Starting {
            state.descriptor.lifecycle = TerminalLifecycle::Running;
            revise(&mut state.descriptor);
        }
        drop(state);
        drop(runtime_state);
        self.runtime_ready.notify_all();
    }

    pub fn mark_startup_failed(&self) {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        runtime.startup_complete = true;
        drop(runtime);
        self.runtime_ready.notify_all();
    }

    pub fn runtime(&self) -> Option<TerminalRuntimeHandle> {
        self.runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .handle
            .clone()
    }

    /// Wait only across the bounded startup phase. This closes the race where
    /// a listed `starting` terminal is closed before its runtime handle is
    /// installed; close still waits for and terminates the child it targeted.
    pub fn wait_runtime(&self) -> Option<TerminalRuntimeHandle> {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while !runtime.startup_complete {
            runtime = self
                .runtime_ready
                .wait(runtime)
                .unwrap_or_else(|error| error.into_inner());
        }
        runtime.handle.clone()
    }

    pub fn child_pid(&self) -> Option<u32> {
        self.state().child_pid
    }

    pub fn note_output(&self) -> TerminalRevision {
        let mut state = self.state();
        state.descriptor.last_output_at_ms = Some(now_epoch_millis());
        revise(&mut state.descriptor);
        state.descriptor.revision
    }

    pub fn record_resize(&self, columns: u16, rows: u16) -> TerminalDescriptor {
        let mut state = self.state();
        state.descriptor.columns = columns;
        state.descriptor.rows = rows;
        revise(&mut state.descriptor);
        state.descriptor.clone()
    }

    pub fn note_replay_change(&self) -> TerminalDescriptor {
        let mut state = self.state();
        revise(&mut state.descriptor);
        state.descriptor.clone()
    }

    pub fn update_metadata(&self, metadata: TerminalMetadata) -> TerminalDescriptor {
        let mut state = self.state();
        state.descriptor.metadata = metadata;
        revise(&mut state.descriptor);
        state.descriptor.clone()
    }

    pub fn report_agent(
        &self,
        report: TerminalAgentReportRequest,
    ) -> Result<TerminalDescriptor, TerminalError> {
        let mut state = self.state();
        match state.descriptor.lifecycle {
            TerminalLifecycle::Running => {}
            TerminalLifecycle::Exited => {
                return Err(TerminalError::new(
                    TerminalErrorCode::Exited,
                    format!("Terminal {} has exited", state.descriptor.id),
                ));
            }
            TerminalLifecycle::Closing => {
                return Err(TerminalError::new(
                    TerminalErrorCode::Closing,
                    format!("Terminal {} is closing", state.descriptor.id),
                ));
            }
            TerminalLifecycle::Starting => {
                return Err(TerminalError::new(
                    TerminalErrorCode::InvalidRequest,
                    format!("Terminal {} is still starting", state.descriptor.id),
                ));
            }
        }
        let activity_revision = state
            .descriptor
            .agent_activity
            .as_ref()
            .map_or(1, |activity| {
                activity.revision.checked_add(1).expect(
                    "terminal agent activity revision overflow is a fatal invariant violation",
                )
            });
        let (agent_state, attention_kind) = match report.kind {
            TerminalAgentReportKind::Idle => (TerminalAgentState::Idle, None),
            TerminalAgentReportKind::Working => (TerminalAgentState::Working, None),
            TerminalAgentReportKind::Blocked => (
                TerminalAgentState::Blocked,
                Some(TerminalAgentAttentionKind::Blocked),
            ),
            TerminalAgentReportKind::Completed => (
                TerminalAgentState::Idle,
                Some(TerminalAgentAttentionKind::Completed),
            ),
        };
        state.descriptor.agent_activity = Some(TerminalAgentActivity {
            revision: activity_revision,
            state: agent_state,
            message: report.message,
            updated_at_ms: now_epoch_millis(),
            source: report.source,
            attention: attention_kind.map(|kind| TerminalAgentAttention {
                kind,
                revision: activity_revision,
            }),
        });
        revise(&mut state.descriptor);
        Ok(state.descriptor.clone())
    }

    pub fn mark_closing(&self) -> TerminalDescriptor {
        let mut state = self.state();
        if matches!(
            state.descriptor.lifecycle,
            TerminalLifecycle::Starting | TerminalLifecycle::Running
        ) {
            state.descriptor.lifecycle = TerminalLifecycle::Closing;
            revise(&mut state.descriptor);
        }
        state.descriptor.clone()
    }

    /// Finalization is idempotent so natural-exit/explicit-close races cannot
    /// publish twice or recreate a record removed by the service.
    pub fn finish_exit(&self, code: Option<i32>, reason: TerminalExitReason) -> TerminalDescriptor {
        let mut state = self.state();
        if state.descriptor.lifecycle != TerminalLifecycle::Exited {
            state.descriptor.lifecycle = TerminalLifecycle::Exited;
            state.descriptor.exit = Some(TerminalExit {
                code,
                reason,
                observed_at_ms: now_epoch_millis(),
            });
            state.child_pid = None;
            revise(&mut state.descriptor);
        }
        state.descriptor.clone()
    }

    pub fn exit(&self) -> Option<TerminalExit> {
        self.state().descriptor.exit.clone()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, RecordState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }
}

fn revise(descriptor: &mut TerminalDescriptor) {
    descriptor.revision = descriptor.revision.next();
}

pub(crate) fn now_epoch_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use shipctl_module_api::TerminalColorTheme;

    use super::*;
    use crate::terminal::types::{TerminalLaunchTarget, TerminalOwner};

    fn request() -> TerminalLaunchRequest {
        TerminalLaunchRequest {
            target: TerminalLaunchTarget::Program {
                program: "/usr/bin/true".into(),
                argv: Vec::new(),
            },
            cwd: PathBuf::from("/tmp"),
            environment: HashMap::new(),
            columns: 80,
            rows: 24,
            color_theme: TerminalColorTheme {
                foreground: "#ffffff".to_string(),
                background: "#000000".to_string(),
                palette: vec!["#000000".to_string(); 16],
            },
            metadata: TerminalMetadata {
                label: "test".to_string(),
                cwd: PathBuf::from("/tmp"),
                project_path: None,
                display_command: "true".to_string(),
                created_at_ms: 1,
                owner: TerminalOwner::Core,
                owner_metadata: None,
                presentation: None,
            },
        }
    }

    #[test]
    fn exit_is_durable_and_finalization_is_idempotent() {
        let record = TerminalRecord::new(TerminalId::new(), &request());
        let first = record.finish_exit(Some(0), TerminalExitReason::ProcessExit);
        let second = record.finish_exit(Some(9), TerminalExitReason::ExplicitClose);

        assert_eq!(first, second);
        assert_eq!(record.lifecycle(), TerminalLifecycle::Exited);
        assert!(!record.is_active());
    }
}
