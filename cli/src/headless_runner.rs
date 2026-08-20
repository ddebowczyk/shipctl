//! Installed-resource discovery and local ABI transport for the headless runtime.
//!
//! Product semantics remain in the TypeScript program. This module only finds
//! the signed packaged resources, starts the runner, and validates the narrow
//! transport envelope that a future compiled runner must preserve.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use shipctl_core::instance::ControlError;

pub const RUNNER_PROTOCOL_VERSION: u32 = 1;
pub const RUNNER_ABI_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerRequest {
    pub schema_version: u32,
    pub runner_abi: u32,
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerResponse {
    pub schema_version: u32,
    pub runner_abi: u32,
    pub operation: String,
    pub status: RunnerStatus,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RunnerStatus {
    Success,
    Failure,
}

struct RunnerPaths {
    executable: PathBuf,
    program: PathBuf,
    kernel: PathBuf,
}

impl RunnerRequest {
    pub fn new(operation: impl Into<String>, input: Option<Value>) -> Self {
        Self {
            schema_version: RUNNER_PROTOCOL_VERSION,
            runner_abi: RUNNER_ABI_VERSION,
            operation: operation.into(),
            input,
        }
    }
}

/// Invoke the packaged headless program through the sidecar contract.
pub fn invoke(request: RunnerRequest) -> Result<RunnerResponse, ControlError> {
    let paths = resolve_paths()?;
    let input = serde_json::to_vec(&request).map_err(|error| {
        ControlError::new(
            "headless.runner.request_encode_failed",
            format!("Could not encode the headless runner request: {error}"),
        )
    })?;
    let mut child = Command::new(&paths.executable)
        // Tauri re-signs embedded executables with the app entitlements.  Run
        // this narrow, non-interactive runtime without V8 JIT rather than
        // widening the app and CLI signing surface for a sidecar.
        .arg("--jitless")
        .arg(&paths.program)
        .arg("--kernel")
        .arg(&paths.kernel)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            ControlError::new(
                "headless.runner.launch_failed",
                format!(
                    "Could not start packaged headless runner {}: {error}",
                    paths.executable.display()
                ),
            )
        })?;
    let stdin = child.stdin.as_mut().ok_or_else(|| {
        ControlError::new(
            "headless.runner.launch_failed",
            "Packaged headless runner did not expose standard input",
        )
    })?;
    stdin.write_all(&input).map_err(|error| {
        ControlError::new(
            "headless.runner.launch_failed",
            format!("Could not send request to packaged headless runner: {error}"),
        )
    })?;
    let output = child.wait_with_output().map_err(|error| {
        ControlError::new(
            "headless.runner.launch_failed",
            format!("Could not wait for packaged headless runner: {error}"),
        )
    })?;
    let response = parse_response(&request, &output.stdout)?;
    if !output.status.success() && response.status == RunnerStatus::Success {
        return Err(ControlError::new(
            "headless.runner.exit_failed",
            format!(
                "Packaged headless runner exited {} after reporting success: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim(),
            ),
        ));
    }
    Ok(response)
}

pub fn probe() -> Result<RunnerResponse, ControlError> {
    let response = invoke(RunnerRequest::new("runner.probe", None))?;
    if response.status == RunnerStatus::Success {
        Ok(response)
    } else {
        Err(response_error(&response))
    }
}

pub fn response_error(response: &RunnerResponse) -> ControlError {
    let message = response
        .data
        .as_ref()
        .and_then(|data| data.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("The packaged headless runner rejected the request");
    ControlError::new(response.code.clone(), message)
}

fn parse_response(request: &RunnerRequest, stdout: &[u8]) -> Result<RunnerResponse, ControlError> {
    let response: RunnerResponse = serde_json::from_slice(stdout).map_err(|error| {
        ControlError::new(
            "headless.runner.invalid_response",
            format!("Packaged headless runner returned invalid JSON: {error}"),
        )
    })?;
    if response.schema_version != RUNNER_PROTOCOL_VERSION
        || response.runner_abi != RUNNER_ABI_VERSION
        || response.operation != request.operation
    {
        return Err(ControlError::new(
            "headless.runner.protocol_mismatch",
            format!(
                "Packaged headless runner response does not match protocol {} ABI {} for {}",
                RUNNER_PROTOCOL_VERSION, RUNNER_ABI_VERSION, request.operation,
            ),
        ));
    }
    Ok(response)
}

fn resolve_paths() -> Result<RunnerPaths, ControlError> {
    let kernel = std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|error| {
            ControlError::new(
                "headless.runner.discovery_failed",
                format!("Could not resolve the installed Shipctl CLI location: {error}"),
            )
        })?;
    let macos = kernel.parent().ok_or_else(|| {
        ControlError::new(
            "headless.runner.discovery_failed",
            "Installed Shipctl CLI has no executable directory",
        )
    })?;
    let contents = macos.parent().ok_or_else(|| {
        ControlError::new(
            "headless.runner.discovery_failed",
            "Installed Shipctl CLI is not inside an application bundle",
        )
    })?;
    let executable = debug_override("SHIPCTL_HEADLESS_RUNNER_TEST_PATH")
        .unwrap_or_else(|| macos.join(runner_file_name()));
    let program = debug_override("SHIPCTL_HEADLESS_RUNNER_TEST_PROGRAM").unwrap_or_else(|| {
        contents
            .join("Resources")
            .join("shipctl-headless-runtime.mjs")
    });
    require_file(
        &executable,
        "headless.runner.not_found",
        "runner executable",
    )?;
    require_file(
        &program,
        "headless.runner.program_not_found",
        "runner program",
    )?;
    Ok(RunnerPaths {
        executable,
        program,
        kernel,
    })
}

fn require_file(path: &Path, code: &str, label: &str) -> Result<(), ControlError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(ControlError::new(
            code,
            format!("Packaged {label} is missing: {}", path.display()),
        ))
    }
}

fn runner_file_name() -> &'static str {
    if cfg!(windows) {
        "shipctl-runtime.exe"
    } else {
        "shipctl-runtime"
    }
}

#[cfg(debug_assertions)]
fn debug_override(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

#[cfg(not(debug_assertions))]
fn debug_override(_name: &str) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_request_is_versioned() {
        let request = RunnerRequest::new("runner.probe", None);
        assert_eq!(request.schema_version, RUNNER_PROTOCOL_VERSION);
        assert_eq!(request.runner_abi, RUNNER_ABI_VERSION);
    }

    #[test]
    fn mismatched_response_is_rejected() {
        let request = RunnerRequest::new("runner.probe", None);
        let response = br#"{"schemaVersion":1,"runnerAbi":2,"operation":"runner.probe","status":"success","code":"headless.runner.ready"}"#;
        assert_eq!(
            parse_response(&request, response)
                .unwrap_err()
                .code
                .as_str(),
            "headless.runner.protocol_mismatch",
        );
    }
}
