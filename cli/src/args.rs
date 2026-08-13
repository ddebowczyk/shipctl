use std::path::PathBuf;

use clap::{ArgGroup, Args, Parser, Subcommand, ValueEnum};
use shipctl_core::terminal_host::{TerminalAgentReportKind, TerminalId};
use shipctl_module_semantic_terminal_core::projection::ProjectedSpace;
use uuid::Uuid;

use crate::output::OutputFormat;
use crate::APP_VERSION;

#[derive(Debug, Parser)]
#[command(
    name = "shipctl",
    version = APP_VERSION,
    about = "Inspect and control Shipctl instances and capability modules",
    disable_help_subcommand = true,
    disable_version_flag = true
)]
pub struct Cli {
    /// Print the Shipctl and control-protocol versions.
    #[arg(short = 'V', long)]
    pub version: bool,

    /// Select compact TOON or JSON output for finite commands.
    #[arg(long, global = true, value_enum, default_value_t)]
    pub output: OutputFormat,

    /// Include non-secret diagnostic context where the command supports it.
    #[arg(long, global = true)]
    pub full: bool,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Start the UI or inspect its launcher options.
    Ui {
        #[command(subcommand)]
        command: UiCommand,
    },
    /// List, inspect, or stop named running instances.
    Instances {
        #[command(subcommand)]
        command: InstancesCommand,
    },
    /// Inspect, diagnose, verify, or change capability modules.
    Modules {
        #[command(subcommand)]
        command: ModulesCommand,
    },
    /// Inspect or diagnose the in-memory runtime message bus.
    Messages {
        #[command(subcommand)]
        command: MessagesCommand,
    },
    /// Discover and invoke agent-visible capabilities on one running instance.
    Capabilities {
        #[command(subcommand)]
        command: CapabilitiesCommand,
    },
    /// List, inspect, attach to, write to, report activity for, or close host-owned terminals.
    Terminals {
        #[command(subcommand)]
        command: TerminalsCommand,
    },
    /// Inspect, verify, refresh, or trigger schedules in a running instance.
    Schedule {
        #[command(subcommand)]
        command: ScheduleCommand,
    },
    /// Inspect asynchronous module operations.
    Operations {
        #[command(subcommand)]
        command: OperationsCommand,
    },
    /// Save, inspect, or verify instance state archives.
    State {
        #[command(subcommand)]
        command: StateCommand,
    },
    /// Print the Shipctl and control-protocol versions.
    Version,
}

#[derive(Debug, Subcommand)]
pub enum TerminalsCommand {
    /// List terminals owned by one running instance.
    List(TerminalTargetArgs),
    /// Get the complete redacted descriptor for one terminal.
    Get(TerminalIdArgs),
    /// Print what the host believes about one terminal: cells, cursor, modes,
    /// and colours. Reads state; changes nothing.
    Inspect(TerminalInspectArgs),
    /// Print the rows that scrolled out of one terminal's viewport.
    History(TerminalHistoryArgs),
    /// Pin one cell, so a later read can find that line after row numbers move.
    Anchor(TerminalAnchorArgs),
    /// Print where an anchored line is now.
    ResolveAnchor(TerminalAnchorIdArgs),
    /// Drop an anchor the host is holding.
    ReleaseAnchor(TerminalAnchorIdArgs),
    /// Stream canonical replay followed by ordered live terminal events.
    Attach(TerminalAttachArgs),
    /// Write exact bytes to one running terminal.
    Write(TerminalWriteArgs),
    /// Report one thing a person did and let the host encode it.
    Input(TerminalInputArgs),
    /// Report supplemental agent activity for one terminal.
    Report(TerminalReportArgs),
    /// Close one terminal; repeated close is a successful no-op.
    Close(TerminalIdArgs),
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum TerminalAgentReportKindArg {
    Idle,
    Working,
    Blocked,
    Completed,
}

impl From<TerminalAgentReportKindArg> for TerminalAgentReportKind {
    fn from(value: TerminalAgentReportKindArg) -> Self {
        match value {
            TerminalAgentReportKindArg::Idle => Self::Idle,
            TerminalAgentReportKindArg::Working => Self::Working,
            TerminalAgentReportKindArg::Blocked => Self::Blocked,
            TerminalAgentReportKindArg::Completed => Self::Completed,
        }
    }
}

#[derive(Debug, Args)]
pub struct TerminalReportArgs {
    /// Agent state or attention transition to report.
    #[arg(value_enum)]
    pub kind: TerminalAgentReportKindArg,

