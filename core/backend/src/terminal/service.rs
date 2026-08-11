//! Host-owned terminal registry. Registry locks protect only lookup and
//! reservation; all PTY, wait, subscriber, and serialization work happens
//! after cloning a record handle and dropping the registry guard.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use shipctl_module_api::TerminalColorTheme;

use super::input::TerminalInput;
use super::projection::{
    ProjectedPoint, ProjectedSpace, TerminalAnchor, TerminalAnchorId, TerminalHistoryWindow,
    TerminalProjection, TerminalSelectionRequest, TerminalSelectionState,
};
use super::record::TerminalRecord;
use super::retention::TerminalRetentionPolicy;
use super::runtime::{
    TerminalCloseTicket, TerminalEventSink, TerminalPublicationStats, TerminalRuntimeHandle,
};
use super::types::{
    TerminalAgentActivity, TerminalAgentReportRequest, TerminalAttachment, TerminalAttachmentId,
    TerminalCloseResult, TerminalDescriptor, TerminalError, TerminalErrorCode, TerminalExitReason,
    TerminalId, TerminalLaunchRequest, TerminalMetadata, TerminalRegistryEvent,
    TerminalRegistrySubscriptionId, TerminalRuntimeSnapshot, TerminalTransport,
    TERMINAL_AGENT_REPORT_MAX_BYTES,
};

pub trait TerminalRegistryEventSink: Send + Sync + 'static {
    fn publish(&self, event: TerminalRegistryEvent) -> Result<(), String>;
}

impl<F> TerminalRegistryEventSink for F
where
    F: Fn(TerminalRegistryEvent) -> Result<(), String> + Send + Sync + 'static,
{
    fn publish(&self, event: TerminalRegistryEvent) -> Result<(), String> {
        self(event)
    }
}

#[derive(Clone)]
pub struct TerminalService {
    inner: Arc<TerminalServiceInner>,
}

struct TerminalServiceInner {
    instance_id: Arc<str>,
    records: Mutex<HashMap<TerminalId, RegisteredTerminal>>,
    attachments: Mutex<HashMap<TerminalAttachmentId, TerminalId>>,
    registry_subscribers:
        Mutex<HashMap<TerminalRegistrySubscriptionId, Arc<dyn TerminalRegistryEventSink>>>,
    shutting_down: AtomicBool,
    next_creation_ordinal: AtomicU64,
    /// The committed product retention policy and its monotonic revision. One
    /// lock keeps the pair atomic, so a spawn can never read a policy from one
    /// commit and a revision from another.
    retention: Mutex<RetentionCommit>,
}

#[derive(Clone, Copy, Debug)]
pub struct RetentionCommit {
    pub policy: TerminalRetentionPolicy,
    pub revision: u64,
}

struct RegisteredTerminal {
    creation_ordinal: u64,
    record: Arc<TerminalRecord>,
}

impl TerminalService {
    pub fn new(instance_id: impl Into<String>, retention: TerminalRetentionPolicy) -> Self {
        Self {
            inner: Arc::new(TerminalServiceInner {
                instance_id: Arc::from(instance_id.into()),
                records: Mutex::new(HashMap::new()),
                attachments: Mutex::new(HashMap::new()),
                registry_subscribers: Mutex::new(HashMap::new()),
                shutting_down: AtomicBool::new(false),
                next_creation_ordinal: AtomicU64::new(0),
                retention: Mutex::new(RetentionCommit {
                    policy: retention,
                    revision: 1,
                }),
            }),
        }
    }

    pub fn spawn(
        &self,
        mut request: TerminalLaunchRequest,
    ) -> Result<TerminalDescriptor, TerminalError> {
        let id = TerminalId::new();
        let creation_ordinal = self
            .inner
            .next_creation_ordinal
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .expect("terminal creation ordinal overflow is a fatal invariant violation");
        self.inject_host_environment(id, &mut request.environment);
        let record = TerminalRecord::new(id, &request);

        {
            let mut records = self.records();
            if self.is_shutting_down() {
                return Err(TerminalError::new(
                    TerminalErrorCode::ShuttingDown,
                    "Cannot spawn a terminal while Shipctl is shutting down",
                ));
            }
            let replaced = records.insert(
                id,
                RegisteredTerminal {
                    creation_ordinal,
                    record: Arc::clone(&record),
                },
            );
            assert!(replaced.is_none(), "UUID terminal IDs must never be reused");
        }

        let weak = Arc::downgrade(&self.inner);
        let descriptor_sink = Arc::new(move |descriptor: TerminalDescriptor| {
            if let Some(inner) = weak.upgrade() {
                inner.publish_registry_event(TerminalRegistryEvent::Upserted { descriptor });
            }
        });
        if let Err(error) = TerminalRuntimeHandle::start(
            Arc::clone(&record),
            request,
            descriptor_sink,
            self.retention().policy,
        ) {
            self.records().remove(&id);
            record.finish_exit(None, TerminalExitReason::StartupFailure);
            return Err(error);
        }
        let descriptor = record.descriptor();
        self.inner
            .publish_registry_event(TerminalRegistryEvent::Upserted {
                descriptor: descriptor.clone(),
            });
        Ok(descriptor)
    }

