//! Activation-scoped native authority for semantic terminal operations.

use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};

use crate::terminal_host::{
    TerminalAttachmentId, TerminalDriverEventSink, TerminalDriverId, TerminalError,
    TerminalErrorCode, TerminalId, TerminalService,
};

use super::input;

pub const SEMANTIC_TERMINALS_INVALID_REQUEST: &str = "semantic-terminals.request.invalid";
pub const SEMANTIC_TERMINALS_ACTIVATION_DISPOSED: &str = "semantic-terminals.activation.disposed";
pub const SEMANTIC_TERMINALS_DENIED: &str = "semantic-terminals.activation.denied";
pub const SEMANTIC_TERMINALS_NOT_FOUND: &str = "semantic-terminals.terminal.not-found";
pub const SEMANTIC_TERMINALS_UNAVAILABLE: &str = "semantic-terminals.terminal.unavailable";
pub const SEMANTIC_TERMINALS_TRANSPORT_FAILED: &str = "semantic-terminals.transport.failed";
pub const SEMANTIC_TERMINALS_PROTOCOL_FAILED: &str = "semantic-terminals.protocol.failed";

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticTerminalActor {
    pub module_id: String,
    pub activation_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticTerminalError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl SemanticTerminalError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: false,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(SEMANTIC_TERMINALS_INVALID_REQUEST, message)
    }

    fn denied(message: impl Into<String>) -> Self {
        Self::new(SEMANTIC_TERMINALS_DENIED, message)
    }
}

impl From<TerminalError> for SemanticTerminalError {
    fn from(error: TerminalError) -> Self {
        let code = match error.code {
            TerminalErrorCode::NotFound => SEMANTIC_TERMINALS_NOT_FOUND,
            TerminalErrorCode::Exited
            | TerminalErrorCode::Closing
            | TerminalErrorCode::ShuttingDown
            | TerminalErrorCode::RuntimeStopped => SEMANTIC_TERMINALS_UNAVAILABLE,
            TerminalErrorCode::InvalidRequest => SEMANTIC_TERMINALS_INVALID_REQUEST,
            TerminalErrorCode::StartupFailed | TerminalErrorCode::Io => {
                SEMANTIC_TERMINALS_TRANSPORT_FAILED
            }
        };
        Self::new(code, error.message)
    }
}

/// One semantic event sink. The Tauri adapter supplies a channel-backed sink.
pub type SemanticTerminalEventSink = Arc<dyn Fn(JsonValue) -> Result<(), String> + Send + Sync>;

/// Native terminal operations required by the semantic provider.
///
/// This fixed interface prevents the provider from gaining general PTY or
/// process authority. A terminal's selected driver, rather than its lifecycle
/// owner, gates semantic presentation access. Tests replace it with an
/// in-memory authority model.
pub trait SemanticTerminalAuthority: Send + Sync {
    fn driver_id(&self, terminal_id: TerminalId) -> Result<TerminalDriverId, TerminalError>;
    fn request(
        &self,
        terminal_id: TerminalId,
        request: JsonValue,
    ) -> Result<JsonValue, TerminalError>;
    fn attach(
        &self,
        terminal_id: TerminalId,
        claims_resize: bool,
        on_event: SemanticTerminalEventSink,
    ) -> Result<JsonValue, TerminalError>;
    fn detach(&self, attachment_id: TerminalAttachmentId) -> Result<(), TerminalError>;
    fn credit_screen(
        &self,
        attachment_id: TerminalAttachmentId,
        committed_sequence: u64,
    ) -> Result<(), TerminalError>;
    fn resize(
        &self,
        terminal_id: TerminalId,
        attachment_id: TerminalAttachmentId,
        columns: u16,
        rows: u16,
    ) -> Result<(), TerminalError>;
    fn publication_stats(&self, terminal_id: TerminalId) -> Result<JsonValue, TerminalError>;
    fn app_memory(&self) -> JsonValue;
}

struct TerminalServiceAuthority {
    terminals: TerminalService,
}

impl TerminalServiceAuthority {
    fn encode(value: impl Serialize) -> Result<JsonValue, TerminalError> {
        serde_json::to_value(value).map_err(|error| {
            TerminalError::new(
                TerminalErrorCode::Io,
                format!("Could not encode semantic terminal response: {error}"),
            )
        })
    }