    /// Terminal UUID; defaults to SHIPCTL_TERMINAL_ID inside a hosted terminal.
    #[arg(long)]
    pub terminal_id: Option<TerminalId>,

    /// Instance name or UUID; defaults to SHIPCTL_INSTANCE_ID inside a hosted terminal.
    #[arg(long)]
    pub instance: Option<String>,

    /// Stable identifier for the reporting integration.
    #[arg(long, default_value = "shipctl-cli")]
    pub source: String,

    /// Version of the reporting integration.
    #[arg(long, default_value = APP_VERSION)]
    pub source_version: String,

    /// Optional human-readable activity detail.
    #[arg(long)]
    pub message: Option<String>,

    #[command(flatten)]
    pub runtime: RuntimeRootArgs,
}

#[derive(Debug, Args)]
pub struct TerminalTargetArgs {
    /// Exact running instance name or UUID.
    #[arg(long)]
    pub instance: String,

    #[command(flatten)]
    pub runtime: RuntimeRootArgs,
}

#[derive(Debug, Args)]
pub struct TerminalIdArgs {
    /// Opaque terminal UUID returned by `terminals list`.
    pub terminal_id: TerminalId,

    #[command(flatten)]
    pub target: TerminalTargetArgs,
}

#[derive(Debug, Args)]
pub struct TerminalInspectArgs {
    /// Opaque terminal UUID returned by `terminals list`.
    pub terminal_id: TerminalId,

    /// Print the viewport as plain text instead of the full state.
    #[arg(long)]
    pub text: bool,

    #[command(flatten)]
    pub target: TerminalTargetArgs,
}

/// A window of retained history.
///
/// Both bounds are required: history has no natural end to default to, and a
/// number invented here would be this CLI deciding how much scrollback a
/// caller wanted.
#[derive(Debug, Args)]
pub struct TerminalHistoryArgs {
    /// Opaque terminal UUID returned by `terminals list`.
    pub terminal_id: TerminalId,

    /// History row to start at. Zero is the oldest row the host still keeps.
    #[arg(long)]
    pub start_row: u32,

    /// How many rows to read. A window past what history holds answers with
    /// the rows that exist.
    #[arg(long)]
    pub rows: u32,

    /// Print the rows as plain text instead of the full window.
    #[arg(long)]
    pub text: bool,

    #[command(flatten)]
    pub target: TerminalTargetArgs,
}

/// Which space a cell is named in.
///
/// The same cell has a different number in each, so a point with no space is
/// not a point. There is no default for the same reason.
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum TerminalSpaceArg {
    /// The rows the child writes to.
    Active,
    /// What is displayed.
    Viewport,
    /// History and the active area together.
    Screen,
    /// History alone, oldest row first.
    History,
}

impl From<TerminalSpaceArg> for ProjectedSpace {
    fn from(value: TerminalSpaceArg) -> Self {
        match value {
            TerminalSpaceArg::Active => Self::Active,
            TerminalSpaceArg::Viewport => Self::Viewport,
            TerminalSpaceArg::Screen => Self::Screen,
            TerminalSpaceArg::History => Self::History,
        }
    }
}

/// The cell to pin.
#[derive(Debug, Args)]
pub struct TerminalAnchorArgs {
    /// Opaque terminal UUID returned by `terminals list`.
    pub terminal_id: TerminalId,

    /// Which space the row and column are named in.
    #[arg(long, value_enum)]
    pub space: TerminalSpaceArg,

    /// Row within that space.
    #[arg(long)]
    pub row: u32,

    /// Column within that row.
    #[arg(long)]
    pub column: u16,

    #[command(flatten)]
    pub target: TerminalTargetArgs,
}

/// An anchor the host minted for this terminal.
#[derive(Debug, Args)]
pub struct TerminalAnchorIdArgs {
    /// Opaque terminal UUID returned by `terminals list`.
    pub terminal_id: TerminalId,

    /// Anchor handle returned by `terminals anchor`.
    pub anchor: u64,

    #[command(flatten)]
    pub target: TerminalTargetArgs,
}

#[derive(Debug, Args)]
pub struct TerminalAttachArgs {
    /// Opaque terminal UUID returned by `terminals list`.
    pub terminal_id: TerminalId,

