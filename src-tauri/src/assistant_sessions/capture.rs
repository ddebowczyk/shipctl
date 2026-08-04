use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::providers::AssistantProvider;

/// Provider-owned metadata that is safe to persist in Shep's restore manifest.
///
/// This deliberately excludes transcript content, prompts, credentials, and
/// process-local PTY information.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSessionMetadata {
    pub provider: AssistantProvider,
    pub session_id: String,
    pub cwd: Option<PathBuf>,
    pub transcript_path: PathBuf,
    pub started_at_epoch_seconds: Option<u64>,
}

/// Read the identity metadata from a Claude Code JSONL transcript.
///
/// Claude stores the session id in the transcript filename and normally repeats
/// it, together with the working directory, in event rows. We use the filename
/// as the stable source of identity and only read enough rows to obtain the cwd.
pub fn parse_claude_session_metadata(path: &Path) -> Result<ProviderSessionMetadata, String> {
    let session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            format!(
                "Claude transcript has no filename session id: {}",
                path.display()
            )
        })?
        .to_owned();

    let file = fs::File::open(path).map_err(|error| {
        format!(
            "Failed to read Claude transcript {}: {error}",
            path.display()
        )
    })?;
    let mut cwd = None;

    for line in BufReader::new(file).lines().take(64) {
        let line =
            line.map_err(|error| format!("Failed to read Claude transcript line: {error}"))?;
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        if let Some(row_cwd) = row.get("cwd").and_then(Value::as_str) {
            cwd = Some(PathBuf::from(row_cwd));
            break;
        }
    }

    Ok(ProviderSessionMetadata {
        provider: AssistantProvider::Claude,
        session_id,
        cwd,
        transcript_path: path.to_path_buf(),
        started_at_epoch_seconds: file_timestamp(path),
    })
}

/// Read the first Codex `session_meta` event, which is its durable session
/// identity contract. The rest of the transcript remains owned by Codex and is
/// not needed for restore capture.
pub fn parse_codex_session_metadata(path: &Path) -> Result<ProviderSessionMetadata, String> {
    let file = fs::File::open(path).map_err(|error| {
        format!(
            "Failed to read Codex transcript {}: {error}",
            path.display()
        )
    })?;

    for line in BufReader::new(file).lines() {
        let line =
            line.map_err(|error| format!("Failed to read Codex transcript line: {error}"))?;
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }

        let payload = row
            .get("payload")
            .ok_or_else(|| format!("Codex session_meta has no payload: {}", path.display()))?;
        let session_id = payload
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("Codex session_meta has no id: {}", path.display()))?
            .to_owned();
        let cwd = payload
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);

        return Ok(ProviderSessionMetadata {
            provider: AssistantProvider::Codex,
            session_id,
            cwd,
            transcript_path: path.to_path_buf(),
            started_at_epoch_seconds: file_timestamp(path),
        });
    }

    Err(format!(
        "Codex transcript has no session_meta event: {}",
        path.display()
    ))
}

fn file_timestamp(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

#[cfg(test)]
mod tests {
    use super::{parse_claude_session_metadata, parse_codex_session_metadata};
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static FIXTURE_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn fixture_path(name: &str) -> std::path::PathBuf {
        let sequence = FIXTURE_COUNTER.fetch_add(1, Ordering::SeqCst);
        let directory = std::env::temp_dir().join(format!(
            "shep-assistant-session-capture-test-{}-{}-{}",
            std::process::id(),
            sequence,
            name
        ));
        fs::create_dir_all(&directory).unwrap();
        directory.join(name)
    }

    #[test]
    fn reads_claude_filename_identity_and_event_cwd() {
        let path = fixture_path("123e4567-e89b-12d3-a456-426614174000.jsonl");
        fs::write(
            &path,
            r#"{"type":"user","sessionId":"123e4567-e89b-12d3-a456-426614174000","cwd":"/tmp/claude-project"}"#,
        )
        .unwrap();

        let metadata = parse_claude_session_metadata(&path).unwrap();

        assert_eq!(metadata.session_id, "123e4567-e89b-12d3-a456-426614174000");
        assert_eq!(
            metadata.cwd.unwrap(),
            std::path::PathBuf::from("/tmp/claude-project")
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn keeps_filename_identity_for_claude_subagent_transcripts() {
        let path = fixture_path("123e4567-e89b-12d3-a456-426614174000.jsonl");
        fs::write(
            &path,
            r#"{"type":"user","sessionId":"different-session","cwd":"/tmp/claude-project"}"#,
        )
        .unwrap();

        let metadata = parse_claude_session_metadata(&path).unwrap();
        assert_eq!(metadata.session_id, "123e4567-e89b-12d3-a456-426614174000");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_codex_session_meta_without_parsing_usage_events() {
        let path = fixture_path("rollout-test.jsonl");
        fs::write(
            &path,
            [
                r#"{"type":"event_msg","payload":{"type":"token_count"}}"#,
                r#"{"type":"session_meta","payload":{"id":"019cb101-19f2-76f0-a5c0-e4249fbdf588","cwd":"/tmp/codex-project"}}"#,
                r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let metadata = parse_codex_session_metadata(&path).unwrap();

        assert_eq!(metadata.session_id, "019cb101-19f2-76f0-a5c0-e4249fbdf588");
        assert_eq!(
            metadata.cwd.unwrap(),
            std::path::PathBuf::from("/tmp/codex-project")
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_codex_transcript_without_identity_metadata() {
        let path = fixture_path("missing-session-meta.jsonl");
        fs::write(
            &path,
            r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#,
        )
        .unwrap();

        assert!(parse_codex_session_metadata(&path).is_err());
        let _ = fs::remove_file(path);
    }
}
