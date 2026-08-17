//! Host-owned terminal registry. Registry locks protect only lookup and
//! reservation; all PTY, wait, subscriber, and serialization work happens
//! after cloning a record handle and dropping the registry guard.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::{TerminalColorTheme, TerminalDriverDescriptor, TerminalDriverRegistry};

use super::record::TerminalRecord;
use super::retention::TerminalRetentionPolicy;
use super::runtime::{
    TerminalCloseTicket, TerminalEventSink, TerminalPublicationStats, TerminalRuntimeHandle,
};
use super::types::{
    TerminalAgentActivity, TerminalAgentReportRequest, TerminalAttachmentId, TerminalCloseResult,
    TerminalDescriptor, TerminalError, TerminalErrorCode, TerminalExitReason, TerminalId,
    TerminalLaunchRequest, TerminalMetadata, TerminalRawAttachment, TerminalRegistryEvent,
    TerminalRegistrySubscriptionId, TERMINAL_AGENT_REPORT_MAX_BYTES,
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
    /// Build composition supplies the complete registry. The actor resolves
    /// the selected native factory from it before it creates the PTY.
    driver_registry: Arc<TerminalDriverRegistry>,
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
        let mut registry = TerminalDriverRegistry::default();
        registry
            .register_browser_driver(TerminalDriverDescriptor {
                id: crate::terminal_host::types::default_terminal_driver_id(),
                native_interpretation: false,
            })
            .expect("the default terminal driver registers once");
        Self::with_driver_registry(instance_id, retention, registry)
    }

    /// Construct the terminal host from the build's installed drivers.
    pub fn with_driver_registry(
        instance_id: impl Into<String>,
        retention: TerminalRetentionPolicy,
        driver_registry: TerminalDriverRegistry,
    ) -> Self {
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
                driver_registry: Arc::new(driver_registry),
            }),
        }
    }

    pub fn spawn(
        &self,
        mut request: TerminalLaunchRequest,
    ) -> Result<TerminalDescriptor, TerminalError> {
        let registry = &self.inner.driver_registry;
        let descriptor = registry.descriptor(&request.driver_id).ok_or_else(|| {
            TerminalError::new(
                TerminalErrorCode::InvalidRequest,
                format!("Terminal driver {} is not installed", request.driver_id),
            )
        })?;
        let driver_factory = if descriptor.native_interpretation {
            Some(registry.resolve(&request.driver_id).ok_or_else(|| {
                TerminalError::new(
                    TerminalErrorCode::StartupFailed,
                    format!(
                        "Terminal driver {} has no native factory",
                        request.driver_id
                    ),
                )
            })?)
        } else {
            None
        };
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
            driver_factory,
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

    /// Route a module-owned request to the selected driver without decoding its
    /// payload in the host.
    pub fn request_driver(
        &self,
        id: TerminalId,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, TerminalError> {
        runtime(self.record(id)?.as_ref())?.request_driver(request)
    }

    /// Cumulative publication observations for one terminal runtime.
    pub fn publication_stats(
        &self,
        id: TerminalId,
    ) -> Result<TerminalPublicationStats, TerminalError> {
        runtime(self.record(id)?.as_ref())?.publication_stats()
    }

    /// Write exact bytes. Legacy: a client that decides its own bytes keeps a
    /// second copy of the child's modes, which is what [`Self::input`] exists
    /// to end.
    pub fn write(&self, id: TerminalId, data: &[u8]) -> Result<(), TerminalError> {
        runtime(self.record(id)?.as_ref())?.write(data.to_vec())
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

    /// Attach the host-owned, byte-preserving PTY stream.
    ///
    /// This is the generic terminal-host attachment. It does not construct a
    /// replay snapshot, and callers do not select or name a transport.
    pub fn attach_raw(
        &self,
        id: TerminalId,
        sink: Arc<dyn TerminalEventSink>,
        claims_resize: bool,
    ) -> Result<TerminalRawAttachment, TerminalError> {
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
        match runtime.attach_raw(attachment_id, sink, claims_resize, on_detached) {
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

    /// Attach the selected native driver's module-owned presentation stream.
    pub fn attach_driver(
        &self,
        id: TerminalId,
        sink: Arc<dyn super::runtime::TerminalDriverEventSink>,
        claims_resize: bool,
    ) -> Result<super::types::TerminalDriverAttachment, TerminalError> {
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
        match runtime.attach_driver(attachment_id, sink, claims_resize, on_detached) {
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

    /// Grant one more selected-driver presentation event after the client
    /// commits the event at `committed_sequence`.
    pub fn credit_driver_presentation(
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
        runtime(self.record(id)?.as_ref())?
            .credit_driver_presentation(attachment_id, committed_sequence)
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