    /// The policy every terminal created after the last commit will use.
    pub fn retention(&self) -> RetentionCommit {
        *self
            .inner
            .retention
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    /// Commit a new policy and return the new revision. The revision only ever
    /// increases, so a delayed caller cannot reinstate an older policy.
    pub fn set_retention(&self, policy: TerminalRetentionPolicy) -> RetentionCommit {
        let mut committed = self
            .inner
            .retention
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        committed.policy = policy;
        committed.revision = committed
            .revision
            .checked_add(1)
            .expect("retention revision overflow is a fatal invariant violation");
        *committed
    }

    pub fn list(&self) -> Vec<TerminalDescriptor> {
        let mut descriptors = self
            .records()
            .values()
            .map(|registered| (registered.creation_ordinal, registered.record.descriptor()))
            .collect::<Vec<_>>();
        descriptors.sort_by_key(|(creation_ordinal, _)| *creation_ordinal);
        descriptors
            .into_iter()
            .map(|(_, descriptor)| descriptor)
            .collect()
    }

    pub fn get(&self, id: TerminalId) -> Result<TerminalDescriptor, TerminalError> {
        Ok(self.record(id)?.descriptor())
    }

    pub fn snapshot(&self, id: TerminalId) -> Result<TerminalRuntimeSnapshot, TerminalError> {
        runtime(self.record(id)?.as_ref())?.snapshot()
    }

    /// Cumulative publication observations for one terminal runtime.
    pub fn publication_stats(
        &self,
        id: TerminalId,
    ) -> Result<TerminalPublicationStats, TerminalError> {
        runtime(self.record(id)?.as_ref())?.publication_stats()
    }

    /// What the host believes about this terminal, as owned values.
    ///
    /// This is an inspection path. It publishes nothing, changes no sequence,
    /// and no client depends on it.
    pub fn project(&self, id: TerminalId) -> Result<TerminalProjection, TerminalError> {
        runtime(self.record(id)?.as_ref())?.project()
    }

    /// A window of retained history as the same rows the viewport reports.
    ///
    /// The host is the retention authority, so this is the only answer to
    /// "what scrolled away" that no client has to reconstruct.
    pub fn project_history(
        &self,
        id: TerminalId,
        start_row: u32,
        rows: u32,
    ) -> Result<TerminalHistoryWindow, TerminalError> {
        runtime(self.record(id)?.as_ref())?.project_history(start_row, rows)
    }

    /// Pins a cell so a client can keep pointing at one line while row numbers
    /// move under it.
    pub fn anchor(
        &self,
        id: TerminalId,
        space: ProjectedSpace,
        at: ProjectedPoint,
    ) -> Result<TerminalAnchor, TerminalError> {
        runtime(self.record(id)?.as_ref())?.anchor(space, at)
    }

    /// Where an anchor is now, or `None` when the host holds no such handle.
    pub fn resolve_anchor(
        &self,
        id: TerminalId,
        anchor: TerminalAnchorId,
    ) -> Result<Option<TerminalAnchor>, TerminalError> {
        runtime(self.record(id)?.as_ref())?.resolve_anchor(anchor)
    }

    /// Drops an anchor, answering whether the host was holding it.
    pub fn release_anchor(
        &self,
        id: TerminalId,
        anchor: TerminalAnchorId,
    ) -> Result<bool, TerminalError> {
        runtime(self.record(id)?.as_ref())?.release_anchor(anchor)
    }

    /// Select by intent, and answer what the host holds.
    ///
    /// The client names a point, a word, a command's output or a movement, and
    /// never a set of cells: which cells an intent covers depends on where rows
    /// wrap, where a word ends, where the OSC 133 marks are and where history
    /// begins. The selected text comes back with the answer for the same
    /// reason — unwrapping a wrapped line and dropping the spacer half of a
    /// wide grapheme are the host's facts.
    pub fn select(
        &self,
        id: TerminalId,
        request: TerminalSelectionRequest,
    ) -> Result<TerminalSelectionState, TerminalError> {
        runtime(self.record(id)?.as_ref())?.select(request)
    }

    /// Write exact bytes. Legacy: a client that decides its own bytes keeps a
    /// second copy of the child's modes, which is what [`Self::input`] exists
    /// to end.
    pub fn write(&self, id: TerminalId, data: &[u8]) -> Result<(), TerminalError> {
        runtime(self.record(id)?.as_ref())?.write(data.to_vec())
    }

    /// Report what a person did and let the host encode it from the modes the
    /// child selected. Answers how many bytes that became, which is zero when
    /// the current modes do not report the input.
    pub fn input(&self, id: TerminalId, input: TerminalInput) -> Result<usize, TerminalError> {
        runtime(self.record(id)?.as_ref())?.input(input)
    }

    pub fn resize(
        &self,
        id: TerminalId,
        attachment_id: TerminalAttachmentId,
        columns: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        runtime(self.record(id)?.as_ref())?.resize(attachment_id, columns, rows)
    }

    pub fn update_metadata(
        &self,
        id: TerminalId,
        metadata: TerminalMetadata,
    ) -> Result<TerminalDescriptor, TerminalError> {
        runtime(self.record(id)?.as_ref())?.update_metadata(metadata)
    }

    pub fn report_agent(
        &self,
        report: TerminalAgentReportRequest,
    ) -> Result<TerminalAgentActivity, TerminalError> {
        validate_agent_report(&report)?;
        let record = self.record(report.terminal_id)?;
        runtime(record.as_ref())?.report_agent(report)
    }

    pub fn set_color_theme(&self, theme: TerminalColorTheme) -> Result<(), TerminalError> {
        let records = self
            .records()
            .values()
            .map(|registered| Arc::clone(&registered.record))
            .collect::<Vec<_>>();
        for record in records {
            if let Some(runtime) = record.runtime() {
                runtime.set_theme(theme.clone())?;
            }
        }
        Ok(())
    }

    /// Attach on the byte path.
    ///
    /// Legacy: every caller of this is a client area 05 has still to move. The
    /// transport is named at the one call below rather than defaulted inside
    /// the actor, so the callers that must change are the callers of this
    /// method and nothing else.
    pub fn attach(
        &self,
        id: TerminalId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
    ) -> Result<TerminalAttachment, TerminalError> {
        self.attach_with(id, sink, claims_resize, TerminalTransport::Legacy)
    }

    /// Attach and say which encoding of the terminal to receive.
    pub fn attach_with(
        &self,
        id: TerminalId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
        transport: TerminalTransport,
    ) -> Result<TerminalAttachment, TerminalError> {
        let runtime = runtime(self.record(id)?.as_ref())?;
        let attachment_id = TerminalAttachmentId::new();
        self.attachments().insert(attachment_id, id);
        let weak = Arc::downgrade(&self.inner);
        let on_detached: Arc<dyn Fn(TerminalAttachmentId) + Send + Sync> =
            Arc::new(move |attachment_id| {
                if let Some(inner) = weak.upgrade() {
                    inner
                        .attachments
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .remove(&attachment_id);
                }
            });
        match runtime.attach(attachment_id, sink, claims_resize, transport, on_detached) {
            Ok(attachment) => {
                if !attachment.live {
                    self.attachments().remove(&attachment_id);
                }
                Ok(attachment)
            }
            Err(error) => {
                self.attachments().remove(&attachment_id);
                Err(error)
            }
        }
    }

    pub fn detach(&self, attachment_id: TerminalAttachmentId) -> Result<(), TerminalError> {
        let Some(id) = self.attachments().remove(&attachment_id) else {
            return Ok(());
        };
        let Ok(record) = self.record(id) else {
            return Ok(());
        };
        let Some(runtime) = record.runtime() else {
            return Ok(());
        };
        runtime.detach(attachment_id)
    }

    /// Grant one more replaceable semantic-screen publication after the
    /// client committed the frame named by `committed_sequence`.
    pub fn credit_screen(
        &self,
        attachment_id: TerminalAttachmentId,
        committed_sequence: u64,
    ) -> Result<(), TerminalError> {
        let id = self
            .attachments()
            .get(&attachment_id)
            .copied()
            .ok_or_else(|| {
                TerminalError::new(
                    TerminalErrorCode::NotFound,
                    format!("Terminal attachment {attachment_id:?} was not found"),
                )
            })?;
        runtime(self.record(id)?.as_ref())?.credit_screen(attachment_id, committed_sequence)
    }

    pub fn subscribe_registry(
        &self,
        sink: Arc<dyn TerminalRegistryEventSink>,
    ) -> TerminalRegistrySubscriptionId {
        let subscription_id = TerminalRegistrySubscriptionId::new();
        self.inner
            .registry_subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(subscription_id, sink);
        subscription_id
    }

    pub fn unsubscribe_registry(&self, subscription_id: TerminalRegistrySubscriptionId) {
        self.inner
            .registry_subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&subscription_id);
    }