    fn app_rss() -> u64 {
        Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(|kilobytes| kilobytes * 1024)
            .unwrap_or(0)
    }
}

impl SemanticTerminalAuthority for TerminalServiceAuthority {
    fn driver_id(&self, terminal_id: TerminalId) -> Result<TerminalDriverId, TerminalError> {
        Ok(self.terminals.get(terminal_id)?.driver_id)
    }

    fn request(
        &self,
        terminal_id: TerminalId,
        request: JsonValue,
    ) -> Result<JsonValue, TerminalError> {
        self.terminals.request_driver(terminal_id, request)
    }

    fn attach(
        &self,
        terminal_id: TerminalId,
        claims_resize: bool,
        on_event: SemanticTerminalEventSink,
    ) -> Result<JsonValue, TerminalError> {
        let sink: Arc<dyn TerminalDriverEventSink> =
            Arc::new(move |_terminal_id, event| on_event(event));
        Self::encode(
            self.terminals
                .attach_driver(terminal_id, sink, claims_resize)?,
        )
    }

    fn detach(&self, attachment_id: TerminalAttachmentId) -> Result<(), TerminalError> {
        self.terminals.detach(attachment_id)
    }

    fn credit_screen(
        &self,
        attachment_id: TerminalAttachmentId,
        committed_sequence: u64,
    ) -> Result<(), TerminalError> {
        self.terminals
            .credit_driver_presentation(attachment_id, committed_sequence)
    }

    fn resize(
        &self,
        terminal_id: TerminalId,
        attachment_id: TerminalAttachmentId,
        columns: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        self.terminals
            .resize(terminal_id, attachment_id, columns, rows)
    }

    fn publication_stats(&self, terminal_id: TerminalId) -> Result<JsonValue, TerminalError> {
        Self::encode(self.terminals.publication_stats(terminal_id)?)
    }

