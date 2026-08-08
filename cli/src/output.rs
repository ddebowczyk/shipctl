use serde::Serialize;
use serde_json::Value;
use shipctl_core::instance::ControlError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputFormat {
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
}