    pub fn wait_for_exit(
        &self,
        id: TerminalId,
    ) -> Result<super::types::TerminalExit, TerminalError> {
        runtime(self.record(id)?.as_ref())?.wait_for_exit()
    }

    /// Close a terminal without ever creating an unobservable absence.
    ///
    /// The record stays registered for the whole close, so a parked close is
    /// still discoverable and truthfully described as `Closing`. Removal and
    /// `Removed` are one ordered commit reached only after the process is
    /// gone. A failed close therefore leaves a discoverable record that the
    /// same call can retry, never a silent disappearance.
    pub fn close(&self, id: TerminalId) -> Result<TerminalCloseResult, TerminalError> {
        let Some(record) = self
            .records()
            .get(&id)
            .map(|registered| Arc::clone(&registered.record))
        else {
            return Ok(TerminalCloseResult {
                existed: false,
                exit: None,
            });
        };
        // Reject input for the whole close, not only once the runtime reaches
        // the command. The runtime publishes this transition when it handles
        // the close, and the record is still registered, so that publication
        // now reaches observers instead of being dropped as unregistered.
        record.mark_closing();
        let exit = if let Some(runtime) = record.wait_runtime() {
            // The runtime coalesces concurrent close requests onto one
            // termination, so racing callers observe the same exit.
            runtime
                .request_close(TerminalExitReason::ExplicitClose)?
                .wait()?
        } else {
            record
                .finish_exit(None, TerminalExitReason::ExplicitClose)
                .exit
                .expect("explicitly closed record must have exit state")
        };
        // The commit. Only the caller that removes the record publishes the
        // removal, so concurrent closes produce exactly one `Removed`.
        if self.records().remove(&id).is_some() {
            self.inner
                .publish_registry_event(TerminalRegistryEvent::Removed { terminal_id: id });
        }
        Ok(TerminalCloseResult {
            existed: true,
            exit: Some(exit),
        })
    }

    pub fn active_count(&self) -> usize {
        self.records()
            .values()
            .filter(|registered| registered.record.is_active())
            .count()
    }

    /// Number of live transport/view observers. This is operational state,
    /// never process ownership: dropping the last attachment leaves the
    /// terminal running.
    pub fn attachment_count(&self) -> usize {
        self.attachments().len()
    }

    pub fn child_pids(&self) -> Vec<u32> {
        self.records()
            .values()
            .filter_map(|registered| registered.record.child_pid())
            .collect()
    }

    pub fn begin_shutdown(&self) -> bool {
        !self.inner.shutting_down.swap(true, Ordering::SeqCst)
    }

    pub fn is_shutting_down(&self) -> bool {
        self.inner.shutting_down.load(Ordering::SeqCst)
    }

    pub fn shutdown_all(&self) {
        let records = self
            .records()
            .drain()
            .map(|(_, registered)| registered.record)
            .collect::<Vec<_>>();

        // Request every termination before waiting for any one process. Each
        // runtime uses the same established grace duration from its request.
        let mut tickets: Vec<TerminalCloseTicket> = Vec::new();
        for record in records {
            record.mark_closing();
            if let Some(runtime) = record.wait_runtime() {
                if let Ok(ticket) = runtime.request_close(TerminalExitReason::HostShutdown) {
                    tickets.push(ticket);
                }
            } else {
                record.finish_exit(None, TerminalExitReason::HostShutdown);
            }
        }
        for ticket in tickets {
            let _ = ticket.wait();
        }
    }

    pub fn inject_host_environment(
        &self,
        id: TerminalId,
        environment: &mut HashMap<String, String>,
    ) {
        environment.insert(
            "SHIPCTL_INSTANCE_ID".to_string(),
            self.inner.instance_id.to_string(),
        );
        environment.insert("SHIPCTL_TERMINAL_ID".to_string(), id.to_string());
    }

    fn record(&self, id: TerminalId) -> Result<Arc<TerminalRecord>, TerminalError> {
        self.records()
            .get(&id)
            .map(|registered| Arc::clone(&registered.record))
            .ok_or_else(|| {
                TerminalError::new(
                    TerminalErrorCode::NotFound,
                    format!("Terminal {id} was not found"),
                )
            })
    }

    fn records(&self) -> std::sync::MutexGuard<'_, HashMap<TerminalId, RegisteredTerminal>> {
        self.inner
            .records
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn attachments(&self) -> std::sync::MutexGuard<'_, HashMap<TerminalAttachmentId, TerminalId>> {
        self.inner
            .attachments
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

impl TerminalServiceInner {
    fn publish_registry_event(&self, event: TerminalRegistryEvent) {
        if let TerminalRegistryEvent::Upserted { descriptor } = &event {
            let is_registered = self
                .records
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .contains_key(&descriptor.id);
            if !is_registered {
                return;
            }
        }

        let subscribers = self
            .registry_subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(id, sink)| (*id, Arc::clone(sink)))
            .collect::<Vec<_>>();
        let failed = subscribers
            .into_iter()
            .filter_map(|(id, sink)| sink.publish(event.clone()).err().map(|_| id))
            .collect::<Vec<_>>();
        if failed.is_empty() {
            return;
        }
        let mut registered = self
            .registry_subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for id in failed {
            registered.remove(&id);
        }
    }
}