    fn app_memory(&self) -> JsonValue {
        json!({ "appRss": Self::app_rss() })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SemanticTerminalGrant {
    Attach,
    Input,
    Inspect,
}

#[derive(Clone, Debug)]
struct SemanticTerminalPolicy {
    module_id: &'static str,
    grants: &'static [SemanticTerminalGrant],
}

const ALL_GRANTS: &[SemanticTerminalGrant] = &[
    SemanticTerminalGrant::Attach,
    SemanticTerminalGrant::Input,
    SemanticTerminalGrant::Inspect,
];
const DEFAULT_POLICIES: &[SemanticTerminalPolicy] = &[SemanticTerminalPolicy {
    module_id: "shipctl.semantic-terminal",
    grants: ALL_GRANTS,
}];

#[derive(Clone, Debug)]
struct AttachmentLease {
    actor: SemanticTerminalActor,
    terminal_id: TerminalId,
    claims_resize: bool,
}

#[derive(Default)]
struct SemanticTerminalState {
    attachments: HashMap<TerminalAttachmentId, AttachmentLease>,
    released_activations: HashSet<String>,
}

struct SemanticTerminalServiceInner {
    authority: Arc<dyn SemanticTerminalAuthority>,
    policies: Vec<SemanticTerminalPolicy>,
    state: Mutex<SemanticTerminalState>,
}

/// Permanent semantic terminal provider.
///
/// It owns parser state through the registered native driver and verifies all
/// native requests against module, activation, terminal, and attachment scope.
#[derive(Clone)]
pub struct SemanticTerminalService {
    inner: Arc<SemanticTerminalServiceInner>,
}

impl SemanticTerminalService {
    pub fn terminal_host(terminals: TerminalService) -> Self {
        Self::with_authority(Arc::new(TerminalServiceAuthority { terminals }))
    }

    pub fn with_authority(authority: Arc<dyn SemanticTerminalAuthority>) -> Self {
        Self::with_policies(authority, DEFAULT_POLICIES.to_vec())
    }

    fn with_policies(
        authority: Arc<dyn SemanticTerminalAuthority>,
        policies: Vec<SemanticTerminalPolicy>,
    ) -> Self {
        Self {
            inner: Arc::new(SemanticTerminalServiceInner {
                authority,
                policies,
                state: Mutex::new(SemanticTerminalState::default()),
            }),
        }
    }

    pub fn snapshot(
        &self,
        actor: &SemanticTerminalActor,
        terminal_id: &str,
    ) -> Result<JsonValue, SemanticTerminalError> {
        let terminal_id =
            self.authorized_terminal(actor, SemanticTerminalGrant::Inspect, terminal_id)?;
        self.request(
            terminal_id,
            json!({ "operation": "snapshot", "baseline": true }),
        )
    }

    pub fn attach(
        &self,
        actor: &SemanticTerminalActor,
        terminal_id: &str,
        claims_resize: bool,
        on_event: SemanticTerminalEventSink,
    ) -> Result<JsonValue, SemanticTerminalError> {
        let terminal_id =
            self.authorized_terminal(actor, SemanticTerminalGrant::Attach, terminal_id)?;
        let attachment = self
            .inner
            .authority
            .attach(terminal_id, claims_resize, on_event)
            .map_err(SemanticTerminalError::from)?;
        let attachment_id = attachment
            .get("attachmentId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| {
                SemanticTerminalError::new(
                    SEMANTIC_TERMINALS_PROTOCOL_FAILED,
                    "The terminal host returned no semantic attachment identity",
                )
            })
            .and_then(parse_attachment_id)?;
        let live = attachment
            .get("live")
            .and_then(JsonValue::as_bool)
            .ok_or_else(|| {
                let _ = self.inner.authority.detach(attachment_id);
                SemanticTerminalError::new(
                    SEMANTIC_TERMINALS_PROTOCOL_FAILED,
                    "The terminal host returned no semantic attachment liveness",
                )
            })?;
        if live {
            self.state().attachments.insert(
                attachment_id,
                AttachmentLease {
                    actor: actor.clone(),
                    terminal_id,
                    claims_resize,
                },
            );
        }
        Ok(attachment)
    }

    pub fn credit_screen(
        &self,
        actor: &SemanticTerminalActor,
        attachment_id: &str,
        committed_sequence: u64,
    ) -> Result<(), SemanticTerminalError> {
        self.authorize(actor, SemanticTerminalGrant::Attach)?;
        let attachment_id = parse_attachment_id(attachment_id)?;
        self.owned_attachment(actor, attachment_id)?;
        self.inner
            .authority
            .credit_screen(attachment_id, committed_sequence)
            .map_err(SemanticTerminalError::from)
    }

    pub fn detach(
        &self,
        actor: &SemanticTerminalActor,
        attachment_id: &str,
    ) -> Result<(), SemanticTerminalError> {
        self.authorize(actor, SemanticTerminalGrant::Attach)?;
        let attachment_id = parse_attachment_id(attachment_id)?;
        self.owned_attachment(actor, attachment_id)?;
        self.inner
            .authority
            .detach(attachment_id)
            .map_err(SemanticTerminalError::from)?;
        self.state().attachments.remove(&attachment_id);
        Ok(())
    }

    pub fn resize(
        &self,
        actor: &SemanticTerminalActor,
        terminal_id: &str,
        attachment_id: &str,
        columns: u16,
        rows: u16,
    ) -> Result<(), SemanticTerminalError> {
        self.authorize(actor, SemanticTerminalGrant::Attach)?;
        if columns == 0 || rows == 0 {
            return Err(SemanticTerminalError::invalid(
                "Semantic terminal dimensions must be positive",
            ));
        }
        let terminal_id = parse_terminal_id(terminal_id)?;
        let attachment_id = parse_attachment_id(attachment_id)?;
        let lease = self.owned_attachment(actor, attachment_id)?;
        if lease.terminal_id != terminal_id || !lease.claims_resize {
            return Err(SemanticTerminalError::denied(
                "The activation does not own semantic terminal resize authority",
            ));
        }
        self.inner
            .authority
            .resize(terminal_id, attachment_id, columns, rows)
            .map_err(SemanticTerminalError::from)
    }

    pub fn input(
        &self,
        actor: &SemanticTerminalActor,
        terminal_id: &str,
        input: JsonValue,
    ) -> Result<JsonValue, SemanticTerminalError> {
        let terminal_id =
            self.authorized_terminal(actor, SemanticTerminalGrant::Input, terminal_id)?;
        if !self
            .state()
            .attachments
            .values()
            .any(|lease| lease.actor == *actor && lease.terminal_id == terminal_id)
        {
            return Err(SemanticTerminalError::denied(
                "The activation has no semantic attachment for this terminal",
            ));
        }
        self.request(terminal_id, json!({ "operation": "input", "input": input }))
    }

    pub fn history(
        &self,
        actor: &SemanticTerminalActor,
        terminal_id: &str,
        start_row: u32,
        rows: u32,
    ) -> Result<JsonValue, SemanticTerminalError> {
        let terminal_id =
            self.authorized_terminal(actor, SemanticTerminalGrant::Attach, terminal_id)?;
        self.request(
            terminal_id,
            json!({ "operation": "history", "start_row": start_row, "rows": rows }),
        )
    }

    pub fn anchor(
        &self,
        actor: &SemanticTerminalActor,
        terminal_id: &str,
        space: JsonValue,
        at: JsonValue,
    ) -> Result<JsonValue, SemanticTerminalError> {
        let terminal_id =
            self.authorized_terminal(actor, SemanticTerminalGrant::Attach, terminal_id)?;
        self.request(
            terminal_id,
            json!({ "operation": "anchor", "space": space, "at": at }),
        )
    }

    pub fn resolve_anchor(
        &self,
        actor: &SemanticTerminalActor,
        terminal_id: &str,
        anchor: JsonValue,
    ) -> Result<JsonValue, SemanticTerminalError> {
        let terminal_id =
            self.authorized_terminal(actor, SemanticTerminalGrant::Attach, terminal_id)?;
        self.request(
            terminal_id,
            json!({ "operation": "resolve_anchor", "id": anchor }),
        )
    }

    pub fn release_anchor(
        &self,
        actor: &SemanticTerminalActor,
        terminal_id: &str,
        anchor: JsonValue,
    ) -> Result<JsonValue, SemanticTerminalError> {
        let terminal_id =
            self.authorized_terminal(actor, SemanticTerminalGrant::Attach, terminal_id)?;
        self.request(
            terminal_id,
            json!({ "operation": "release_anchor", "id": anchor }),
        )
    }

    pub fn select(
        &self,
        actor: &SemanticTerminalActor,
        terminal_id: &str,
        request: JsonValue,
    ) -> Result<JsonValue, SemanticTerminalError> {
        let terminal_id =
            self.authorized_terminal(actor, SemanticTerminalGrant::Attach, terminal_id)?;
        self.request(
            terminal_id,
            json!({ "operation": "select", "request": request }),
        )
    }

    pub fn inspect_paste(
        &self,
        actor: &SemanticTerminalActor,
        text: &str,
    ) -> Result<bool, SemanticTerminalError> {
        self.authorize(actor, SemanticTerminalGrant::Input)?;
        Ok(input::paste_is_safe(text))
    }

    pub fn publication_stats(
        &self,
        actor: &SemanticTerminalActor,
        terminal_id: &str,
    ) -> Result<JsonValue, SemanticTerminalError> {
        let terminal_id =
            self.authorized_terminal(actor, SemanticTerminalGrant::Inspect, terminal_id)?;
        self.inner
            .authority
            .publication_stats(terminal_id)
            .map_err(SemanticTerminalError::from)
    }

    pub fn app_memory(
        &self,
        actor: &SemanticTerminalActor,
    ) -> Result<JsonValue, SemanticTerminalError> {
        self.authorize(actor, SemanticTerminalGrant::Inspect)?;
        Ok(self.inner.authority.app_memory())
    }

    pub fn release_activation(
        &self,
        actor: &SemanticTerminalActor,
    ) -> Result<usize, SemanticTerminalError> {
        let attachment_ids = {
            let mut state = self.state();
            state
                .released_activations
                .insert(actor.activation_id.clone());
            let attachment_ids = state
                .attachments
                .iter()
                .filter_map(|(attachment_id, lease)| {
                    (lease.actor == *actor).then_some(*attachment_id)
                })
                .collect::<Vec<_>>();
            attachment_ids
        };
        let mut detached_count = 0;
        let mut first_error = None;
        for attachment_id in &attachment_ids {
            match self.inner.authority.detach(*attachment_id) {
                Ok(()) => {
                    self.state().attachments.remove(attachment_id);
                    detached_count += 1;
                }
                Err(error) if first_error.is_none() => {
                    first_error = Some(SemanticTerminalError::from(error));
                }
                Err(_) => {}
            }
        }
        if let Some(error) = first_error {
            self.state()
                .released_activations
                .remove(&actor.activation_id);
            return Err(error);
        }
        Ok(detached_count)
    }

    fn request(
        &self,
        terminal_id: TerminalId,
        request: JsonValue,
    ) -> Result<JsonValue, SemanticTerminalError> {
        self.inner
            .authority
            .request(terminal_id, request)
            .map_err(SemanticTerminalError::from)
    }

    fn authorized_terminal(
        &self,
        actor: &SemanticTerminalActor,
        grant: SemanticTerminalGrant,
        terminal_id: &str,
    ) -> Result<TerminalId, SemanticTerminalError> {
        self.authorize(actor, grant)?;
        let terminal_id = parse_terminal_id(terminal_id)?;
        let driver_id = self
            .inner
            .authority
            .driver_id(terminal_id)
            .map_err(SemanticTerminalError::from)?;
        if driver_id != super::driver_id() {
            return Err(SemanticTerminalError::denied(
                "The terminal does not use the semantic terminal driver",
            ));
        }
        Ok(terminal_id)
    }

    fn authorize(
        &self,
        actor: &SemanticTerminalActor,
        grant: SemanticTerminalGrant,
    ) -> Result<(), SemanticTerminalError> {
        if actor.module_id.trim().is_empty() || actor.activation_id.trim().is_empty() {
            return Err(SemanticTerminalError::invalid(
                "The semantic terminal actor identity is invalid",
            ));
        }
        if self
            .state()
            .released_activations
            .contains(&actor.activation_id)
        {
            return Err(SemanticTerminalError::new(
                SEMANTIC_TERMINALS_ACTIVATION_DISPOSED,
                "The semantic terminal activation was released",
            ));
        }
        let allowed =
            self.inner.policies.iter().any(|policy| {
                policy.module_id == actor.module_id && policy.grants.contains(&grant)
            });
        if !allowed {
            return Err(SemanticTerminalError::denied(
                "The semantic terminal operation was denied",
            ));
        }
        Ok(())
    }

    fn owned_attachment(
        &self,
        actor: &SemanticTerminalActor,
        attachment_id: TerminalAttachmentId,
    ) -> Result<AttachmentLease, SemanticTerminalError> {
        self.state()
            .attachments
            .get(&attachment_id)
            .filter(|lease| lease.actor == *actor)
            .cloned()
            .ok_or_else(|| {
                SemanticTerminalError::denied(
                    "The activation does not own this semantic terminal attachment",
                )
            })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, SemanticTerminalState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

fn parse_terminal_id(value: &str) -> Result<TerminalId, SemanticTerminalError> {
    TerminalId::from_str(value)
        .map_err(|_| SemanticTerminalError::invalid("The semantic terminal identity is invalid"))
}

fn parse_attachment_id(value: &str) -> Result<TerminalAttachmentId, SemanticTerminalError> {
    serde_json::from_value(JsonValue::String(value.to_string())).map_err(|_| {
        SemanticTerminalError::invalid("The semantic terminal attachment identity is invalid")
    })
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicUsize, Ordering};

    use proptest::prelude::*;

    use super::*;

    #[derive(Default)]
    struct ModelAuthority {
        drivers: Mutex<HashMap<TerminalId, TerminalDriverId>>,
        lifecycle_owners: Mutex<HashMap<TerminalId, String>>,
        detached: Mutex<Vec<TerminalAttachmentId>>,
        fail_detach_once: Mutex<HashSet<TerminalAttachmentId>>,
        next_attachment: AtomicUsize,
        terminal_count: AtomicUsize,
    }

    impl ModelAuthority {
        fn register(&self, terminal_id: TerminalId, driver_id: TerminalDriverId) {
            self.register_with_owner(terminal_id, driver_id, "shipctl.semantic-terminal");
        }

        fn register_with_owner(
            &self,
            terminal_id: TerminalId,
            driver_id: TerminalDriverId,
            lifecycle_owner: &str,
        ) {
            self.drivers().insert(terminal_id, driver_id);
            self.lifecycle_owners()
                .insert(terminal_id, lifecycle_owner.to_string());
            self.terminal_count.fetch_add(1, Ordering::Relaxed);
        }

        fn drivers(&self) -> std::sync::MutexGuard<'_, HashMap<TerminalId, TerminalDriverId>> {
            self.drivers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
        }

        fn lifecycle_owners(&self) -> std::sync::MutexGuard<'_, HashMap<TerminalId, String>> {
            self.lifecycle_owners
                .lock()
                .unwrap_or_else(|error| error.into_inner())
        }

        fn fail_detach_once(&self, attachment_id: TerminalAttachmentId) {
            self.fail_detach_once
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(attachment_id);
        }
    }