    /// Write exact child bytes directly to stdout.
    #[arg(long)]
    pub raw: bool,

    #[command(flatten)]
    pub target: TerminalTargetArgs,
}

#[derive(Debug, Args)]
#[command(group(
    ArgGroup::new("terminal_semantic_input")
        .required(true)
        .multiple(false)
        .args(["json", "stdin"])
))]
pub struct TerminalInputArgs {
    /// Opaque terminal UUID returned by `terminals list`.
    pub terminal_id: TerminalId,

    /// One semantic input event as JSON: a key, committed text, a paste, a
    /// pointer event, or a focus change.
    #[arg(long)]
    pub json: Option<String>,

    /// Read the semantic input event from stdin as JSON.
    #[arg(long)]
    pub stdin: bool,

    #[command(flatten)]
    pub target: TerminalTargetArgs,
}

#[derive(Debug, Args)]
#[command(group(
    ArgGroup::new("terminal_input")
        .required(true)
        .multiple(false)
        .args(["data", "base64", "stdin"])
))]
pub struct TerminalWriteArgs {
    /// Opaque terminal UUID returned by `terminals list`.
    pub terminal_id: TerminalId,

    /// Write these literal UTF-8 bytes without interpreting escapes.
    #[arg(long, value_name = "TEXT")]
    pub data: Option<String>,

    /// Decode and write arbitrary bytes from standard base64.
    #[arg(long, value_name = "BASE64")]
    pub base64: Option<String>,

    /// Read bytes from stdin to EOF; never prompts.
    #[arg(long)]
    pub stdin: bool,

    #[command(flatten)]
    pub target: TerminalTargetArgs,
}

#[derive(Debug, Subcommand)]
pub enum UiCommand {
    /// Start a named UI instance and wait until it publishes readiness.
    Start(UiStartArgs),
}

#[derive(Debug, Args)]
pub struct UiStartArgs {
    /// Stable name used to address this instance later.
    #[arg(long)]
    pub name: String,

    /// Writable state directory owned by this instance.
    #[arg(long, value_name = "PATH")]
    pub state_root: Option<PathBuf>,

    /// Directory used for local instance discovery and control endpoints.
    #[arg(long, value_name = "PATH")]
    pub runtime_root: Option<PathBuf>,

    /// Restore the new instance from this state archive.
    #[arg(long, value_name = "FILE")]
    pub load_state: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
pub enum InstancesCommand {
    /// List running named instances.
    List(RuntimeRootArgs),
    /// Inspect one instance, or the sole running instance.
    Inspect(InstanceSelectorArgs),
    /// Diagnose instance discovery, protocol, registry, and runtime state.
    Diagnose(InstanceSelectorArgs),
    /// Stop one instance, or the sole running instance.
    Stop(InstanceStopArgs),
}

#[derive(Debug, Args)]
pub struct RuntimeRootArgs {
    /// Override the local instance discovery directory.
    #[arg(long, value_name = "PATH")]
    pub runtime_root: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct InstanceSelectorArgs {
    /// Instance name or UUID; omitted only when exactly one instance is running.
    pub selector: Option<String>,

    #[command(flatten)]
    pub runtime: RuntimeRootArgs,
}

#[derive(Debug, Args)]
pub struct InstanceStopArgs {
    /// Instance name or UUID; omitted only when exactly one instance is running.
    pub selector: Option<String>,

    /// Force shutdown when graceful control is unavailable.
    #[arg(long)]
    pub force: bool,

    #[command(flatten)]
    pub runtime: RuntimeRootArgs,
}

#[derive(Debug, Subcommand)]
pub enum ModulesCommand {
    /// Validate an immutable module archive without installing or activating it.
    Preflight(OfflineArtifactArgs),
    /// Install a validated immutable module archive in disabled state.
    Add(OfflineArtifactArgs),
    /// List module records without contacting a running instance.
    List(OfflineListArgs),
    /// Inspect desired and observed state for one module.
    Inspect(ModuleInspectArgs),
    /// Inspect one declared capability from installed disabled artifacts.
    InspectCapability(OfflineCapabilityInspectArgs),
    /// Run registry and module diagnostics.
    Diagnose(ModuleDiagnoseArgs),
    /// Verify offline registry state against an expectation file.
    Verify(ModuleVerifyArgs),
    /// Request that a running instance enable a module.
    Enable(ModuleTransitionArgs),
    /// Request that a running instance disable a module.
    Disable(ModuleTransitionArgs),
}

#[derive(Debug, Subcommand)]
pub enum MessagesCommand {
    /// Inspect current contracts, routes, ownership, grants, and queue state.
    Inspect(MessageTargetArgs),
    /// Diagnose current message failures, lag, and drain blockers.
    Diagnose(MessageTargetArgs),
}

#[derive(Debug, Subcommand)]
pub enum CapabilitiesCommand {
    /// List active agent-visible capabilities.
    List(CapabilityTargetArgs),
    /// Inspect one active capability definition and its provider.
    Inspect(CapabilityInspectArgs),
    /// Invoke one explicitly agent-callable typed port.
    Call(CapabilityCallArgs),
}

#[derive(Debug, Args)]
pub struct CapabilityTargetArgs {
    /// Running instance name or UUID.
    #[arg(long)]
    pub instance: String,