fn runtime(record: &TerminalRecord) -> Result<TerminalRuntimeHandle, TerminalError> {
    record.runtime().ok_or_else(|| {
        TerminalError::new(
            TerminalErrorCode::RuntimeStopped,
            format!("Terminal {} runtime is not ready", record.id()),
        )
    })
}

fn validate_agent_report(report: &TerminalAgentReportRequest) -> Result<(), TerminalError> {
    for (field, value) in [
        ("source identifier", report.source.identifier.as_str()),
        ("source version", report.source.version.as_str()),
    ] {
        if value.is_empty()
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+' | b':')
            })
        {
            return Err(TerminalError::new(
                TerminalErrorCode::InvalidRequest,
                format!(
                    "Agent report {field} must be a non-empty ASCII identifier using letters, digits, '.', '_', '-', '+', or ':'"
                ),
            ));
        }
    }
    if let Some(message) = &report.message {
        if message.trim().is_empty() || message.chars().any(char::is_control) {
            return Err(TerminalError::new(
                TerminalErrorCode::InvalidRequest,
                "Agent report message must be non-blank and contain no control characters",
            ));
        }
    }
    let serialized_bytes = serde_json::to_vec(report)
        .expect("terminal agent report contains only infallibly serializable domain fields")
        .len();
    if serialized_bytes > TERMINAL_AGENT_REPORT_MAX_BYTES {
        return Err(TerminalError::new(
            TerminalErrorCode::InvalidRequest,
            format!(
                "Agent report exceeds the established {TERMINAL_AGENT_REPORT_MAX_BYTES}-byte terminal control budget ({serialized_bytes} bytes observed)"
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{mpsc, Condvar};

    use shipctl_module_api::TerminalColorTheme;

    use super::*;
    use crate::terminal::{
        TerminalAgentAttentionKind, TerminalAgentReportKind, TerminalAgentReportSource,
        TerminalAgentState, TerminalEvent, TerminalLaunchTarget, TerminalLifecycle, TerminalOwner,
    };

    fn shell_request(source: &str) -> TerminalLaunchRequest {
        let cwd = PathBuf::from("/tmp");
        TerminalLaunchRequest {
            target: TerminalLaunchTarget::Program {
                program: PathBuf::from("/bin/sh"),
                argv: vec!["-c".to_string(), source.to_string()],
            },
            cwd: cwd.clone(),
            environment: HashMap::new(),
            columns: 80,
            rows: 24,
            color_theme: TerminalColorTheme {
                foreground: "#ffffff".to_string(),
                background: "#000000".to_string(),
                palette: vec!["#000000".to_string(); 16],
            },
            metadata: TerminalMetadata {
                label: "test terminal".to_string(),
                cwd,
                project_path: None,
                display_command: "sh".to_string(),
                created_at_ms: 1,
                owner: TerminalOwner::Core,
                owner_metadata: None,
                presentation: None,
            },
        }
    }

    fn event_sequence(event: &TerminalEvent) -> u64 {
        match event {
            TerminalEvent::Output { sequence, .. }
            | TerminalEvent::Replay { sequence, .. }
            | TerminalEvent::Screen { sequence, .. }
            | TerminalEvent::Effects { sequence, .. }
            | TerminalEvent::MetadataChanged { sequence, .. }
            | TerminalEvent::AgentActivityChanged { sequence, .. }
            | TerminalEvent::Exited { sequence, .. }
            | TerminalEvent::ResyncRequired { sequence, .. }
            | TerminalEvent::Detached { sequence, .. } => *sequence,
        }
    }

    #[test]
    fn retention_is_service_state_and_its_revision_only_moves_forward() {
        let service = TerminalService::new(
            "runtime-instance",
            TerminalRetentionPolicy::from_bytes(4 * 1024 * 1024),
        );
        let seeded = service.retention();
        assert_eq!(seeded.policy.bytes(), 4 * 1024 * 1024);

        let first = service.set_retention(TerminalRetentionPolicy::from_bytes(0));
        assert!(first.revision > seeded.revision);
        assert_eq!(service.retention().policy.bytes(), 0);

        // Re-committing the value the service started with still advances the
        // revision, so a client cannot mistake it for the earlier commit.
        let second = service.set_retention(seeded.policy);
        assert!(second.revision > first.revision);
        assert_eq!(service.retention().policy, seeded.policy);
    }

    #[test]
    fn an_out_of_domain_setting_cannot_reach_the_parser() {
        let service = TerminalService::new(
            "runtime-instance",
            TerminalRetentionPolicy::from_bytes(usize::MAX),
        );
        assert_eq!(
            service.retention().policy.bytes(),
            crate::terminal::retention::RETENTION_MAX_BYTES
        );
    }

    #[test]
    fn host_identity_overrides_untrusted_environment() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let id = TerminalId::new();
        let mut environment = HashMap::from([
            ("SHIPCTL_INSTANCE_ID".to_string(), "spoofed".to_string()),
            ("SHIPCTL_TERMINAL_ID".to_string(), "spoofed".to_string()),
        ]);

        service.inject_host_environment(id, &mut environment);

        assert_eq!(environment["SHIPCTL_INSTANCE_ID"], "runtime-instance");
        assert_eq!(environment["SHIPCTL_TERMINAL_ID"], id.to_string());
    }

    #[test]
    fn registry_helpers_release_the_lock_before_runtime_work() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let records = service.records();
        drop(records);
        assert!(service.inner.records.try_lock().is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn registry_subscription_tracks_spawn_update_exit_and_removal_without_attachment() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let (sender, receiver) = mpsc::channel();
        let sink: Arc<dyn TerminalRegistryEventSink> =
            Arc::new(move |event| sender.send(event).map_err(|error| error.to_string()));
        let subscription_id = service.subscribe_registry(sink);

        let descriptor = service.spawn(shell_request("read go; exit 3")).unwrap();
        assert_eq!(
            receiver.recv().unwrap(),
            TerminalRegistryEvent::Upserted {
                descriptor: descriptor.clone(),
            }
        );

        let mut metadata = descriptor.metadata.clone();
        metadata.label = "renamed".to_string();
        let updated = service.update_metadata(descriptor.id, metadata).unwrap();
        assert_eq!(
            receiver.recv().unwrap(),
            TerminalRegistryEvent::Upserted {
                descriptor: updated,
            }
        );

        service.write(descriptor.id, b"go\n").unwrap();
        service.wait_for_exit(descriptor.id).unwrap();
        let exited = service.get(descriptor.id).unwrap();
        assert_eq!(
            receiver.recv().unwrap(),
            TerminalRegistryEvent::Upserted { descriptor: exited }
        );

        service.close(descriptor.id).unwrap();
        assert_eq!(
            receiver.recv().unwrap(),
            TerminalRegistryEvent::Removed {
                terminal_id: descriptor.id,
            }
        );
        service.unsubscribe_registry(subscription_id);
    }

    #[cfg(unix)]
    #[test]
    fn explicit_agent_reports_are_ordered_public_state_and_never_process_lifecycle() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let descriptor = service.spawn(shell_request("read done; exit 0")).unwrap();
        let (registry_sender, registry_receiver) = mpsc::channel();
        let list_during_delivery = service.clone();
        let registry_sink: Arc<dyn TerminalRegistryEventSink> = Arc::new(move |event| {
            // Delivery must happen after the registry lock has been released.
            assert_eq!(list_during_delivery.list().len(), 1);
            registry_sender
                .send(event)
                .map_err(|error| error.to_string())
        });
        let subscription_id = service.subscribe_registry(registry_sink);
        let (attachment_sender, attachment_receiver) = mpsc::channel();
        let attachment_sink: Arc<dyn TerminalEventSink> = Arc::new(move |_id, event| {
            attachment_sender
                .send(event)
                .map_err(|error| error.to_string())
        });
        service
            .attach(descriptor.id, attachment_sink, false)
            .unwrap();

        let report = |kind, message: Option<&str>| TerminalAgentReportRequest {
            terminal_id: descriptor.id,
            kind,
            source: TerminalAgentReportSource {
                identifier: "test-agent".to_string(),
                version: "1.0.0".to_string(),
            },
            message: message.map(str::to_string),
        };
        let working = service
            .report_agent(report(TerminalAgentReportKind::Working, None))
            .unwrap();
        assert_eq!(working.revision, 1);
        assert_eq!(working.state, TerminalAgentState::Working);
        assert_eq!(working.attention, None);

        let blocked = service
            .report_agent(report(
                TerminalAgentReportKind::Blocked,
                Some("waiting for review"),
            ))
            .unwrap();
        assert_eq!(blocked.revision, 2);
        assert_eq!(blocked.state, TerminalAgentState::Blocked);
        assert_eq!(blocked.message.as_deref(), Some("waiting for review"));
        assert_eq!(
            blocked.attention.as_ref().map(|attention| attention.kind),
            Some(TerminalAgentAttentionKind::Blocked)
        );

        let completed = service
            .report_agent(report(TerminalAgentReportKind::Completed, Some("done")))
            .unwrap();
        assert_eq!(completed.revision, 3);
        assert_eq!(completed.state, TerminalAgentState::Idle);
        assert_eq!(
            completed.attention.as_ref().map(|attention| attention.kind),
            Some(TerminalAgentAttentionKind::Completed)
        );
        assert_eq!(
            service.get(descriptor.id).unwrap().lifecycle,
            TerminalLifecycle::Running
        );

        let idle = service
            .report_agent(report(TerminalAgentReportKind::Idle, None))
            .unwrap();
        assert_eq!(idle.revision, 4);
        assert_eq!(idle.state, TerminalAgentState::Idle);
        assert_eq!(idle.attention, None);

        for expected_revision in 1..=4 {
            let TerminalRegistryEvent::Upserted { descriptor } = registry_receiver.recv().unwrap()
            else {
                panic!("expected terminal upsert")
            };
            assert_eq!(
                descriptor.agent_activity.unwrap().revision,
                expected_revision
            );
            let TerminalEvent::AgentActivityChanged { descriptor, .. } =
                attachment_receiver.recv().unwrap()
            else {
                panic!("expected attachment agent activity event")
            };
            assert_eq!(
                descriptor.agent_activity.unwrap().revision,
                expected_revision
            );
        }

        service.write(descriptor.id, b"done\n").unwrap();
        service.wait_for_exit(descriptor.id).unwrap();
        let retained = service.get(descriptor.id).unwrap();
        assert_eq!(retained.agent_activity, Some(idle.clone()));
        assert_eq!(
            service
                .report_agent(report(TerminalAgentReportKind::Working, None))
                .unwrap_err()
                .code,
            TerminalErrorCode::Exited
        );
        assert_eq!(
            service.get(descriptor.id).unwrap().agent_activity,
            Some(idle)
        );
        service.unsubscribe_registry(subscription_id);
        service.close(descriptor.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn agent_report_validation_is_bounded_and_never_echoes_rejected_content() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let descriptor = service.spawn(shell_request("cat")).unwrap();
        let invalid_source = TerminalAgentReportRequest {
            terminal_id: descriptor.id,
            kind: TerminalAgentReportKind::Working,
            source: TerminalAgentReportSource {
                identifier: "not safe".to_string(),
                version: "1".to_string(),
            },
            message: None,
        };
        assert_eq!(
            service.report_agent(invalid_source).unwrap_err().code,
            TerminalErrorCode::InvalidRequest
        );

        let secret = "secret-sentinel";
        let oversized = TerminalAgentReportRequest {
            terminal_id: descriptor.id,
            kind: TerminalAgentReportKind::Blocked,
            source: TerminalAgentReportSource {
                identifier: "test".to_string(),
                version: "1".to_string(),
            },
            message: Some(format!(
                "{secret}{}",
                "x".repeat(TERMINAL_AGENT_REPORT_MAX_BYTES)
            )),
        };
        let error = service.report_agent(oversized).unwrap_err();
        assert_eq!(error.code, TerminalErrorCode::InvalidRequest);
        assert!(!error.message.contains(secret));
        service.close(descriptor.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn agent_report_and_process_exit_have_one_actor_order() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let descriptor = service.spawn(shell_request("exit 0")).unwrap();
        let reporter = service.clone();
        let report = TerminalAgentReportRequest {
            terminal_id: descriptor.id,
            kind: TerminalAgentReportKind::Completed,
            source: TerminalAgentReportSource {
                identifier: "race-test".to_string(),
                version: "1".to_string(),
            },
            message: Some("done".to_string()),
        };

        let report_result = std::thread::spawn(move || reporter.report_agent(report))
            .join()
            .unwrap();
        service.wait_for_exit(descriptor.id).unwrap();
        let retained = service.get(descriptor.id).unwrap();
        assert_eq!(retained.lifecycle, TerminalLifecycle::Exited);
        match report_result {
            Ok(activity) => assert_eq!(retained.agent_activity, Some(activity)),
            Err(error) => {
                assert_eq!(error.code, TerminalErrorCode::Exited);
                assert_eq!(retained.agent_activity, None);
            }
        }
        service.close(descriptor.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn natural_exit_is_retained_until_idempotent_close() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let descriptor = service
            .spawn(shell_request("printf retained-output; exit 7"))
            .unwrap();

        let exit = service.wait_for_exit(descriptor.id).unwrap();
        assert_eq!(exit.code, Some(7));
        let retained = service.get(descriptor.id).unwrap();
        assert_eq!(retained.id, descriptor.id);
        assert_eq!(retained.lifecycle, TerminalLifecycle::Exited);
        assert_eq!(service.active_count(), 0);
        assert_eq!(service.list(), vec![retained]);
        assert!(
            String::from_utf8_lossy(&service.snapshot(descriptor.id).unwrap().replay.bytes)
                .contains("retained-output")
        );
        assert_eq!(
            service.write(descriptor.id, b"late").unwrap_err().code,
            TerminalErrorCode::Exited
        );

        assert!(service.close(descriptor.id).unwrap().existed);
        assert!(!service.close(descriptor.id).unwrap().existed);
        assert_eq!(
            service.get(descriptor.id).unwrap_err().code,
            TerminalErrorCode::NotFound
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_output_sink_detaches_without_losing_later_state_or_exit() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let failed_sink: Arc<dyn TerminalEventSink> =
            Arc::new(|_terminal_id: TerminalId, _event: TerminalEvent| {
                Err("renderer disappeared".to_string())
            });
        let descriptor = service
            .spawn(shell_request(
                "read first; printf before-channel-failure; read second; printf after-channel-failure",
            ))
            .unwrap();

        service.attach(descriptor.id, failed_sink, false).unwrap();
        service.write(descriptor.id, b"one\ntwo\n").unwrap();

        service.wait_for_exit(descriptor.id).unwrap();
        let replay = service.snapshot(descriptor.id).unwrap().replay.bytes;
        let replay = String::from_utf8_lossy(&replay);
        assert!(replay.contains("before-channel-failure"));
        assert!(replay.contains("after-channel-failure"));
        assert_eq!(
            service.get(descriptor.id).unwrap().lifecycle,
            TerminalLifecycle::Exited
        );
        service.close(descriptor.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_spawns_mint_distinct_stable_ids() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let first_service = service.clone();
        let second_service = service.clone();
        let first =
            std::thread::spawn(move || first_service.spawn(shell_request("exit 0")).unwrap().id);
        let second =
            std::thread::spawn(move || second_service.spawn(shell_request("exit 0")).unwrap().id);
        let first = first.join().unwrap();
        let second = second.join().unwrap();

        assert_ne!(first, second);
        service.wait_for_exit(first).unwrap();
        service.wait_for_exit(second).unwrap();
        let listed = service.list();
        assert!(listed.iter().any(|descriptor| descriptor.id == first));
        assert!(listed.iter().any(|descriptor| descriptor.id == second));
        assert_eq!(service.get(first).unwrap().id, first);
        assert_eq!(service.get(second).unwrap().id, second);
        service.close(first).unwrap();
        service.close(second).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn list_preserves_registry_creation_order_independent_of_uuid_order() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let first = service.spawn(shell_request("cat")).unwrap();
        let second = service.spawn(shell_request("cat")).unwrap();

        assert_eq!(
            service
                .list()
                .into_iter()
                .map(|descriptor| descriptor.id)
                .collect::<Vec<_>>(),
            vec![first.id, second.id]
        );

        service.close(first.id).unwrap();
        service.close(second.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_parked_close_stays_discoverable_and_does_not_block_another_terminal() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let ready_sink: Arc<dyn TerminalEventSink> =
            Arc::new(move |_terminal_id: TerminalId, event: TerminalEvent| {
                if matches!(event, TerminalEvent::Output { .. }) {
                    let _ = ready_sender.try_send(());
                }
                Ok(())
            });
        let closing = service
            .spawn(shell_request(
                "read go; trap '' HUP TERM; printf ready; while :; do sleep 60; done",
            ))
            .unwrap();
        service.attach(closing.id, ready_sink, false).unwrap();
        service.write(closing.id, b"go\n").unwrap();
        ready_receiver.recv().unwrap();
        let writable = service.spawn(shell_request("cat")).unwrap();
        let closer = service.clone();
        let (done_sender, done_receiver) = mpsc::sync_channel(1);
        let close_thread = std::thread::spawn(move || {
            let result = closer.close(closing.id);
            done_sender.send(result).unwrap();
        });

        // The close parks in the grace period. Through the whole park the
        // record stays registered and truthfully reports `Closing`, so no
        // observer can see an absence that was never published.
        loop {
            if let Ok(records) = service.inner.records.try_lock() {
                assert!(
                    records.contains_key(&closing.id),
                    "a parked close must remain discoverable"
                );
                drop(records);
                if service.get(closing.id).unwrap().lifecycle == TerminalLifecycle::Closing {
                    assert!(matches!(
                        done_receiver.try_recv(),
                        Err(mpsc::TryRecvError::Empty)
                    ));
                    break;
                }
            }
            std::thread::yield_now();
        }
        service.write(writable.id, b"still-writable\n").unwrap();
        assert!(done_receiver.recv().unwrap().unwrap().existed);
        close_thread.join().unwrap();
        service.close(writable.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_closes_publish_one_removal_after_the_closing_transition() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&events);
        service.subscribe_registry(Arc::new(move |event: TerminalRegistryEvent| {
            observed
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(event);
            Ok(())
        }));
        let descriptor = service.spawn(shell_request("cat")).unwrap();

        let id = descriptor.id;
        let left_service = service.clone();
        let right_service = service.clone();
        let left = std::thread::spawn(move || left_service.close(id).unwrap());
        let right = std::thread::spawn(move || right_service.close(id).unwrap());
        let left = left.join().unwrap();
        let right = right.join().unwrap();

        // Both callers observe the same close transaction.
        assert!(left.existed && right.existed);
        assert_eq!(
            left.exit.map(|exit| exit.reason),
            right.exit.map(|exit| exit.reason)
        );

        let events = events.lock().unwrap_or_else(|error| error.into_inner());
        let removals = events
            .iter()
            .filter(|event| matches!(event, TerminalRegistryEvent::Removed { .. }))
            .count();
        assert_eq!(removals, 1, "concurrent closes must publish one removal");
        let removal = events
            .iter()
            .position(|event| matches!(event, TerminalRegistryEvent::Removed { .. }))
            .expect("a successful close publishes its removal");
        assert!(
            events[..removal].iter().any(|event| matches!(
                event,
                TerminalRegistryEvent::Upserted { descriptor }
                    if descriptor.lifecycle == TerminalLifecycle::Closing
            )),
            "the closing transition must be observable before the removal"
        );
    }

    #[cfg(unix)]
    #[test]
    fn attach_captures_one_replay_boundary_before_later_live_output() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let descriptor = service
            .spawn(shell_request(
                "stty -echo; read first; printf before-boundary; read second; printf after-boundary",
            ))
            .unwrap();
        let (probe_sender, probe_receiver) = mpsc::channel();
        let probe_sink: Arc<dyn TerminalEventSink> =
            Arc::new(move |_terminal_id: TerminalId, event: TerminalEvent| {
                probe_sender.send(event).map_err(|error| error.to_string())
            });
        let probe = service.attach(descriptor.id, probe_sink, false).unwrap();
        service.write(descriptor.id, b"one\n").unwrap();
        loop {
            if let TerminalEvent::Output { data, .. } = probe_receiver.recv().unwrap() {
                if String::from_utf8_lossy(&data).contains("before-boundary") {
                    break;
                }
            }
        }
        service.detach(probe.attachment_id).unwrap();

        let (live_sender, live_receiver) = mpsc::channel();
        let live_sink: Arc<dyn TerminalEventSink> =
            Arc::new(move |_terminal_id: TerminalId, event: TerminalEvent| {
                live_sender.send(event).map_err(|error| error.to_string())
            });
        let attached = service.attach(descriptor.id, live_sink, true).unwrap();
        let replay = String::from_utf8_lossy(&attached.snapshot.replay.bytes);
        assert!(replay.contains("before-boundary"));
        assert!(!replay.contains("after-boundary"));

        service.write(descriptor.id, b"two\n").unwrap();
        let mut live_output = String::new();
        loop {
            let event = live_receiver.recv().unwrap();
            assert!(event_sequence(&event) > attached.snapshot.sequence_boundary);
            match event {
                TerminalEvent::Output { data, .. } => {
                    live_output.push_str(&String::from_utf8_lossy(&data));
                }
                TerminalEvent::Exited { .. } => break,
                _ => {}
            }
        }
        assert!(!live_output.contains("before-boundary"));
        assert!(live_output.contains("after-boundary"));
        service.close(descriptor.id).unwrap();
    }

    /// Selecting is an operation a client reaches by terminal id.
    ///
    /// The runtime handle could already select; nothing keyed by terminal id
    /// could, so the operation stopped short of every client boundary. What the
    /// intent covers stays the host's — the text below is one word out of a
    /// line the client never scanned — and a terminal the service does not hold
    /// is an error rather than an empty selection.
    #[cfg(unix)]
    #[test]
    fn selection_is_reachable_by_terminal_id_and_answers_the_hosts_own_text() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let descriptor = service
            .spawn(shell_request(
                "stty -echo; printf 'alpha beta gamma\\r\\n'; while IFS= read -r line; do :; done",
            ))
            .unwrap();

        let row = loop {
            let projection = service.project(descriptor.id).unwrap();
            if let Some(row) = projection
                .viewport
                .iter()
                .position(|row| row.text().contains("alpha beta gamma"))
            {
                break u32::try_from(row).unwrap();
            }
            std::thread::yield_now();
        };

        let selected = service
            .select(
                descriptor.id,
                TerminalSelectionRequest::Word {
                    space: ProjectedSpace::Viewport,
                    at: ProjectedPoint { column: 0, row },
                },
            )
            .unwrap();
        assert!(selected.active);
        assert_eq!(
            selected.text.as_deref(),
            Some("alpha"),
            "where the word ends is the host's answer, not the client's"
        );

        let cleared = service
            .select(descriptor.id, TerminalSelectionRequest::Clear)
            .unwrap();
        assert!(!cleared.active && cleared.text.is_none());

        assert_eq!(
            service
                .select(TerminalId::new(), TerminalSelectionRequest::All)
                .unwrap_err()
                .code,
            TerminalErrorCode::NotFound
        );

        service.close(descriptor.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn renderer_restart_reattaches_the_same_module_terminal_without_killing_it() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let mut request = shell_request(
            r#"stty -echo; read first; printf '\033[31mphase-one\033[0m'; read second; printf phase-two"#,
        );
        request.metadata.owner = TerminalOwner::Module {
            module_id: "commands".to_string(),
            owner_key: "commands:invocation-one".to_string(),
            module_session_id: "commands:invocation-one".to_string(),
        };
        request.metadata.owner_metadata = Some(serde_json::json!({
            "projectPath": "/tmp",
            "commandName": "dev",
            "invocationId": "invocation-one"
        }));
        let descriptor = service.spawn(request).unwrap();

        let (first_sender, first_receiver) = mpsc::channel();
        let first_sink: Arc<dyn TerminalEventSink> =
            Arc::new(move |_terminal_id: TerminalId, event: TerminalEvent| {
                first_sender.send(event).map_err(|error| error.to_string())
            });
        let first = service.attach(descriptor.id, first_sink, true).unwrap();
        service.write(descriptor.id, b"one\n").unwrap();
        loop {
            if let TerminalEvent::Output { data, .. } = first_receiver.recv().unwrap() {
                if String::from_utf8_lossy(&data).contains("phase-one") {
                    break;
                }
            }
        }
        service.detach(first.attachment_id).unwrap();

        let rediscovered = service.get(descriptor.id).unwrap();
        assert_eq!(rediscovered.id, descriptor.id);
        assert_eq!(rediscovered.lifecycle, TerminalLifecycle::Running);
        assert!(matches!(
            rediscovered.metadata.owner,
            TerminalOwner::Module {
                ref module_id,
                ref module_session_id,
                ..
            } if module_id == "commands" && module_session_id == "commands:invocation-one"
        ));

        let (second_sender, second_receiver) = mpsc::channel();
        let second_sink: Arc<dyn TerminalEventSink> =
            Arc::new(move |_terminal_id: TerminalId, event: TerminalEvent| {
                second_sender.send(event).map_err(|error| error.to_string())
            });
        let second = service.attach(descriptor.id, second_sink, true).unwrap();
        assert_eq!(second.snapshot.descriptor.id, descriptor.id);
        assert!(String::from_utf8_lossy(&second.snapshot.replay.bytes).contains("phase-one"));

        service.write(descriptor.id, b"two\n").unwrap();
        loop {
            match second_receiver.recv().unwrap() {
                TerminalEvent::Output { data, .. }
                    if String::from_utf8_lossy(&data).contains("phase-two") => {}
                TerminalEvent::Exited { descriptor, .. } => {
                    assert_eq!(descriptor.id, rediscovered.id);
                    break;
                }
                _ => {}
            }
        }
        service.wait_for_exit(descriptor.id).unwrap();
        assert!(
            String::from_utf8_lossy(&service.snapshot(descriptor.id).unwrap().replay.bytes)
                .contains("phase-two")
        );
        service.close(descriptor.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn exited_terminal_attach_returns_final_read_only_replay() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let descriptor = service
            .spawn(shell_request("printf final-before-attach; exit 4"))
            .unwrap();
        service.wait_for_exit(descriptor.id).unwrap();
        let silent_sink: Arc<dyn TerminalEventSink> =
            Arc::new(|_terminal_id: TerminalId, _event: TerminalEvent| Ok(()));

        let attachment = service.attach(descriptor.id, silent_sink, true).unwrap();
        assert!(!attachment.live);
        assert_eq!(
            attachment.snapshot.descriptor.lifecycle,
            TerminalLifecycle::Exited
        );
        assert!(String::from_utf8_lossy(&attachment.snapshot.replay.bytes)
            .contains("final-before-attach"));
        assert_eq!(
            service
                .resize(descriptor.id, attachment.attachment_id, 90, 30)
                .unwrap_err()
                .code,
            TerminalErrorCode::Exited
        );
        assert!(service.detach(attachment.attachment_id).is_ok());
        service.close(descriptor.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn slow_attachment_overflows_without_blocking_fast_attachment_or_parser() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let descriptor = service
            .spawn(shell_request(
                "stty -echo; read go; head -c 200000 /dev/zero | tr '\\0' x; read finish",
            ))
            .unwrap();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let (slow_entered_sender, slow_entered_receiver) = mpsc::sync_channel(1);
        let (slow_event_sender, slow_event_receiver) = mpsc::channel();
        let slow_gate = Arc::clone(&gate);
        let slow_sink: Arc<dyn TerminalEventSink> =
            Arc::new(move |_terminal_id: TerminalId, event: TerminalEvent| {
                if matches!(event, TerminalEvent::Output { .. }) {
                    let _ = slow_entered_sender.try_send(());
                    let (released, ready) = &*slow_gate;
                    let mut released = released.lock().unwrap();
                    while !*released {
                        released = ready.wait(released).unwrap();
                    }
                }
                slow_event_sender
                    .send(event)
                    .map_err(|error| error.to_string())
            });
        let slow = service.attach(descriptor.id, slow_sink, false).unwrap();
        let (fast_sender, fast_receiver) = mpsc::channel();
        let fast_sink: Arc<dyn TerminalEventSink> =
            Arc::new(move |_terminal_id: TerminalId, event: TerminalEvent| {
                fast_sender.send(event).map_err(|error| error.to_string())
            });
        let fast = service.attach(descriptor.id, fast_sink, false).unwrap();

        service.write(descriptor.id, b"go\n").unwrap();
        slow_entered_receiver.recv().unwrap();
        let mut fast_bytes = 0usize;
        let mut previous_sequence = fast.snapshot.sequence_boundary;
        while fast_bytes < 200_000 {
            let event = fast_receiver.recv().unwrap();
            let sequence = event_sequence(&event);
            assert!(sequence > previous_sequence);
            previous_sequence = sequence;
            if let TerminalEvent::Output { data, .. } = event {
                fast_bytes += data.len();
            }
        }
        loop {
            if !service.attachments().contains_key(&slow.attachment_id) {
                break;
            }
            std::thread::yield_now();
        }
        assert!(service.attachments().contains_key(&fast.attachment_id));
        assert!(service.snapshot(descriptor.id).unwrap().sequence_boundary >= previous_sequence);

        let (released, ready) = &*gate;
        *released.lock().unwrap() = true;
        ready.notify_all();
        assert!(matches!(
            slow_event_receiver.recv().unwrap(),
            TerminalEvent::Output { .. }
        ));
        assert!(matches!(
            slow_event_receiver.recv().unwrap(),
            TerminalEvent::ResyncRequired { .. }
        ));
        service.write(descriptor.id, b"finish\n").unwrap();
        service.wait_for_exit(descriptor.id).unwrap();
        service.close(descriptor.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn newest_renderer_attachment_is_the_only_resize_authority() {
        let service = TerminalService::new("runtime-instance", TerminalRetentionPolicy::default());
        let descriptor = service.spawn(shell_request("cat")).unwrap();
        let sink: Arc<dyn TerminalEventSink> =
            Arc::new(|_terminal_id: TerminalId, _event: TerminalEvent| Ok(()));
        let first = service
            .attach(descriptor.id, Arc::clone(&sink), true)
            .unwrap();
        service
            .resize(descriptor.id, first.attachment_id, 100, 30)
            .unwrap();
        let second = service.attach(descriptor.id, sink, true).unwrap();

        assert_eq!(
            service
                .resize(descriptor.id, first.attachment_id, 110, 31)
                .unwrap_err()
                .code,
            TerminalErrorCode::InvalidRequest
        );
        service
            .resize(descriptor.id, second.attachment_id, 120, 32)
            .unwrap();
        let snapshot = service.snapshot(descriptor.id).unwrap();
        assert_eq!((snapshot.replay.columns, snapshot.replay.rows), (120, 32));
        service.detach(second.attachment_id).unwrap();
        assert_eq!(
            service
                .resize(descriptor.id, second.attachment_id, 130, 33)
                .unwrap_err()
                .code,
            TerminalErrorCode::InvalidRequest
        );
        service.close(descriptor.id).unwrap();
    }
}
