use serde::{Deserialize, Serialize};

/// The supported providers are an allowlist, never arbitrary persisted command
/// strings. This keeps the restore manifest from becoming a command-execution
/// format.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssistantProvider {
    Claude,
    Codex,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    Standard,
    Yolo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLaunchSpec {
    pub command: String,
    pub args: Vec<String>,
}

/// Build a new-session launch without concatenating command strings.
///
/// Claude accepts a caller-provided UUID; Codex assigns its session ID after it
/// starts and must be captured from provider metadata.
pub fn prepare_new_session(
    provider: AssistantProvider,
    mode: SessionMode,
    model: Option<&str>,
    claude_session_id: Option<&str>,
) -> Result<ProviderLaunchSpec, String> {
    let mut args = model_args(provider, model);
    args.extend(mode_args(provider, mode));

    match provider {
        AssistantProvider::Claude => {
            let session_id = claude_session_id.ok_or_else(|| {
                "Claude requires a generated session id before a new session can start".to_string()
            })?;
            if !is_uuid(session_id) {
                return Err("Claude session id must be a UUID".to_string());
            }
            args.extend(["--session-id".to_string(), session_id.to_string()]);
            Ok(ProviderLaunchSpec {
                command: "claude".to_string(),
                args,
            })
        }
        AssistantProvider::Codex => Ok(ProviderLaunchSpec {
            command: "codex".to_string(),
            args,
        }),
    }
}

/// Build an explicit resume invocation. A failed resume must remain a failed
/// restore record; this adapter deliberately has no fresh-session fallback.
pub fn prepare_resume_session(
    provider: AssistantProvider,
    provider_session_id: &str,
    mode: SessionMode,
    model: Option<&str>,
) -> Result<ProviderLaunchSpec, String> {
    if provider_session_id.trim().is_empty() {
        return Err("Provider session id must not be empty".to_string());
    }

    let mut args = model_args(provider, model);
    args.extend(mode_args(provider, mode));
    match provider {
        AssistantProvider::Claude => {
            args.extend(["--resume".to_string(), provider_session_id.to_string()]);
            Ok(ProviderLaunchSpec {
                command: "claude".to_string(),
                args,
            })
        }
        AssistantProvider::Codex => {
            // `--model` and `--yolo` are root Codex options, so keep them
            // before the `resume` subcommand.
            args.push("resume".to_string());
            args.push(provider_session_id.to_string());
            Ok(ProviderLaunchSpec {
                command: "codex".to_string(),
                args,
            })
        }
    }
}

fn model_args(provider: AssistantProvider, model: Option<&str>) -> Vec<String> {
    let Some(model) = model.filter(|model| !model.trim().is_empty()) else {
        return Vec::new();
    };
    let flag = match provider {
        AssistantProvider::Claude | AssistantProvider::Codex => "--model",
    };
    vec![flag.to_string(), model.to_string()]
}

fn mode_args(provider: AssistantProvider, mode: SessionMode) -> Vec<String> {
    if mode != SessionMode::Yolo {
        return Vec::new();
    }
    let flag = match provider {
        AssistantProvider::Claude => "--dangerously-skip-permissions",
        AssistantProvider::Codex => "--yolo",
    };
    vec![flag.to_string()]
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

#[cfg(test)]
mod tests {
    use super::{prepare_new_session, prepare_resume_session, AssistantProvider, SessionMode};

    const UUID: &str = "123e4567-e89b-12d3-a456-426614174000";

    #[test]
    fn claude_new_session_uses_caller_generated_uuid() {
        let spec = prepare_new_session(
            AssistantProvider::Claude,
            SessionMode::Yolo,
            Some("sonnet"),
            Some(UUID),
        )
        .unwrap();

        assert_eq!(spec.command, "claude");
        assert_eq!(
            spec.args,
            vec![
                "--model",
                "sonnet",
                "--dangerously-skip-permissions",
                "--session-id",
                UUID
            ]
        );
    }

    #[test]
    fn codex_resume_is_explicit_and_never_a_fresh_launch() {
        let spec =
            prepare_resume_session(AssistantProvider::Codex, UUID, SessionMode::Standard, None)
                .unwrap();

        assert_eq!(spec.command, "codex");
        assert_eq!(spec.args, vec!["resume", UUID]);
    }

    #[test]
    fn codex_resume_keeps_global_options_before_the_subcommand() {
        let spec = prepare_resume_session(
            AssistantProvider::Codex,
            UUID,
            SessionMode::Yolo,
            Some("gpt-5"),
        )
        .unwrap();

        assert_eq!(
            spec.args,
            vec!["--model", "gpt-5", "--yolo", "resume", UUID]
        );
    }

    #[test]
    fn claude_rejects_a_missing_or_invalid_new_session_id() {
        assert!(
            prepare_new_session(AssistantProvider::Claude, SessionMode::Standard, None, None,)
                .is_err()
        );
        assert!(prepare_new_session(
            AssistantProvider::Claude,
            SessionMode::Standard,
            None,
            Some("not-a-uuid"),
        )
        .is_err());
    }
}
