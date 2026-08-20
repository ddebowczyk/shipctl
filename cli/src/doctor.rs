//! Read-only installation and local-state diagnosis for `shipctl doctor`.
//!
//! This command deliberately does not initialize roots, reclaim instance
//! descriptors, migrate registries, or repair artifacts. Its report names the
//! exact inspected paths so a caller can choose a recovery action safely.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use std::process::Command;

use serde::{Deserialize, Serialize};
use shipctl_core::build_info::CONTROL_PROTOCOL_VERSION;
use shipctl_core::instance::{
    resolve_runtime_root_read_only, resolve_state_root_read_only, ControlError, DiscoveryProblem,
    InstanceBuildIdentity, InstanceDirectory, InstanceRecord, RootSource,
};
use shipctl_core::logs::app_log_dir;
use shipctl_core::module_control::artifact_snapshot::{
    diagnose_artifact_root, ArtifactDiagnosticReport,
};
use shipctl_core::module_control::registry::diagnose_registry;
use shipctl_core::module_control::{
    Diagnostic, DiagnosticSeverity, RedactedEvidence, MODULE_CONTROL_SCHEMA_VERSION,
};
use shipctl_core::state::paths::ShipctlPaths;

use crate::args::DoctorArgs;
use crate::output::OutputFormat;
use crate::{emit_failure, emit_outcome, emit_render_failure, paired_ui_path, APP_VERSION};

