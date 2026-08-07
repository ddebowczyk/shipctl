use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

use super::session::{PtyColorTheme, PtyOutput, PtySession};

const SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(3);

trait TerminationTarget {
    fn request_termination(&mut self);
    fn is_termination_tree_alive(&self) -> bool;
    fn force_kill(&mut self) -> Result<(), String>;
}

impl TerminationTarget for PtySession {
    fn request_termination(&mut self) {
        PtySession::request_termination(self);
    }

    fn is_termination_tree_alive(&self) -> bool {
        PtySession::is_termination_tree_alive(self)
    }

    fn force_kill(&mut self) -> Result<(), String> {
        PtySession::force_kill(self)
    }
}

#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, PtySession>>>,
    next_id: Arc<Mutex<u32>>,
    shutting_down: Arc<AtomicBool>,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(1)),
            shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn session_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    pub fn begin_shutdown(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        command: &str,
        args: Option<Vec<String>>,
        cwd: &str,
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
        color_theme: PtyColorTheme,
        channel: Channel<PtyOutput>,
    ) -> Result<u32, String> {
        let session = PtySession::spawn(command, args, cwd, env, cols, rows, color_theme, channel)?;

        let mut next_id = self.next_id.lock().unwrap();
        let id = *next_id;
        *next_id += 1;

        self.sessions.lock().unwrap().insert(id, session);
        Ok(id)
    }

    pub fn write(&self, pty_id: u32, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(&pty_id)
            .ok_or_else(|| format!("PTY {pty_id} not found"))?;
        session.write(data)
    }

    pub fn acknowledge_output(&self, pty_id: u32, bytes: usize) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&pty_id)
            .ok_or_else(|| format!("PTY {pty_id} not found"))?;
        session.acknowledge_output(bytes);
        Ok(())
    }

    pub fn set_color_theme(&self, color_theme: PtyColorTheme) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        for session in sessions.values() {
            session.set_color_theme(color_theme.clone())?;
        }
        Ok(())
    }

    pub fn resize(&self, pty_id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&pty_id)
            .ok_or_else(|| format!("PTY {pty_id} not found"))?;
        session.resize(cols, rows)
    }

    pub fn kill(&self, pty_id: u32) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut session) = sessions.remove(&pty_id) {
            session.kill()
        } else {
            Ok(())
        }
    }

    pub fn child_pids(&self) -> Vec<u32> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter_map(|s| s.pid())
            .collect()
    }

    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        let deadline = Instant::now() + SHUTDOWN_GRACE_PERIOD;
        let mut draining_sessions: Vec<_> = sessions.drain().map(|(_, session)| session).collect();

        terminate_all_before_deadline(&mut draining_sessions, deadline);
    }
}

fn terminate_all_before_deadline<T: TerminationTarget>(sessions: &mut [T], deadline: Instant) {
    // Ask every process tree to terminate before starting the shared grace
    // window. Waiting inside the drain loop would leave later terminals
    // without any opportunity to flush their own session state.
    for session in sessions.iter_mut() {
        session.request_termination();
    }
    while Instant::now() < deadline
        && sessions
            .iter()
            .any(TerminationTarget::is_termination_tree_alive)
    {
        std::thread::sleep(Duration::from_millis(50));
    }
    for session in sessions.iter_mut() {
        let _ = session.force_kill();
    }
}

#[cfg(test)]
mod tests {
    use super::{terminate_all_before_deadline, TerminationTarget};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    struct FakeSession {
        name: &'static str,
        events: Arc<Mutex<Vec<String>>>,
    }

    impl TerminationTarget for FakeSession {
        fn request_termination(&mut self) {
            self.events
                .lock()
                .unwrap()
                .push(format!("request:{}", self.name));
        }

        fn is_termination_tree_alive(&self) -> bool {
            false
        }

        fn force_kill(&mut self) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(format!("force:{}", self.name));
            Ok(())
        }
    }

    #[test]
    fn requests_every_pty_before_forcing_any_survivor() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut sessions = vec![
            FakeSession {
                name: "first",
                events: events.clone(),
            },
            FakeSession {
                name: "second",
                events: events.clone(),
            },
        ];

        terminate_all_before_deadline(&mut sessions, Instant::now());

        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "request:first",
                "request:second",
                "force:first",
                "force:second"
            ]
        );
    }
}
