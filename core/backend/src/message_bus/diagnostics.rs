//! Stable machine-readable message-bus failure codes.

pub const SCHEMA_VERSION_UNSUPPORTED: &str = "message.contract.schema_version_unsupported";
pub const UNKNOWN_FIELD: &str = "message.contract.unknown_field";
pub const INVALID_JSON: &str = "message.contract.invalid_json";
pub const INVALID_IDENTIFIER: &str = "message.contract.identifier.invalid";
pub const INVALID_SCHEMA: &str = "message.contract.schema.invalid";
pub const SCHEMA_REFERENCE_FORBIDDEN: &str = "message.contract.schema.reference_forbidden";
pub const BOUND_REQUIRED: &str = "message.contract.bound.required";
pub const UNKNOWN_MESSAGE_CONTRACT: &str = "message.contract.unknown";
pub const INCOMPATIBLE_MESSAGE_VERSION: &str = "message.contract.version.incompatible";
pub const INVALID_PAYLOAD: &str = "message.payload.invalid";
pub const PAYLOAD_TOO_LARGE: &str = "message.payload.too_large";
pub const UNAUTHORIZED_SENDER: &str = "message.sender.unauthorized";
pub const NO_ACTIVE_CHANNEL_OWNER: &str = "message.channel.owner.absent";
pub const DUPLICATE_CHANNEL_OWNER: &str = "message.channel.owner.duplicate";
pub const SUBSCRIBER_LAG: &str = "message.topic.subscriber.lag";
pub const HANDLER_UNAVAILABLE: &str = "message.handler.unavailable";
pub const HANDLER_FAILED: &str = "message.handler.failed";
pub const ROUTE_GENERATION_CHANGED: &str = "message.route.generation_changed";
pub const BRIDGE_CLOSED: &str = "message.bridge.closed";
pub const SECRET_LEAKAGE: &str = "message.diagnostic.secret_leakage";
pub const DRAIN_BLOCKED: &str = "message.activation.drain_blocked";
pub const MODULE_JOIN_UNAVAILABLE: &str = "message.runtime.module_join_unavailable";
pub const RUNTIME_INSPECTED: &str = "message.runtime.inspected";
pub const RUNTIME_HEALTHY: &str = "message.runtime.healthy";
pub const RUNTIME_DIAGNOSTICS_FAILED: &str = "message.runtime.diagnostics_failed";
pub const RUNTIME_UNAVAILABLE: &str = "message.runtime.unavailable";

pub const PUBLIC_CODES: &[&str] = &[
    SCHEMA_VERSION_UNSUPPORTED,
    UNKNOWN_FIELD,
    INVALID_JSON,
    INVALID_IDENTIFIER,
    INVALID_SCHEMA,
    SCHEMA_REFERENCE_FORBIDDEN,
    BOUND_REQUIRED,
    UNKNOWN_MESSAGE_CONTRACT,
    INCOMPATIBLE_MESSAGE_VERSION,
    INVALID_PAYLOAD,
    PAYLOAD_TOO_LARGE,
    UNAUTHORIZED_SENDER,
    NO_ACTIVE_CHANNEL_OWNER,
    DUPLICATE_CHANNEL_OWNER,
    SUBSCRIBER_LAG,
    HANDLER_UNAVAILABLE,
    HANDLER_FAILED,
    ROUTE_GENERATION_CHANGED,
    BRIDGE_CLOSED,
    SECRET_LEAKAGE,
    DRAIN_BLOCKED,
    MODULE_JOIN_UNAVAILABLE,
    RUNTIME_INSPECTED,
    RUNTIME_HEALTHY,
    RUNTIME_DIAGNOSTICS_FAILED,
    RUNTIME_UNAVAILABLE,
];

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    #[test]
    fn message_bus_public_codes_are_unique_and_machine_safe() {
        let codes = super::PUBLIC_CODES.iter().copied().collect::<BTreeSet<_>>();
        assert_eq!(codes.len(), super::PUBLIC_CODES.len());
        assert!(codes.iter().all(|code| {
            code.starts_with("message.")
                && code
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || "._".contains(character))
        }));
    }
}