    impl SemanticTerminalAuthority for ModelAuthority {
        fn driver_id(&self, terminal_id: TerminalId) -> Result<TerminalDriverId, TerminalError> {
            self.drivers().get(&terminal_id).cloned().ok_or_else(|| {
                TerminalError::new(
                    TerminalErrorCode::NotFound,
                    "generated terminal is unavailable",
                )
            })
        }

        fn request(
            &self,
            _terminal_id: TerminalId,
            request: JsonValue,
        ) -> Result<JsonValue, TerminalError> {
            Ok(request)
        }

        fn attach(
            &self,
            _terminal_id: TerminalId,
            _claims_resize: bool,
            _on_event: SemanticTerminalEventSink,
        ) -> Result<JsonValue, TerminalError> {
            let _ordinal = self.next_attachment.fetch_add(1, Ordering::Relaxed);
            Ok(json!({
                "attachmentId": TerminalAttachmentId::new(),
                "live": true,
                "descriptor": { "revision": 1 },
                "sequenceBoundary": 0,
                "snapshot": {},
            }))
        }

        fn detach(&self, attachment_id: TerminalAttachmentId) -> Result<(), TerminalError> {
            if self
                .fail_detach_once
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&attachment_id)
            {
                return Err(TerminalError::new(
                    TerminalErrorCode::Io,
                    "generated detach failure",
                ));
            }
            self.detached
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(attachment_id);
            Ok(())
        }