const OPERATION: &str = "doctor.inspect";
const HEALTHY: &str = "doctor.health.ok";
const DIAGNOSTICS_FAILED: &str = "doctor.diagnostics.failed";
const APP_IDENTIFIER: &str = env!("SHIPCTL_APP_IDENTIFIER");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorReport {
    schema_version: u32,
    read_only: bool,
    cli: ExecutableReport,
    ui: PairedUiReport,
    state_root: RootReport,
    runtime_root: RootReport,
    module_artifacts: ArtifactDiagnosticReport,
    control: ControlReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_directory: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    crash_report_directory: Option<PathBuf>,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutableReport {
    path: PathBuf,
    app_version: String,
    control_protocol_version: u32,
    architectures: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairedUiReport {
    path: PathBuf,
    present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<InstalledUiIdentityReport>,
    architectures: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledUiIdentityReport {
    schema_version: u32,
    executable_role: String,
    app_version: String,
    control_protocol_version: u32,
}

/// The UI's installed `--version --output json` payload uses Rust field names
/// today, rather than the CLI envelope's camel-case projection.
#[derive(Deserialize)]
struct InstalledUiIdentity {
    schema_version: u32,
    executable_role: String,
    app_version: String,
    control_protocol_version: u32,
}

impl From<InstalledUiIdentity> for InstalledUiIdentityReport {
    fn from(value: InstalledUiIdentity) -> Self {
        Self {
            schema_version: value.schema_version,
            executable_role: value.executable_role,
            app_version: value.app_version,
            control_protocol_version: value.control_protocol_version,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootReport {
    path: PathBuf,
    source: RootSource,
    present: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlReport {
    instance_count: usize,
    unreachable_count: usize,
    instances: Vec<InstanceRecord>,
    problems: Vec<DiscoveryProblem>,
}

pub fn run(args: DoctorArgs, output: OutputFormat) -> std::process::ExitCode {
    match inspect(args) {
        Ok(report) => {
            let healthy = report
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.severity != DiagnosticSeverity::Error);
            emit_outcome(
                output,
                OPERATION,
                if healthy { HEALTHY } else { DIAGNOSTICS_FAILED },
                healthy,
                report,
            )
            .unwrap_or_else(|message| emit_render_failure(output, OPERATION, message))
        }
        Err(error) => emit_failure(output, OPERATION, &error, false),
    }
}

fn inspect(args: DoctorArgs) -> Result<DoctorReport, ControlError> {
    let (state_root, state_root_source) = resolve_state_root_read_only(args.state_root.as_deref())
        .map_err(|message| ControlError::new("doctor.state_root.unavailable", message))?;
    let (runtime_root, runtime_root_source) =
        resolve_runtime_root_read_only(args.runtime_root.as_deref())
            .map_err(|message| ControlError::new("doctor.runtime_root.unavailable", message))?;
    let cli_path = std::env::current_exe()
        .map_err(|error| {
            ControlError::new(
                "doctor.executable.cli_unavailable",
                format!("Could not resolve the Shipctl CLI executable path: {error}"),
            )
        })?
        .canonicalize()
        .map_err(|error| {
            ControlError::new(
                "doctor.executable.cli_unavailable",
                format!("Could not resolve the Shipctl CLI executable path: {error}"),
            )
        })?;
    let ui_path = paired_ui_path(&cli_path);
    let paths = ShipctlPaths::new(state_root.clone(), runtime_root.clone());
    let mut diagnostics = Vec::new();

    let state_root = inspect_root(
        "state",
        state_root,
        state_root_source,
        "Start the Shipctl UI to initialize this state root, or pass --state-root for the intended instance.",
        &mut diagnostics,
    );
    let runtime_root = inspect_root(
        "runtime",
        runtime_root,
        runtime_root_source,
        "Start the Shipctl UI to initialize this runtime root, or pass --runtime-root for the intended runtime directory.",
        &mut diagnostics,
    );
    let cli_architectures = inspect_architectures(&cli_path, "CLI", &mut diagnostics);
    let cli = ExecutableReport {
        path: cli_path,
        app_version: APP_VERSION.to_string(),
        control_protocol_version: CONTROL_PROTOCOL_VERSION,
        architectures: cli_architectures.clone(),
    };
    let ui = inspect_paired_ui(&ui_path, &cli, &mut diagnostics);

    let registry_diagnostics = diagnose_registry(&paths.module_registry_database);
    let registry_healthy = registry_diagnostics
        .iter()
        .all(|diagnostic| diagnostic.severity != DiagnosticSeverity::Error);
    diagnostics.extend(registry_diagnostics);
    let module_artifacts =
        diagnose_artifact_root(&paths.module_artifact_root, &paths.module_registry_database);
    if registry_healthy {
        diagnostics.extend(module_artifacts.diagnostics.iter().cloned());
    }

    let control = inspect_control(&runtime_root.path, &mut diagnostics);
    let log_directory = app_log_dir(APP_IDENTIFIER);
    append_log_location_diagnostic(log_directory.as_deref(), &mut diagnostics);
    let crash_report_directory = crash_report_directory();
    append_crash_report_location_diagnostic(crash_report_directory.as_deref(), &mut diagnostics);

    Ok(DoctorReport {
        schema_version: 1,
        read_only: true,
        cli,
        ui,
        state_root,
        runtime_root,
        module_artifacts,
        control,
        log_directory,
        crash_report_directory,
        diagnostics,
    })
}

fn inspect_root(
    kind: &str,
    path: PathBuf,
    source: RootSource,
    absent_remedy: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> RootReport {
    let present = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            diagnostics.push(diagnostic(
                format!("doctor.{kind}_root.invalid"),
                DiagnosticSeverity::Error,
                "root_directory",
                format!("Selected {kind} root is not a real directory"),
                BTreeMap::from([("path".to_string(), path.display().to_string())]),
                Some(format!(
                    "Restore {} as a real private directory before retrying the doctor.",
                    path.display()
                )),
            ));
            true
        }
        Ok(_) => {
            diagnostics.push(diagnostic(
                format!("doctor.{kind}_root.available"),
                DiagnosticSeverity::Info,
                "root_directory",
                format!("Selected {kind} root is available"),
                BTreeMap::from([
                    ("path".to_string(), path.display().to_string()),
                    ("source".to_string(), format!("{source:?}")),
                ]),
                None,
            ));
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            diagnostics.push(diagnostic(
                format!("doctor.{kind}_root.absent"),
                DiagnosticSeverity::Warning,
                "root_directory",
                format!("Selected {kind} root has not been initialized"),
                BTreeMap::from([
                    ("path".to_string(), path.display().to_string()),
                    ("source".to_string(), format!("{source:?}")),
                ]),
                Some(absent_remedy.to_string()),
            ));
            false
        }
        Err(error) => {
            diagnostics.push(diagnostic(
                format!("doctor.{kind}_root.unreadable"),
                DiagnosticSeverity::Error,
                "root_directory",
                format!("Could not inspect selected {kind} root: {error}"),
                BTreeMap::from([("path".to_string(), path.display().to_string())]),
                Some(format!(
                    "Repair permissions for {} before retrying the doctor.",
                    path.display()
                )),
            ));
            false
        }
    };

    RootReport {
        path,
        source,
        present,
    }
}

fn inspect_paired_ui(
    ui_path: &Path,
    cli: &ExecutableReport,
    diagnostics: &mut Vec<Diagnostic>,
) -> PairedUiReport {
    if !ui_path.is_file() {
        diagnostics.push(diagnostic(
            "doctor.executable.ui_missing",
            DiagnosticSeverity::Error,
            "paired_ui",
            format!(
                "Paired Shipctl UI executable is missing: {}",
                ui_path.display()
            ),
            BTreeMap::from([
                ("cliPath".to_string(), cli.path.display().to_string()),
                ("uiPath".to_string(), ui_path.display().to_string()),
            ]),
            Some(
                "Reinstall the Shipctl package so the CLI and UI are installed together."
                    .to_string(),
            ),
        ));
        return PairedUiReport {
            path: ui_path.to_path_buf(),
            present: false,
            identity: None,
            architectures: Vec::new(),
        };
    }

    let architectures = inspect_architectures(ui_path, "UI", diagnostics);
    let identity = match std::process::Command::new(ui_path)
        .args(["--version", "--output", "json"])
        .output()
    {
        Ok(output) if output.status.success() => {
            match serde_json::from_slice::<InstalledUiIdentity>(&output.stdout) {
                Ok(identity) => Some(identity),
                Err(_) => {
                    diagnostics.push(diagnostic(
                        "doctor.executable.ui_identity_invalid",
                        DiagnosticSeverity::Error,
                        "paired_ui",
                        "Paired Shipctl UI did not return a valid build identity".to_string(),
                        BTreeMap::from([("uiPath".to_string(), ui_path.display().to_string())]),
                        Some("Reinstall the Shipctl package so the UI and CLI use compatible builds.".to_string()),
                    ));
                    None
                }
            }
        }
        Ok(output) => {
            diagnostics.push(diagnostic(
                "doctor.executable.ui_probe_failed",
                DiagnosticSeverity::Error,
                "paired_ui",
                format!(
                    "Paired Shipctl UI version probe exited with {}",
                    output.status
                ),
                BTreeMap::from([("uiPath".to_string(), ui_path.display().to_string())]),
                Some(
                    "Reinstall the Shipctl package so the UI executable can run normally."
                        .to_string(),
                ),
            ));
            None
        }
        Err(error) => {
            diagnostics.push(diagnostic(
                "doctor.executable.ui_probe_failed",
                DiagnosticSeverity::Error,
                "paired_ui",
                format!("Could not execute paired Shipctl UI version probe: {error}"),
                BTreeMap::from([("uiPath".to_string(), ui_path.display().to_string())]),
                Some(
                    "Reinstall the Shipctl package so the UI executable can run normally."
                        .to_string(),
                ),
            ));
            None
        }
    };

    if let Some(identity) = identity.as_ref() {
        append_identity_diagnostics(identity, ui_path, cli, &architectures, diagnostics);
    }
    PairedUiReport {
        path: ui_path.to_path_buf(),
        present: true,
        identity: identity.map(Into::into),
        architectures,
    }
}

fn append_identity_diagnostics(
    identity: &InstalledUiIdentity,
    ui_path: &Path,
    cli: &ExecutableReport,
    ui_architectures: &[String],
    diagnostics: &mut Vec<Diagnostic>,
) {
    if identity.schema_version != 1 || identity.executable_role != "ui" {
        diagnostics.push(diagnostic(
            "doctor.executable.ui_identity_invalid",
            DiagnosticSeverity::Error,
            "paired_ui_identity",
            "Paired Shipctl UI reported an incompatible executable identity".to_string(),
            BTreeMap::from([
                ("uiPath".to_string(), ui_path.display().to_string()),
                (
                    "schemaVersion".to_string(),
                    identity.schema_version.to_string(),
                ),
                (
                    "executableRole".to_string(),
                    identity.executable_role.clone(),
                ),
            ]),
            Some(
                "Reinstall the Shipctl package so its executable roles match the expected layout."
                    .to_string(),
            ),
        ));
    }
    if identity.app_version != cli.app_version {
        diagnostics.push(diagnostic(
            "doctor.executable.version.mismatch",
            DiagnosticSeverity::Error,
            "paired_executable_version",
            "Shipctl CLI and UI versions do not match".to_string(),
            BTreeMap::from([
                ("cliPath".to_string(), cli.path.display().to_string()),
                ("cliVersion".to_string(), cli.app_version.clone()),
                ("uiPath".to_string(), ui_path.display().to_string()),
                ("uiVersion".to_string(), identity.app_version.clone()),
            ]),
            Some(
                "Reinstall the Shipctl package so the CLI and UI come from one release."
                    .to_string(),
            ),
        ));
    }
    if identity.control_protocol_version != cli.control_protocol_version {
        diagnostics.push(diagnostic(
            "doctor.executable.protocol.mismatch",
            DiagnosticSeverity::Error,
            "paired_executable_protocol",
            "Shipctl CLI and UI control protocol versions do not match".to_string(),
            BTreeMap::from([
                (
                    "cliControlProtocolVersion".to_string(),
                    cli.control_protocol_version.to_string(),
                ),
                (
                    "uiControlProtocolVersion".to_string(),
                    identity.control_protocol_version.to_string(),
                ),
            ]),
            Some(
                "Reinstall the Shipctl package so the CLI and UI come from one release."
                    .to_string(),
            ),
        ));
    }
    let cli_architecture_set = cli.architectures.iter().collect::<BTreeSet<_>>();
    let ui_architecture_set = ui_architectures.iter().collect::<BTreeSet<_>>();
    if !cli_architecture_set.is_empty()
        && !ui_architecture_set.is_empty()
        && cli_architecture_set != ui_architecture_set
    {
        diagnostics.push(diagnostic(
            "doctor.executable.architecture.mismatch",
            DiagnosticSeverity::Error,
            "paired_executable_architecture",
            "Shipctl CLI and UI architectures do not match".to_string(),
            BTreeMap::from([
                ("cliArchitectures".to_string(), cli.architectures.join(",")),
                ("uiArchitectures".to_string(), ui_architectures.join(",")),
            ]),
            Some(
                "Reinstall the Shipctl package with matching CLI and UI architectures.".to_string(),
            ),
        ));
    }
}

fn inspect_architectures(
    path: &Path,
    role: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        match Command::new("/usr/bin/lipo")
            .arg("-archs")
            .arg(path)
            .output()
        {
            Ok(output) if output.status.success() => {
                let architectures = String::from_utf8_lossy(&output.stdout)
                    .split_ascii_whitespace()
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                if !architectures.is_empty() {
                    return architectures;
                }
                diagnostics.push(diagnostic(
                    "doctor.executable.architecture.unavailable",
                    DiagnosticSeverity::Error,
                    "executable_architecture",
                    format!("Could not determine the {role} executable architecture"),
                    BTreeMap::from([("path".to_string(), path.display().to_string())]),
                    Some("Reinstall the Shipctl package and retry the doctor.".to_string()),
                ));
            }
            Ok(output) => diagnostics.push(diagnostic(
                "doctor.executable.architecture.unavailable",
                DiagnosticSeverity::Error,
                "executable_architecture",
                format!(
                    "Could not inspect the {role} executable architecture: {}",
                    output.status
                ),
                BTreeMap::from([("path".to_string(), path.display().to_string())]),
                Some("Reinstall the Shipctl package and retry the doctor.".to_string()),
            )),
            Err(error) => diagnostics.push(diagnostic(
                "doctor.executable.architecture.unavailable",
                DiagnosticSeverity::Error,
                "executable_architecture",
                format!(
                    "Could not run the architecture inspector for the {role} executable: {error}"
                ),
                BTreeMap::from([("path".to_string(), path.display().to_string())]),
                Some(
                    "Install the platform architecture inspector and retry the doctor.".to_string(),
                ),
            )),
        }
        Vec::new()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, role, diagnostics);
        vec![std::env::consts::ARCH.to_string()]
    }
}

fn inspect_control(runtime_root: &Path, diagnostics: &mut Vec<Diagnostic>) -> ControlReport {
    let directory = InstanceDirectory::new(
        runtime_root.to_path_buf(),
        InstanceBuildIdentity {
            app_version: APP_VERSION.to_string(),
            control_protocol_version: CONTROL_PROTOCOL_VERSION,
        },
    );
    let report = directory.discover_read_only();
    for instance in &report.instances {
        diagnostics.push(diagnostic(
            "doctor.instance.control.healthy",
            DiagnosticSeverity::Info,
            "control_endpoint",
            format!(
                "Running instance {} responded to the control handshake",
                instance.name
            ),
            BTreeMap::from([
                ("instanceId".to_string(), instance.instance_id.to_string()),
                ("instanceName".to_string(), instance.name.clone()),
                (
                    "stateRoot".to_string(),
                    instance.state_root.display().to_string(),
                ),
            ]),
            None,
        ));
    }
    for problem in &report.problems {
        diagnostics.push(diagnostic(
            "doctor.instance.control.unreachable",
            DiagnosticSeverity::Error,
            "control_endpoint",
            format!("Could not reach a published Shipctl control endpoint: {}", problem.error.message),
            BTreeMap::from([
                (
                    "descriptorPath".to_string(),
                    problem.descriptor_path.display().to_string(),
                ),
                ("category".to_string(), format!("{:?}", problem.category)),
                ("errorCode".to_string(), problem.error.code.to_string()),
                ("reclaimed".to_string(), problem.reclaimed.to_string()),
            ]),
            Some(format!(
                "Inspect {}; `shipctl instances list` may reclaim it only after confirming its process identity is dead.",
                problem.descriptor_path.display()
            )),
        ));
    }
    if report.instances.is_empty() && report.problems.is_empty() {
        diagnostics.push(diagnostic(
            "doctor.instance.control.none",
            DiagnosticSeverity::Info,
            "control_endpoint",
            "No published Shipctl instance descriptors were found".to_string(),
            BTreeMap::from([(
                "runtimeRoot".to_string(),
                runtime_root.display().to_string(),
            )]),
            Some("Run `shipctl ui` to start an instance when you are ready.".to_string()),
        ));
    }

    ControlReport {
        instance_count: report.instances.len(),
        unreachable_count: report.problems.len(),
        instances: report.instances,
        problems: report.problems,
    }
}

fn append_log_location_diagnostic(path: Option<&Path>, diagnostics: &mut Vec<Diagnostic>) {
    let (severity, summary, fields, remedy) = match path {
        Some(path) => (
            DiagnosticSeverity::Info,
            "Shipctl application logs are stored at the named location".to_string(),
            BTreeMap::from([("logDirectory".to_string(), path.display().to_string())]),
            None,
        ),
        None => (
            DiagnosticSeverity::Warning,
            "Could not resolve the Shipctl application log directory".to_string(),
            BTreeMap::new(),
            Some("Set a valid home/config directory, then retry the doctor.".to_string()),
        ),
    };
    diagnostics.push(diagnostic(
        "doctor.logs.location",
        severity,
        "log_location",
        summary,
        fields,
        remedy,
    ));
}

fn crash_report_directory() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("Library/Logs/DiagnosticReports"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn append_crash_report_location_diagnostic(path: Option<&Path>, diagnostics: &mut Vec<Diagnostic>) {
    let (severity, summary, fields, remedy) = match path {
        Some(path) => (
            DiagnosticSeverity::Info,
            "Platform crash reports can be found at the named location".to_string(),
            BTreeMap::from([(
                "crashReportDirectory".to_string(),
                path.display().to_string(),
            )]),
            None,
        ),
        None => (
            DiagnosticSeverity::Info,
            "No platform-specific crash-report directory is configured for this build".to_string(),
            BTreeMap::new(),
            None,
        ),
    };
    diagnostics.push(diagnostic(
        "doctor.crash_reports.location",
        severity,
        "crash_report_location",
        summary,
        fields,
        remedy,
    ));
}

fn diagnostic(
    code: impl Into<String>,
    severity: DiagnosticSeverity,
    check: impl Into<String>,
    summary: impl Into<String>,
    fields: BTreeMap<String, String>,
    remedy: Option<String>,
) -> Diagnostic {
    Diagnostic {
        schema_version: MODULE_CONTROL_SCHEMA_VERSION,
        code: code.into(),
        severity,
        check: check.into(),
        summary: summary.into(),
        evidence: RedactedEvidence { fields },
        remedy,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_root_is_reported_without_creating_it() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("not-created");
        let mut diagnostics = Vec::new();

        let report = inspect_root(
            "state",
            path.clone(),
            RootSource::Explicit,
            "initialize it",
            &mut diagnostics,
        );

        assert!(!report.present);
        assert!(!path.exists());
        assert_eq!(diagnostics[0].code, "doctor.state_root.absent");
        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Warning);
    }
}
