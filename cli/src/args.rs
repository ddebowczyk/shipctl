use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
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

    /// Select compact TOON output or JSON.
    #[arg(long, global = true, value_enum, default_value_t)]
    pub output: OutputFormat,

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
    /// List module records without contacting a running instance.
    List(OfflineListArgs),
    /// Inspect desired and observed state for one module.
    Inspect(ModuleInspectArgs),
    /// Run registry and module diagnostics.
    Diagnose(ModuleDiagnoseArgs),
    /// Verify offline registry state against an expectation file.
    Verify(ModuleVerifyArgs),
    /// Request that a running instance enable a module.
    Enable(ModuleTransitionArgs),
    /// Request that a running instance disable a module.
    Disable(ModuleTransitionArgs),
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

    /// Registry revision the caller expects to replace.
    #[arg(long)]
    pub target_revision: u64,

    /// Running instance name or UUID.
    #[arg(long)]
    pub instance: Option<String>,

    /// Override the local instance discovery directory.
    #[arg(long, value_name = "PATH")]
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
