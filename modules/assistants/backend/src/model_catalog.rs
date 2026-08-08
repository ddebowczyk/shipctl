use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

const CLAUDE_MODEL_ALIASES: &[&str] = &["fable", "opus", "sonnet", "haiku"];

static APP_VERSION: OnceLock<String> = OnceLock::new();

/// Record the host application version, for the MCP `clientInfo` handshake.
///
/// This crate's own `CARGO_PKG_VERSION` is a `0.0.0` placeholder: the app
/// version is declared once, in `src-tauri/tauri.conf.json`, and reaches this
/// module through the `PackageInfo` Tauri resolves at plugin setup.
pub fn set_app_version(version: String) {
    let _ = APP_VERSION.set(version);
}

fn app_version() -> &'static str {
    APP_VERSION.get().map(String::as_str).unwrap_or("unknown")
}

pub fn query(provider: &str) -> Result<Vec<String>, String> {
    match provider {
        "claude" => Ok(query_claude_models()),
        "codex" => query_codex_models(),
        "antigravity" => query_first_available_cli_catalog(
            "agy",
            &[&["--list-models"], &["models"]],
            parse_line_models,
        ),
        "pi" => Ok(query_cli_models("pi", &["--list-models"], parse_pi_models)),
        "opencode" => Ok(query_cli_models("opencode", &["models"], parse_line_models)),
        _ => Err(format!("Unsupported assistant provider: {provider}")),
    }
}

/// Claude Code's picker is alias- and entitlement-driven. Its bootstrap request stores any
/// account-specific additions in `~/.claude.json`, so use that cache along with stable aliases.
fn query_claude_models() -> Vec<String> {
    let mut models = dirs::home_dir()
        .map(|home| home.join(".claude.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|contents| parse_claude_cached_models(&contents))
        .unwrap_or_default();

    for alias in CLAUDE_MODEL_ALIASES {
        if !models.iter().any(|model| model == alias) {
            models.push((*alias).to_string());
        }
    }

    models
}

fn parse_claude_cached_models(contents: &str) -> Vec<String> {
    let Ok(config) = serde_json::from_str::<serde_json::Value>(contents) else {
        return Vec::new();
    };

    config
        .get("additionalModelOptionsCache")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| option.get("value").and_then(serde_json::Value::as_str))
        .map(ToString::to_string)
        .collect()
}

/// Codex exposes the signed-in account's current model picker through app-server JSON-RPC.
fn query_codex_models() -> Result<Vec<String>, String> {
    let mut child = Command::new("codex")
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start Codex model catalog: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not open Codex model catalog input".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not open Codex model catalog output".to_string())?;
    let (sender, receiver) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });

    let result = (|| {
        writeln!(
            stdin,
            "{}",
            serde_json::json!({
                "id": 1,
                "method": "initialize",
                "params": { "clientInfo": { "name": "shipctl", "version": app_version() } }
            })
        )
        .map_err(|error| format!("Could not initialize Codex model catalog: {error}"))?;
        writeln!(
            stdin,
            "{}",
            serde_json::json!({
                "id": 2,
                "method": "model/list",
                "params": { "limit": 100, "cursor": null, "includeHidden": false }
            })
        )
        .map_err(|error| format!("Could not request Codex models: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("Could not request Codex models: {error}"))?;

        let deadline = Instant::now() + Duration::from_secs(7);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Timed out while loading the Codex model catalog".to_string());
            }

            let line = receiver
                .recv_timeout(remaining)
                .map_err(|_| "Codex closed before returning its model catalog".to_string())?;
            let Ok(response) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if response.get("id").and_then(serde_json::Value::as_i64) != Some(2) {
                continue;
            }
            if let Some(message) = response
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(serde_json::Value::as_str)
            {
                return Err(format!("Codex model catalog request failed: {message}"));
            }

            let models = parse_codex_models_response(&response);
            if models.is_empty() {
                return Err("Codex returned no selectable models".to_string());
            }
            return Ok(models);
        }
    })();

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();
    result
}

fn parse_codex_models_response(response: &serde_json::Value) -> Vec<String> {
    response
        .pointer("/result/data")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| model.get("hidden").and_then(serde_json::Value::as_bool) != Some(true))
        .filter_map(|model| model.get("model").and_then(serde_json::Value::as_str))
        .map(ToString::to_string)
        .collect()
}

fn query_first_available_cli_catalog(
    command: &str,
    argument_sets: &[&[&str]],
    parser: fn(&str) -> Vec<String>,
) -> Result<Vec<String>, String> {
    for arguments in argument_sets {
        let models = query_cli_models(command, arguments, parser);
        if !models.is_empty() {
            return Ok(models);
        }
    }
    Err(format!(
        "{command} did not expose a selectable model catalog"
    ))
}

fn query_cli_models(
    command: &str,
    arguments: &[&str],
    parser: fn(&str) -> Vec<String>,
) -> Vec<String> {
    let mut child = match Command::new(command)
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return Vec::new(),
    };

    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Vec::new();
    };
    let reader = thread::spawn(move || {
        let mut text = String::new();
        stdout.read_to_string(&mut text).map(|_| text).ok()
    });

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = reader.join().ok().flatten();
                if !status.success() {
                    return Vec::new();
                }
                return output.map(|text| parser(&text)).unwrap_or_default();
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Vec::new();
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Vec::new();
            }
        }
    }
}

fn parse_pi_models(text: &str) -> Vec<String> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            Some(format!("{}/{}", columns.next()?, columns.next()?))
        })
        .collect()
}

fn parse_line_models(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{parse_claude_cached_models, parse_codex_models_response, parse_pi_models};
    use serde_json::json;

    #[test]
    fn extracts_claude_bootstrap_model_values() {
        assert_eq!(
            parse_claude_cached_models(
                r#"{"additionalModelOptionsCache":[{"value":"claude-fable-5[1m]"},{"value":"claude-future-6"},{"label":"missing"}]}"#,
            ),
            ["claude-fable-5[1m]", "claude-future-6"]
        );
    }

    #[test]
    fn extracts_only_visible_codex_models() {
        let response = json!({
            "id": 2,
            "result": { "data": [
                {"model": "gpt-current", "hidden": false},
                {"model": "gpt-hidden", "hidden": true},
                {"model": "gpt-legacy"}
            ]}
        });
        assert_eq!(
            parse_codex_models_response(&response),
            ["gpt-current", "gpt-legacy"]
        );
    }

    #[test]
    fn parses_pi_table_catalog() {
        assert_eq!(
            parse_pi_models("provider model context\nopenai gpt-5 128k\nanthropic claude 200k\n"),
            ["openai/gpt-5", "anthropic/claude"]
        );
    }
}
