//! Process-tree discovery and termination, isolated from registry/record locks.

use std::process::Command;
use std::time::Duration;

use portable_pty::ChildKiller;

/// Existing Shipctl behavior: all process trees receive graceful signals and
/// have three seconds to stop before surviving processes are force-killed.
pub const TERMINATION_GRACE_PERIOD: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminationResult {
    pub graceful_requested: bool,
    pub force_kill_requested: bool,
    pub signal_errors: Vec<String>,
}

#[derive(Debug, Clone)]
struct ProcessTree {
    root_pid: i32,
    process_group: Option<i32>,
    descendants: Vec<i32>,
}

pub struct ProcessTerminator {
    root_pid: Option<i32>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    tree: Option<ProcessTree>,
    result: TerminationResult,
}

impl ProcessTerminator {
    pub fn new(pid: Option<u32>, killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self {
            root_pid: pid.and_then(|pid| i32::try_from(pid).ok()),
            killer,
            tree: None,
            result: TerminationResult::default(),
        }
    }

    /// Capture escaped descendants before signaling the parent and request a
    /// graceful stop. Repetition is an idempotent no-op.
    pub fn request_graceful(&mut self) -> TerminationResult {
        if self.result.graceful_requested {
            return self.result.clone();
        }
        self.result.graceful_requested = true;
        let Some(root_pid) = self.root_pid else {
            return self.result.clone();
        };
        let tree = ProcessTree {
            root_pid,
            process_group: child_process_group(root_pid),
            descendants: get_all_descendants(root_pid),
        };

        #[cfg(unix)]
        {
            let own_group = unsafe { libc::getpgrp() };
            if let Some(group) = tree.process_group.filter(|group| *group != own_group) {
                self.record_signal_result(signal_group(group, libc::SIGHUP));
                self.record_signal_result(signal_group(group, libc::SIGTERM));
            } else {
                // A defensive fallback must never signal Shipctl's own group.
                self.record_signal_result(signal_process(root_pid, libc::SIGTERM));
            }
            for child in tree.descendants.iter().copied() {
                self.record_signal_result(signal_process(child, libc::SIGTERM));
            }
        }

        self.tree = Some(tree);
        self.result.clone()
    }

    pub fn is_tree_alive(&self) -> bool {
        self.tree.as_ref().is_some_and(|tree| {
            process_exists(tree.root_pid) || tree.descendants.iter().copied().any(process_exists)
        })
    }

    /// Force-kill any survivors. Failure is retained for diagnostics but does
    /// not bypass the reader thread's mandatory child wait.
    pub fn force_kill(&mut self) -> TerminationResult {
        if self.result.force_kill_requested {
            return self.result.clone();
        }
        self.result.force_kill_requested = true;
        if let Some(tree) = self.tree.clone() {
            #[cfg(unix)]
            {
                for child in tree.descendants {
                    if process_exists(child) {
                        self.record_signal_result(signal_process(child, libc::SIGKILL));
                    }
                }
                if process_exists(tree.root_pid) {
                    self.record_signal_result(signal_process(tree.root_pid, libc::SIGKILL));
                }
            }
        }
        if let Err(error) = self.killer.kill() {
            self.result
                .signal_errors
                .push(format!("PTY child killer failed: {error}"));
        }
        self.result.clone()
    }

    pub fn result(&self) -> TerminationResult {
        self.result.clone()
    }

    fn record_signal_result(&mut self, result: Result<(), String>) {
        if let Err(error) = result {
            self.result.signal_errors.push(error);
        }
    }
}

