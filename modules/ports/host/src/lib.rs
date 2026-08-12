//! Native host integration for the ports module.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use shipctl_core::workspace::manager::WorkspaceManager;
use shipctl_module_ports::{HostServices, ProcessAuthority, ProjectCatalog};
use tauri::{Builder, Runtime};

const OBSERVATION_TIMEOUT: Duration = Duration::from_secs(5);

struct WorkspaceProjectCatalog {
    workspace: WorkspaceManager,
}

impl ProjectCatalog for WorkspaceProjectCatalog {
    fn registered_project_paths(&self) -> Result<Vec<String>, String> {
        self.workspace
            .list_repos()
            .map(|repos| repos.into_iter().map(|repo| repo.path).collect())
    }
}

struct SystemProcessAuthority;

impl ProcessAuthority for SystemProcessAuthority {
    fn listening_tcp_sockets(&self) -> String {
        run_with_timeout(
            "lsof",
            &["-iTCP", "-sTCP:LISTEN", "-P", "-n"],
            OBSERVATION_TIMEOUT,
        )
    }

    fn process_summaries(&self, pids: &[u32]) -> String {
        let pid_list = joined_pids(pids);
        run_with_timeout(
            "ps",
            &["-p", &pid_list, "-o", "pid=,rss=,etime=,command="],
            OBSERVATION_TIMEOUT,
        )
    }

    fn process_working_directories(&self, pids: &[u32]) -> String {
        let pid_list = joined_pids(pids);
        run_with_timeout(
            "lsof",
            &["-a", "-d", "cwd", "-p", &pid_list],
            OBSERVATION_TIMEOUT,
        )
    }

    fn terminate_process(&self, pid: u32) -> Result<(), String> {
        let pid_text = pid.to_string();
        let status = Command::new("kill")
            .arg(&pid_text)
            .status()
            .map_err(|error| format!("Failed to kill process {pid}: {error}"))?;
        if !status.success() {
            let forced = Command::new("kill")
                .args(["-9", &pid_text])
                .status()
                .map_err(|error| format!("Failed to force-kill process {pid}: {error}"))?;
            if !forced.success() {
                return Err(format!("Failed to force-kill process {pid}"));
            }
        }
        Ok(())
    }
}

fn host_services(workspace: WorkspaceManager) -> HostServices {
    HostServices::new(
        Arc::new(WorkspaceProjectCatalog { workspace }),
        Arc::new(SystemProcessAuthority),
    )
}

pub fn install<R: Runtime>(builder: Builder<R>, workspace: WorkspaceManager) -> Builder<R> {
    builder.plugin(shipctl_module_ports::init(host_services(workspace)))
}

fn joined_pids(pids: &[u32]) -> String {
    pids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn run_with_timeout(command: &str, args: &[&str], timeout: Duration) -> String {
    let mut child = match Command::new(command)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return String::new(),
    };
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                return String::new();
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return String::new(),
        }
    }
    child
        .stdout
        .take()
        .and_then(|mut output| {
            let mut buffer = String::new();
            output.read_to_string(&mut buffer).ok()?;
            Some(buffer)
        })
        .unwrap_or_default()
}
