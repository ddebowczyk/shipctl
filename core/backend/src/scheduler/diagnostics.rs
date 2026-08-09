//! Stable scheduler diagnostics safe to render for humans and agents.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const SOURCE_PATH_UNSAFE: &str = "scheduler.source.path_unsafe";
pub const SOURCE_NOT_REGULAR: &str = "scheduler.source.not_regular";
pub const SOURCE_UNKNOWN_FIELD: &str = "scheduler.source.unknown_field";
pub const SOURCE_INVALID: &str = "scheduler.source.invalid";
pub const SCHEMA_VERSION_UNSUPPORTED: &str = "scheduler.source.schema_version_unsupported";
pub const IDENTIFIER_INVALID: &str = "scheduler.definition.identifier_invalid";
pub const CRON_TIMEZONE_REQUIRED: &str = "scheduler.definition.cron_timezone_required";
pub const CRON_INVALID: &str = "scheduler.definition.cron_invalid";
pub const NEXT_OCCURRENCE_UNAVAILABLE: &str = "scheduler.definition.next_occurrence_unavailable";
pub const SCHEDULE_DISABLED: &str = "scheduler.definition.disabled";
pub const SCHEDULE_NOT_FOUND: &str = "scheduler.definition.not_found";
pub const DUPLICATE_ID: &str = "scheduler.snapshot.duplicate_id";
pub const TARGET_UNAVAILABLE: &str = "scheduler.target.unavailable";
pub const TARGET_MESSAGE_INCOMPATIBLE: &str = "scheduler.target.message_incompatible";
pub const TARGET_UNAUTHORIZED: &str = "scheduler.target.unauthorized";
pub const PAYLOAD_INVALID: &str = "scheduler.message.payload_invalid";
pub const PAYLOAD_TOO_LARGE: &str = "scheduler.message.payload_too_large";
pub const SECRET_PAYLOAD_FORBIDDEN: &str = "scheduler.message.secret_payload_forbidden";
pub const DIAGNOSTIC_SECRET_LEAKAGE: &str = "scheduler.diagnostic.secret_leakage";

pub const PUBLIC_CODES: &[&str] = &[
    SOURCE_PATH_UNSAFE,
    SOURCE_NOT_REGULAR,
    SOURCE_UNKNOWN_FIELD,
    SOURCE_INVALID,
    SCHEMA_VERSION_UNSUPPORTED,
    IDENTIFIER_INVALID,
    CRON_TIMEZONE_REQUIRED,
    CRON_INVALID,
    NEXT_OCCURRENCE_UNAVAILABLE,
    SCHEDULE_DISABLED,
    SCHEDULE_NOT_FOUND,
    DUPLICATE_ID,
    TARGET_UNAVAILABLE,
    TARGET_MESSAGE_INCOMPATIBLE,
    TARGET_UNAUTHORIZED,
    PAYLOAD_INVALID,
    PAYLOAD_TOO_LARGE,
    SECRET_PAYLOAD_FORBIDDEN,
    DIAGNOSTIC_SECRET_LEAKAGE,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleDiagnosticSeverity {
    Error,
    Warning,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDiagnostic {
    pub schema_version: u32,
    pub code: String,
    pub severity: ScheduleDiagnosticSeverity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
    pub context: RedactedScheduleContext,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RedactedScheduleContext {
    pub fields: BTreeMap<String, String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RedactedScheduleContextWire {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    fields: BTreeMap<String, String>,
}

impl RedactedScheduleContext {
    pub fn validate(&self) -> Result<(), &'static str> {
        for (key, value) in &self.fields {
            let sensitive_key = [
                "secret",
                "token",
                "password",
                "credential",
                "authorization",
                "api_key",
            ]
            .iter()
            .any(|needle| key.to_ascii_lowercase().contains(needle));
            let sensitive_value = ["bearer ", "ghp_", "sk-", "xoxb_"]
                .iter()
                .any(|needle| value.to_ascii_lowercase().contains(needle));
            if (sensitive_key && value != "[redacted]") || sensitive_value {
                return Err(DIAGNOSTIC_SECRET_LEAKAGE);
            }
        }
        Ok(())
    }
}

impl Serialize for RedactedScheduleContext {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.validate().map_err(serde::ser::Error::custom)?;
        RedactedScheduleContextWire {
            fields: self.fields.clone(),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for RedactedScheduleContext {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = RedactedScheduleContextWire::deserialize(deserializer)?;
        let context = Self {
            fields: wire.fields,
        };
        context.validate().map_err(serde::de::Error::custom)?;
        Ok(context)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn scheduler_public_codes_are_unique_and_machine_safe() {
        let codes = PUBLIC_CODES.iter().copied().collect::<BTreeSet<_>>();
        assert_eq!(codes.len(), PUBLIC_CODES.len());
        assert!(codes.iter().all(|code| {
            code.starts_with("scheduler.")
                && code
                    .chars()
                    .all(|character| character.is_ascii_lowercase() || "._".contains(character))
        }));
    }

    #[test]
    fn diagnostics_reject_secret_bearing_context() {
        let mut fields = BTreeMap::new();
        fields.insert("apiToken".to_string(), "not-safe".to_string());
        let context = RedactedScheduleContext { fields };
        assert_eq!(context.validate(), Err(DIAGNOSTIC_SECRET_LEAKAGE));
        assert!(serde_json::to_value(context).is_err());
        assert!(serde_json::from_str::<RedactedScheduleContext>(
            r#"{"fields":{"apiToken":"not-safe"}}"#
        )
        .is_err());
    }
}