fn child_process_group(pid: i32) -> Option<i32> {
    #[cfg(unix)]
    {
        let group = unsafe { libc::getpgid(pid) };
        (group > 0).then_some(group)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

fn process_exists(pid: i32) -> bool {
    #[cfg(unix)]
    {
        if unsafe { libc::kill(pid, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

#[cfg(unix)]
fn signal_process(pid: i32, signal: i32) -> Result<(), String> {
    if !process_exists(pid) {
        return Ok(());
    }
    if unsafe { libc::kill(pid, signal) } == 0 {
        Ok(())
    } else {
        Err(format!(
            "Failed to signal process {pid} with signal {signal}: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(unix)]
fn signal_group(group: i32, signal: i32) -> Result<(), String> {
    let own_group = unsafe { libc::getpgrp() };
    if group == own_group {
        return Err(format!(
            "Refused to signal Shipctl's own process group {group}"
        ));
    }
    if unsafe { libc::killpg(group, signal) } == 0 {
        Ok(())
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(format!(
                "Failed to signal process group {group} with signal {signal}: {error}"
            ))
        }
    }
}

/// Find descendants recursively. This intentionally mirrors the proven
/// current behavior because some assistant CLIs call `setsid` and escape the
/// original PTY process group.
pub(crate) fn get_all_descendants(root_pid: i32) -> Vec<i32> {
    let mut descendants = Vec::new();
    let mut queue = vec![root_pid];
    while let Some(parent) = queue.pop() {
        if let Ok(output) = Command::new("pgrep")
            .arg("-P")
            .arg(parent.to_string())
            .output()
        {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if let Ok(pid) = line.trim().parse::<i32>() {
                    if !descendants.contains(&pid) {
                        descendants.push(pid);
                        queue.push(pid);
                    }
                }
            }
        }
    }
    descendants
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::io::{BufRead, BufReader};
    #[cfg(unix)]
    use std::process::{Command as StdCommand, Stdio};

    use super::*;

    #[cfg(unix)]
    #[derive(Debug)]
    struct SignalOnlyKiller;

    #[cfg(unix)]
    impl ChildKiller for SignalOnlyKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Self)
        }
    }

    #[test]
    fn own_process_group_is_never_a_group_signal_target() {
        #[cfg(unix)]
        {
            let own_group = unsafe { libc::getpgrp() };
            let error = signal_group(own_group, libc::SIGTERM).unwrap_err();
            assert!(error.contains("Refused"));
        }
    }

    #[test]
    fn descendant_scan_of_current_process_does_not_include_itself() {
        let pid = i32::try_from(std::process::id()).unwrap();
        assert!(!get_all_descendants(pid).contains(&pid));
    }

    #[cfg(unix)]
    #[test]
    fn escaped_descendant_process_helper() {
        if std::env::var_os("SHIPCTL_ESCAPED_DESCENDANT_HELPER").is_none() {
            return;
        }
        assert!(unsafe { libc::setsid() } > 0);
        loop {
            std::thread::park();
        }
    }

    #[cfg(unix)]
    #[test]
    fn terminates_a_descendant_that_escapes_the_parent_process_group() {
        let executable = std::env::current_exe().unwrap();
        let mut child = StdCommand::new("/bin/sh")
            .arg("-c")
            .arg(
                "\"$SHIPCTL_TEST_EXECUTABLE\" --exact terminal_host::process::tests::escaped_descendant_process_helper >/dev/null 2>&1 & echo $!; wait",
            )
            .env("SHIPCTL_TEST_EXECUTABLE", executable)
            .env("SHIPCTL_ESCAPED_DESCENDANT_HELPER", "1")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut pid_line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut pid_line)
            .unwrap();
        let escaped_pid = pid_line.trim().parse::<i32>().unwrap();
        let root_pid = i32::try_from(child.id()).unwrap();
        let mut terminator = ProcessTerminator::new(Some(child.id()), Box::new(SignalOnlyKiller));

        let graceful = terminator.request_graceful();
        assert!(graceful.graceful_requested);
        assert!(
            terminator
                .tree
                .as_ref()
                .unwrap()
                .descendants
                .contains(&escaped_pid),
            "escaped descendant must be captured before its parent is signalled"
        );
        let forced = terminator.force_kill();
        assert!(forced.force_kill_requested);
        let _ = child.wait().unwrap();

        let state = StdCommand::new("ps")
            .args(["-o", "state=", "-p", &escaped_pid.to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&state.stdout);
        assert!(
            state.trim().is_empty() || state.trim_start().starts_with('Z'),
            "escaped descendant {escaped_pid} is still running with state {state:?}; root was {root_pid}"
        );
    }
}