    #[command(flatten)]
    pub runtime: RuntimeRootArgs,
}

#[derive(Debug, Args)]
pub struct CapabilityInspectArgs {
    pub capability_id: String,

    #[command(flatten)]
    pub target: CapabilityTargetArgs,
}

#[derive(Debug, Args)]
pub struct CapabilityCallArgs {
    pub capability_id: String,
    pub port_id: String,

    /// JSON request payload validated against the port contract.
    #[arg(long, value_name = "JSON")]
    pub input: String,

    #[command(flatten)]
    pub target: CapabilityTargetArgs,
}

#[derive(Debug, Subcommand)]
pub enum ScheduleCommand {
    /// List accepted schedules in one explicitly named running instance.
    List(ScheduleTargetArgs),
    /// Inspect one accepted schedule in an explicitly named running instance.
    Inspect(ScheduleIdArgs),
    /// Diagnose schedule source, accepted state, target, bus, and runtime health.
    Diagnose(ScheduleTargetArgs),
    /// Compare current schedule sources to accepted state without publishing changes.
    Verify(ScheduleTargetArgs),
    /// Refresh schedules in one named instance or independently in every running instance.
    Refresh(ScheduleRefreshArgs),
    /// Deliver one accepted schedule now through its typed scheduler route.
    Trigger(ScheduleTriggerArgs),
}

#[derive(Debug, Args)]
pub struct ScheduleTargetArgs {
    /// Exact running instance name or UUID.
    #[arg(long)]
    pub instance: String,

    #[command(flatten)]
    pub runtime: RuntimeRootArgs,
}

#[derive(Debug, Args)]
pub struct ScheduleIdArgs {
    /// Accepted schedule identifier.
    pub id: String,

    #[command(flatten)]
    pub target: ScheduleTargetArgs,
}

#[derive(Debug, Args)]
pub struct ScheduleRefreshArgs {
    /// Exact running instance name or UUID.
    #[arg(
        long,
        required_unless_present = "all_instances",
        conflicts_with = "all_instances"
    )]
    pub instance: Option<String>,

    /// Refresh every currently running instance independently.
    #[arg(long, conflicts_with = "instance")]
    pub all_instances: bool,

    /// Reuse this UUID to retry the same refresh per target without applying it twice.
    #[arg(long)]
    pub request_id: Option<Uuid>,

    #[command(flatten)]
    pub runtime: RuntimeRootArgs,
}

#[derive(Debug, Args)]
pub struct ScheduleTriggerArgs {
    /// Accepted schedule identifier.
    pub id: String,

    #[command(flatten)]
    pub target: ScheduleTargetArgs,

    /// Reuse this UUID to retry the same trigger without delivering twice.
    #[arg(long)]
    pub request_id: Option<Uuid>,
}

#[derive(Debug, Args)]
pub struct MessageTargetArgs {
    /// Exact running instance name or UUID.
    #[arg(long)]
    pub instance: String,

    #[command(flatten)]
    pub runtime: RuntimeRootArgs,
}

#[derive(Debug, Args)]
pub struct OfflineListArgs {
    /// Read durable state without contacting or starting a runtime.
    #[arg(long, required = true)]
    pub offline: bool,