        fn credit_screen(
            &self,
            _attachment_id: TerminalAttachmentId,
            _committed_sequence: u64,
        ) -> Result<(), TerminalError> {
            Ok(())
        }

        fn resize(
            &self,
            _terminal_id: TerminalId,
            _attachment_id: TerminalAttachmentId,
            _columns: u16,
            _rows: u16,
        ) -> Result<(), TerminalError> {
            Ok(())
        }

        fn publication_stats(&self, _terminal_id: TerminalId) -> Result<JsonValue, TerminalError> {
            Ok(json!({ "screenEvents": 0 }))
        }

        fn app_memory(&self) -> JsonValue {
            json!({ "appRss": 0 })
        }
    }

    fn actor(module_id: &str, activation_id: &str) -> SemanticTerminalActor {
        SemanticTerminalActor {
            module_id: module_id.to_string(),
            activation_id: activation_id.to_string(),
        }
    }

    fn sink() -> SemanticTerminalEventSink {
        Arc::new(|_| Ok(()))
    }

    proptest! {
        #[test]
        fn architecture_provider_semantic_terminal_parity_property(text in ".{0,128}") {
            let authority = Arc::new(ModelAuthority::default());
            let terminal_id = TerminalId::new();
            authority.register(terminal_id, crate::semantic_terminal::driver_id());
            let service = SemanticTerminalService::with_authority(authority.clone());
            let actor = actor("shipctl.semantic-terminal", "activation-parity");
            service.attach(&actor, &terminal_id.to_string(), false, sink()).unwrap();

            let input = json!({ "kind": "text", "text": text });
            let legacy = authority.request(
                terminal_id,
                json!({ "operation": "input", "input": input.clone() }),
            ).unwrap();
            let extracted = service.input(&actor, &terminal_id.to_string(), input).unwrap();
            prop_assert_eq!(extracted, legacy);
        }

        #[test]
        fn architecture_provider_semantic_terminal_authority_property(
            admitted in any::<bool>(),
            uses_semantic_driver in any::<bool>(),
            released in any::<bool>(),
            lifecycle_owner in (prop_oneof![
                Just("shipctl.semantic-terminal"),
                Just("shipctl.assistants"),
            ]),
        ) {
            const INSPECT: &[SemanticTerminalGrant] = &[SemanticTerminalGrant::Inspect];
            const NONE: &[SemanticTerminalGrant] = &[];
            let authority = Arc::new(ModelAuthority::default());
            let terminal_id = TerminalId::new();
            authority.register_with_owner(
                terminal_id,
                if uses_semantic_driver {
                    crate::semantic_terminal::driver_id()
                } else {
                    TerminalDriverId::new("thin-terminal").unwrap()
                },
                lifecycle_owner,
            );
            let policies = vec![SemanticTerminalPolicy {
                module_id: "candidate",
                grants: if admitted { INSPECT } else { NONE },
            }];
            let service = SemanticTerminalService::with_policies(authority, policies);
            let actor = actor("candidate", "activation-authority");
            if released {
                service.release_activation(&actor).unwrap();
            }

            let result = service.snapshot(&actor, &terminal_id.to_string());
            prop_assert_eq!(result.is_ok(), admitted && uses_semantic_driver && !released);
        }

        #[test]
        fn architecture_provider_semantic_terminal_ownership_property(
            attachment_count in 0usize..12,
            failure_ordinal in prop::option::of(0usize..12),
        ) {
            let authority = Arc::new(ModelAuthority::default());
            let terminal_id = TerminalId::new();
            authority.register(terminal_id, crate::semantic_terminal::driver_id());
            let service = SemanticTerminalService::with_authority(authority.clone());
            let actor = actor("shipctl.semantic-terminal", "activation-owner");
            let mut attachment_ids = Vec::new();
            for _ in 0..attachment_count {
                let attachment = service
                    .attach(&actor, &terminal_id.to_string(), false, sink())
                    .unwrap();
                attachment_ids.push(
                    parse_attachment_id(attachment["attachmentId"].as_str().unwrap()).unwrap(),
                );
            }
            let terminal_count = authority.terminal_count.load(Ordering::Relaxed);

            if let Some(failure_ordinal) = failure_ordinal.filter(|ordinal| *ordinal < attachment_count) {
                authority.fail_detach_once(attachment_ids[failure_ordinal]);
                prop_assert_eq!(
                    service.release_activation(&actor).unwrap_err().code,
                    SEMANTIC_TERMINALS_TRANSPORT_FAILED,
                );
                prop_assert_eq!(
                    authority.detached.lock().unwrap_or_else(|error| error.into_inner()).len(),
                    attachment_count - 1,
                );
                prop_assert!(service.snapshot(&actor, &terminal_id.to_string()).is_ok());
                prop_assert_eq!(service.release_activation(&actor).unwrap(), 1);
            } else {
                prop_assert_eq!(service.release_activation(&actor).unwrap(), attachment_count);
            }

            prop_assert_eq!(
                authority.detached.lock().unwrap_or_else(|error| error.into_inner()).len(),
                attachment_count,
            );
            prop_assert_eq!(authority.terminal_count.load(Ordering::Relaxed), terminal_count);
            prop_assert_eq!(
                service.snapshot(&actor, &terminal_id.to_string()).unwrap_err().code,
                SEMANTIC_TERMINALS_ACTIVATION_DISPOSED,
            );
        }
    }

    #[test]
    fn semantic_driver_authorizes_an_assistant_owned_terminal() {
        let authority = Arc::new(ModelAuthority::default());
        let terminal_id = TerminalId::new();
        authority.register_with_owner(
            terminal_id,
            crate::semantic_terminal::driver_id(),
            "shipctl.assistants",
        );
        assert_eq!(
            authority
                .lifecycle_owners()
                .get(&terminal_id)
                .map(String::as_str),
            Some("shipctl.assistants"),
        );

        let service = SemanticTerminalService::with_authority(authority);
        let actor = actor("shipctl.semantic-terminal", "activation-assistant-owned");
        assert!(service
            .attach(&actor, &terminal_id.to_string(), false, sink())
            .is_ok());
    }
}
