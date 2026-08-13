use clap::ValueEnum;
use serde::Serialize;
use serde_json::Value;
use shipctl_core::instance::ControlError;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum OutputFormat {
    #[default]
    Toon,
    Json,
    /// One JSON object per line, with no response envelope.
    ///
    /// This is the only format a stream can use: a TOON array declares its
    /// length in its header, which cannot be known before the last record
    /// arrives.
    Jsonl,
}

impl OutputFormat {
    /// True when the format carries a response envelope. A bounded command can
    /// report aggregates and a status code; a stream cannot.
    pub fn is_enveloped(self) -> bool {
        !matches!(self, Self::Jsonl)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ResponseStatus {
    Success,
    NoOp,
    Error,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResponseEnvelope<'a> {
    schema_version: u32,
    operation: &'a str,
    status: ResponseStatus,
    code: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a ControlError>,
}

pub fn success(
    format: OutputFormat,
    operation: &str,
    code: &str,
    no_op: bool,
    data: impl Serialize,
) -> Result<String, String> {
    render(
        format,
        &ResponseEnvelope {
            schema_version: 1,
            operation,
            status: if no_op {
                ResponseStatus::NoOp
            } else {
                ResponseStatus::Success
            },
            code,
            data: Some(serde_json::to_value(data).map_err(|error| error.to_string())?),
            error: None,
        },
    )
}

pub fn failure(
    format: OutputFormat,
    operation: &str,
    error: &ControlError,
) -> Result<String, String> {
    render(
        format,
        &ResponseEnvelope {
            schema_version: 1,
            operation,
            status: ResponseStatus::Error,
            code: &error.code,
            data: None,
            error: Some(error),
        },
    )
}

pub fn outcome(
    format: OutputFormat,
    operation: &str,
    code: &str,
    succeeded: bool,
    data: impl Serialize,
) -> Result<String, String> {
    render(
        format,
        &ResponseEnvelope {
            schema_version: 1,
            operation,
            status: if succeeded {
                ResponseStatus::Success
            } else {
                ResponseStatus::Error
            },
            code,
            data: Some(serde_json::to_value(data).map_err(|error| error.to_string())?),
            error: None,
        },
    )
}

fn render(format: OutputFormat, response: &ResponseEnvelope<'_>) -> Result<String, String> {
    match format {
        OutputFormat::Json => serde_json::to_string(response).map_err(|error| error.to_string()),
        OutputFormat::Toon => {
            toon_format::encode_default(response).map_err(|error| error.to_string())
        }
        OutputFormat::Jsonl => render_lines(response),
    }
}

/// Render without an envelope: an array becomes one line per element, and
/// anything else becomes a single line. An error still reaches stdout as one
/// line, so a reader never has to switch channels to find out what happened.
fn render_lines(response: &ResponseEnvelope<'_>) -> Result<String, String> {
    let encode = |value: &Value| serde_json::to_string(value).map_err(|error| error.to_string());
    if let Some(error) = response.error {
        return encode(&serde_json::to_value(error).map_err(|error| error.to_string())?);
    }
    match response.data.as_ref() {
        Some(Value::Array(elements)) => Ok(elements
            .iter()
            .map(encode)
            .collect::<Result<Vec<_>, _>>()?
            .join("\n")),
        Some(value) => encode(value),
        None => Ok(String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use shipctl_core::module_control::codes::{OPERATION_ACCEPTED, VERIFICATION_MISMATCH};

    /// A stream format drops the envelope, and an array becomes one line per
    /// element so `jq` can read it a record at a time.
    #[test]
    fn jsonl_emits_one_line_per_element_without_an_envelope() {
        let rendered = success(
            OutputFormat::Jsonl,
            "logs",
            "logs.read",
            false,
            json!([{"level": "info"}, {"level": "warn"}]),
        )
        .unwrap();

        let lines = rendered.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], r#"{"level":"info"}"#);
        assert_eq!(lines[1], r#"{"level":"warn"}"#);
        assert!(!rendered.contains("schemaVersion"));
    }

    #[test]
    fn jsonl_renders_a_non_array_payload_as_a_single_line() {
        let rendered = success(
            OutputFormat::Jsonl,
            "logs",
            "logs.read",
            false,
            json!({"count": 2}),
        )
        .unwrap();

        assert_eq!(rendered, r#"{"count":2}"#);
    }

    /// An error still has to reach stdout in the stream format, or a reader
    /// would see an empty stream and no reason for it.
    #[test]
    fn jsonl_still_reports_an_error_on_stdout() {
        let error = ControlError::new("logs.read_failed", "Could not read the log file");

        let rendered = failure(OutputFormat::Jsonl, "logs", &error).unwrap();

        assert_eq!(rendered.lines().count(), 1);
        assert!(rendered.contains("logs.read_failed"));
        assert!(!rendered.contains("schemaVersion"));
    }

    #[test]
    fn only_the_stream_format_drops_the_envelope() {
        assert!(OutputFormat::Toon.is_enveloped());
        assert!(OutputFormat::Json.is_enveloped());
        assert!(!OutputFormat::Jsonl.is_enveloped());
    }

    #[test]
    fn toon_and_json_preserve_the_same_response_data() {
        let data = json!({
            "count": 1,
            "instances": [{"name": "alpha", "status": "ready"}]
        });
        let json_text = success(
            OutputFormat::Json,
            "instances.list",
            "control.instances.listed",
            false,
            &data,
        )
        .unwrap();
        let toon_text = success(
            OutputFormat::Toon,
            "instances.list",
            "control.instances.listed",
            false,
            &data,
        )
        .unwrap();

        let json_value: Value = serde_json::from_str(&json_text).unwrap();
        let toon_value: Value = toon_format::decode_default(&toon_text).unwrap();
        assert_eq!(toon_value, json_value);
    }

    #[test]
    fn default_toon_has_a_pinned_golden_shape() {
        let rendered = success(
            OutputFormat::Toon,
            "instances.list",
            "control.instances.listed",
            false,
            json!({"count": 0, "instances": []}),
        )
        .unwrap();

        assert_eq!(
            rendered,
            "schemaVersion: 1\noperation: instances.list\nstatus: success\ncode: control.instances.listed\ndata:\n  count: 0\n  instances[0]:"
        );
    }

    #[test]
    fn canonical_module_operation_fixture_renders_identically_as_json_and_toon() {
        let operation: Value = serde_json::from_str(include_str!(
            "../../ops/module-control/fixtures/contracts/operation.valid.json"
        ))
        .unwrap();
        let json_text = success(
            OutputFormat::Json,
            "modules.enable",
            OPERATION_ACCEPTED,
            false,
            &operation,
        )
        .unwrap();
        let toon_text = success(
            OutputFormat::Toon,
            "modules.enable",
            OPERATION_ACCEPTED,
            false,
            &operation,
        )
        .unwrap();

        let json_value: Value = serde_json::from_str(&json_text).unwrap();
        let toon_value: Value = toon_format::decode_default(&toon_text).unwrap();
        assert_eq!(toon_value, json_value);
        assert_eq!(json_value["data"], operation);
    }

    #[test]
    fn failed_verification_keeps_machine_readable_data_on_stdout() {
        let rendered = outcome(
            OutputFormat::Json,
            "modules.verify",
            VERIFICATION_MISMATCH,
            false,
            json!({"matched": false}),
        )
        .unwrap();
        let value: Value = serde_json::from_str(&rendered).unwrap();

        assert_eq!(value["status"], "error");
        assert_eq!(value["data"]["matched"], false);
        assert!(value.get("error").is_none());
    }
}