    /// Override the state root selected by environment or platform defaults.
    #[arg(long, value_name = "PATH")]
    pub state_root: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct OfflineArtifactArgs {
    /// Immutable Shipctl module archive to validate or install.
    pub archive: PathBuf,

    /// Operate on durable state without contacting or starting a runtime.
    #[arg(long, required = true)]
    pub offline: bool,

    /// Override the state root selected by environment or platform defaults.
    #[arg(long, value_name = "PATH")]
    pub state_root: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct OfflineCapabilityInspectArgs {
    /// Stable capability identifier declared by an installed artifact.
    pub capability_id: String,

    /// Read durable state without contacting or starting a runtime.
    #[arg(long, required = true)]
    pub offline: bool,

    /// Override the state root selected by environment or platform defaults.
    #[arg(long, value_name = "PATH")]
    pub state_root: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct ModuleInspectArgs {
    pub module_id: String,

    /// Read durable state without contacting or starting a runtime.
    #[arg(long, conflicts_with_all = ["instance", "runtime_root"])]
    pub offline: bool,

    /// Override the offline state root.
    #[arg(long, value_name = "PATH", requires = "offline")]
    pub state_root: Option<PathBuf>,

    #[command(flatten)]
    pub online: OnlineTargetArgs,
}

#[derive(Debug, Args)]
pub struct ModuleDiagnoseArgs {
    /// Module to diagnose; omit during offline whole-registry diagnosis.
    #[arg(required_unless_present = "offline")]
    pub module_id: Option<String>,

    /// Read durable state without contacting or starting a runtime.
    #[arg(long, conflicts_with_all = ["instance", "runtime_root"])]
    pub offline: bool,

    /// Override the offline state root.
    #[arg(long, value_name = "PATH", requires = "offline")]
    pub state_root: Option<PathBuf>,

    #[command(flatten)]
    pub online: OnlineTargetArgs,
}

#[derive(Debug, Args)]
pub struct ModuleVerifyArgs {
    pub module_id: String,

    /// Read durable state without contacting or starting a runtime.
    #[arg(long, required = true)]
    pub offline: bool,

    /// JSON expectation contract to evaluate.
    #[arg(long = "expect", value_name = "FILE")]
    pub expectation: PathBuf,

    /// Override the offline state root.
    #[arg(long, value_name = "PATH")]
    pub state_root: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct OnlineTargetArgs {
    /// Running instance name or UUID.
    #[arg(long, conflicts_with = "offline")]
    pub instance: Option<String>,

    /// Override the local instance discovery directory.
    #[arg(long, value_name = "PATH", conflicts_with = "offline")]
    pub runtime_root: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct ModuleTransitionArgs {
    pub module_id: String,

    /// Change durable desired state without contacting or restarting a runtime.
    #[arg(long, conflicts_with_all = ["instance", "runtime_root"])]
    pub offline: bool,

    /// Override the offline state root.
    #[arg(long, value_name = "PATH", requires = "offline")]
    pub state_root: Option<PathBuf>,

    /// Registry revision the online caller expects to replace.
    #[arg(long, required_unless_present = "offline")]
    pub target_revision: Option<u64>,

    /// Running instance name or UUID.
    #[arg(long, conflicts_with = "offline")]
    pub instance: Option<String>,

    /// Override the local instance discovery directory.
    #[arg(long, value_name = "PATH", conflicts_with = "offline")]
    pub runtime_root: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
pub enum OperationsCommand {
    /// Inspect one operation by UUID.
    Inspect(OperationInspectArgs),
}

#[derive(Debug, Args)]
pub struct OperationInspectArgs {
    pub operation_id: Uuid,

    /// Running instance name or UUID.
    #[arg(long)]
    pub instance: Option<String>,

    /// Override the local instance discovery directory.
    #[arg(long, value_name = "PATH")]
    pub runtime_root: Option<PathBuf>,
}

#[derive(Debug, Subcommand)]
pub enum StateCommand {
    /// Save state from a running instance.
    Save(StateSaveArgs),
    /// Inspect a state archive without restoring it.
    Inspect(StateArchiveArgs),
    /// Verify a state archive without restoring it.
    Verify(StateArchiveArgs),
}

#[derive(Debug, Args)]
pub struct StateSaveArgs {
    /// Running instance name or UUID.
    #[arg(long)]
    pub instance: String,

    /// Destination state archive.
    #[arg(long = "to", value_name = "FILE")]
    pub destination: PathBuf,

    /// Override the local instance discovery directory.
    #[arg(long, value_name = "PATH")]
    pub runtime_root: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct StateArchiveArgs {
    pub path: PathBuf,
}
