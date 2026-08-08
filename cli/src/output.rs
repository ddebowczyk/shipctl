use clap::ValueEnum;
use serde::Serialize;
use serde_json::Value;
use shipctl_core::instance::ControlError;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub enum OutputFormat {
    #[default]
    Toon,
    Json,
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
            "module.operation.fixture",
            false,
            &operation,
        )
        .unwrap();
        let toon_text = success(
            OutputFormat::Toon,
            "modules.enable",
            "module.operation.fixture",
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
            "module.verification.expectation_mismatch",
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
