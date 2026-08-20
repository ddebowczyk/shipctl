//! Generic, bounded local resources for plugin-declared assistant policy.
//!
//! Native code owns the home-directory and process safety boundaries only.
//! It does not interpret resource contents or associate them with a product.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const DEFAULT_FILE_BYTES: usize = 512 * 1024;
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_TREE_FILES: usize = 256;
const MAX_TREE_FILES: usize = 1_024;
const DEFAULT_TIMEOUT_MS: u64 = 7_000;
const MAX_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_COMMAND_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_COMMAND_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_COMMAND_INPUT_BYTES: usize = 1024 * 1024;
const MAX_WRITE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ARGUMENTS: usize = 128;
const MAX_ARGUMENT_LENGTH: usize = 4_096;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AssistantResourceReadRequest {
    File {
        resource_id: String,
        relative_path: String,
        #[serde(default)]
        max_bytes: Option<usize>,
    },
    Tree {
        resource_id: String,
        relative_path: String,
        #[serde(default)]
        max_files: Option<usize>,
        #[serde(default)]
        max_bytes_per_file: Option<usize>,
        #[serde(default)]
        extensions: Option<Vec<String>>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantResourceReadInput {
    pub request: AssistantResourceReadRequest,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantResourceWriteInput {
    pub resource_id: String,
    pub relative_path: String,
    pub content: String,
}

/// A generic response boundary for a bounded command invocation. The host only
/// matches a top-level JSONL correlation id; plugins interpret response data.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AssistantResourceExecuteCompletion {
    JsonlResponseId { id: serde_json::Value },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantResourceExecuteInput {
    pub resource_id: String,
    pub program: String,
    pub arguments: Vec<String>,
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub max_output_bytes: Option<usize>,
    #[serde(default)]
    pub completion: Option<AssistantResourceExecuteCompletion>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantResourceFile {
    pub relative_path: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AssistantResourceReadResult {
    File {
        resource_id: String,
        content: String,
    },
    Tree {
        resource_id: String,
        files: Vec<AssistantResourceFile>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantResourceExecuteResult {
    pub resource_id: String,
    pub stdout: String,
    pub stderr: String,
    pub status: i32,
}

pub fn read(input: AssistantResourceReadInput) -> Result<AssistantResourceReadResult, String> {
    match input.request {
        AssistantResourceReadRequest::File {
            resource_id,
            relative_path,
            max_bytes,
        } => {
            validate_resource_id(&resource_id)?;
            Ok(AssistantResourceReadResult::File {
                resource_id,
                content: read_text(
                    &relative_path,
                    bounded(max_bytes, DEFAULT_FILE_BYTES, MAX_FILE_BYTES),
                )?,
            })
        }
        AssistantResourceReadRequest::Tree {
            resource_id,
            relative_path,
            max_files,
            max_bytes_per_file,
            extensions,
        } => {
            validate_resource_id(&resource_id)?;
            Ok(AssistantResourceReadResult::Tree {
                resource_id,
                files: read_tree(
                    &relative_path,
                    bounded(max_files, DEFAULT_TREE_FILES, MAX_TREE_FILES),
                    bounded(max_bytes_per_file, DEFAULT_FILE_BYTES, MAX_FILE_BYTES),
                    extensions.as_deref(),
                )?,
            })
        }
    }
}

pub fn write(input: AssistantResourceWriteInput) -> Result<(), String> {
    validate_resource_id(&input.resource_id)?;
    if input.content.len() > MAX_WRITE_BYTES {
        return Err("Assistant resource write exceeds its declared byte bound".to_string());
    }
    let (home, candidate) = home_candidate(&input.relative_path)?;
    let parent = candidate
        .parent()
        .ok_or_else(|| "Assistant resource path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Assistant resource parent directory is unavailable".to_string())?;
    let resolved_parent = parent
        .canonicalize()
        .map_err(|_| "Assistant resource parent directory is unavailable".to_string())?;
    if !resolved_parent.starts_with(&home) {
        return Err("Assistant resource path escapes the user-home boundary".to_string());
    }
    if candidate.exists() {
        let resolved = candidate
            .canonicalize()
            .map_err(|_| "Assistant resource is unavailable".to_string())?;
        if !resolved.starts_with(&home) {
            return Err("Assistant resource path escapes the user-home boundary".to_string());
        }
        if !resolved.is_file() {
            return Err("Assistant resource write target is not a regular file".to_string());
        }
    }
    fs::write(candidate, input.content).map_err(|_| "Assistant resource write failed".to_string())
}

pub fn execute(
    input: AssistantResourceExecuteInput,
) -> Result<AssistantResourceExecuteResult, String> {
    validate_resource_id(&input.resource_id)?;
    validate_program(&input.program)?;
    if input.arguments.len() > MAX_ARGUMENTS {
        return Err("Assistant resource command has too many arguments".to_string());
    }
    for argument in &input.arguments {
        validate_argument(argument)?;
    }
    if input
        .stdin
        .as_ref()
        .is_some_and(|value| value.len() > MAX_COMMAND_INPUT_BYTES)
    {
        return Err("Assistant resource command input exceeds its byte bound".to_string());
    }
    if let Some(completion) = &input.completion {
        validate_completion(completion)?;
    }

    let timeout = Duration::from_millis(bounded_u64(
        input.timeout_ms,
        DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
    ));
    let output_bound = bounded(
        input.max_output_bytes,
        DEFAULT_COMMAND_OUTPUT_BYTES,
        MAX_COMMAND_OUTPUT_BYTES,
    );
    let completion = input.completion.clone();
    let expects_response = completion.is_some();
    let mut child = Command::new(&input.program)
        .args(&input.arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Assistant resource command could not be started".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Assistant resource command input is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Assistant resource command output is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Assistant resource command error output is unavailable".to_string())?;
    let stdout_reader = match completion {
        Some(AssistantResourceExecuteCompletion::JsonlResponseId { id }) => {
            thread::spawn(move || read_jsonl_response(stdout, output_bound, &id))
        }
        None => thread::spawn(move || read_bounded(stdout, output_bound)),
    };
    let stderr_reader = thread::spawn(move || read_bounded(stderr, output_bound));
    let input_result = if let Some(stdin_contents) = input.stdin.as_deref() {
        stdin
            .write_all(stdin_contents.as_bytes())
            .map_err(|_| "Assistant resource command input failed".to_string())
    } else {
        Ok(())
    };
    drop(stdin);
    if let Err(error) = input_result {
        let _ = child.kill();
        let _ = child.wait();
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
        return Err(error);
    }

    let started = Instant::now();
    if expects_response {
        loop {
            if stdout_reader.is_finished() {
                let _ = child.kill();
                let _ = child.wait();
                let stdout = join_text(stdout_reader);
                let stderr = join_text(stderr_reader);
                return Ok(AssistantResourceExecuteResult {
                    resource_id: input.resource_id,
                    stdout: stdout?,
                    stderr: stderr?,
                    // The host deliberately ended a long-lived process after
                    // it had returned the requested generic response.
                    status: 0,
                });
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let stdout = join_text(stdout_reader);
                    let stderr = join_text(stderr_reader);
                    return Ok(AssistantResourceExecuteResult {
                        resource_id: input.resource_id,
                        stdout: stdout?,
                        stderr: stderr?,
                        status: status.code().unwrap_or(-1),
                    });
                }
                Ok(None) if started.elapsed() >= timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err("Assistant resource command timed out".to_string());
                }
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err("Assistant resource command status is unavailable".to_string());
                }
            }
        }
    }
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("Assistant resource command timed out".to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err("Assistant resource command status is unavailable".to_string());
            }
        }
    };
    let stdout = join_text(stdout_reader)?;
    let stderr = join_text(stderr_reader)?;
    Ok(AssistantResourceExecuteResult {
        resource_id: input.resource_id,
        stdout,
        stderr,
        status: status.code().unwrap_or(-1),
    })
}

fn join_text(reader: thread::JoinHandle<Result<Vec<u8>, String>>) -> Result<String, String> {
    let bytes = reader
        .join()
        .map_err(|_| "Assistant resource command reader failed".to_string())??;
    String::from_utf8(bytes)
        .map_err(|_| "Assistant resource command output is not valid UTF-8".to_string())
}

fn read_bounded(reader: impl Read, maximum: usize) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    reader
        .take((maximum + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|_| "Assistant resource command output could not be read".to_string())?;
    if output.len() > maximum {
        Err("Assistant resource command output exceeds its declared byte bound".to_string())
    } else {
        Ok(output)
    }
}

fn read_jsonl_response(
    reader: impl Read,
    maximum: usize,
    expected_id: &serde_json::Value,
) -> Result<Vec<u8>, String> {
    let mut reader = BufReader::new(reader.take((maximum + 1) as u64));
    let mut output = Vec::new();
    loop {
        let start = output.len();
        let count = reader
            .read_until(b'\n', &mut output)
            .map_err(|_| "Assistant resource command output could not be read".to_string())?;
        if output.len() > maximum {
            return Err(
                "Assistant resource command output exceeds its declared byte bound".to_string(),
            );
        }
        if count == 0 {
            return Err(
                "Assistant resource command closed before its declared response".to_string(),
            );
        }
        let Ok(response) = serde_json::from_slice::<serde_json::Value>(&output[start..]) else {
            continue;
        };
        if response.get("id") == Some(expected_id) {
            return Ok(output);
        }
    }
}

fn read_text(relative_path: &str, maximum: usize) -> Result<String, String> {
    let (_, path) = resolved_existing_path(relative_path)?;
    let metadata =
        fs::metadata(&path).map_err(|_| "Assistant resource is unavailable".to_string())?;
    if !metadata.is_file() {
        return Err("Assistant resource is not a regular file".to_string());
    }
    if metadata.len() > maximum as u64 {
        return Err("Assistant resource exceeds its declared byte bound".to_string());
    }
    fs::read_to_string(path).map_err(|_| "Assistant resource is not valid UTF-8 text".to_string())
}

fn read_tree(
    relative_path: &str,
    maximum_files: usize,
    maximum_file_bytes: usize,
    extensions: Option<&[String]>,
) -> Result<Vec<AssistantResourceFile>, String> {
    let (home, candidate) = home_candidate(relative_path)?;
    let root = match candidate.canonicalize() {
        Ok(path) => path,
        // A plugin may take a pre-launch snapshot before its provider has
        // created a transcript directory. Treat that exact absence as the
        // empty tree; all other resolution failures remain visible.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Assistant resource is unavailable".to_string()),
    };
    if !root.starts_with(&home) {
        return Err("Assistant resource path escapes the user-home boundary".to_string());
    }
    if !root.is_dir() {
        return Err("Assistant resource tree is unavailable".to_string());
    }
    let allowed_extensions = extensions
        .unwrap_or_default()
        .iter()
        .map(|extension| {
            if extension.is_empty()
                || extension.len() > 32
                || !extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
            {
                Err("Assistant resource tree extension is invalid".to_string())
            } else {
                Ok(extension.as_str())
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let files = tree_files(&root, &allowed_extensions, maximum_files)?;
    files
        .into_iter()
        .map(|path| {
            let relative_path = path
                .strip_prefix(&root)
                .map_err(|_| "Assistant resource tree escaped its root".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            Ok(AssistantResourceFile {
                relative_path,
                content: read_text_path(&path, maximum_file_bytes)?,
            })
        })
        .collect()
}

fn tree_files(root: &Path, extensions: &[&str], maximum: usize) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|_| "Assistant resource tree is unavailable".to_string())?;
        for entry in entries {
            let entry = entry.map_err(|_| "Assistant resource tree is unavailable".to_string())?;
            let kind = entry
                .file_type()
                .map_err(|_| "Assistant resource tree is unavailable".to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                pending.push(path);
                continue;
            }
            if !kind.is_file()
                || (!extensions.is_empty()
                    && !path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extensions.contains(&extension)))
            {
                continue;
            }
            let resolved = path
                .canonicalize()
                .map_err(|_| "Assistant resource tree is unavailable".to_string())?;
            if !resolved.starts_with(root) {
                return Err("Assistant resource tree escaped its root".to_string());
            }
            files.push(resolved);
            if files.len() > maximum {
                return Err("Assistant resource tree exceeds its declared file bound".to_string());
            }
        }
    }
    files.sort();
    Ok(files)
}

fn read_text_path(path: &Path, maximum: usize) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "Assistant resource is unavailable".to_string())?;
    if !metadata.is_file() {
        return Err("Assistant resource is not a regular file".to_string());
    }
    if metadata.len() > maximum as u64 {
        return Err("Assistant resource exceeds its declared byte bound".to_string());
    }
    fs::read_to_string(path).map_err(|_| "Assistant resource is not valid UTF-8 text".to_string())
}

fn resolved_existing_path(relative_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let (home, candidate) = home_candidate(relative_path)?;
    let resolved = candidate
        .canonicalize()
        .map_err(|_| "Assistant resource is unavailable".to_string())?;
    if !resolved.starts_with(&home) {
        return Err("Assistant resource path escapes the user-home boundary".to_string());
    }
    Ok((home, resolved))
}

fn home_candidate(relative_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let relative = Path::new(relative_path);
    if relative_path.is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::CurDir
                    | Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
    {
        return Err("Assistant resource path must be safely relative to the user home".to_string());
    }
    let home = dirs::home_dir()
        .ok_or_else(|| "Assistant resource home directory is unavailable".to_string())?
        .canonicalize()
        .map_err(|_| "Assistant resource home directory is unavailable".to_string())?;
    Ok((home.clone(), home.join(relative)))
}

fn validate_resource_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        Err("Assistant resource identifier is invalid".to_string())
    } else {
        Ok(())
    }
}

fn validate_program(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value.chars().enumerate().all(|(index, character)| {
            (index == 0 && character.is_ascii_alphanumeric())
                || (index > 0
                    && (character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')))
        });
    if valid {
        Ok(())
    } else {
        Err("Assistant resource command program is invalid".to_string())
    }
}

fn validate_argument(value: &str) -> Result<(), String> {
    if value.len() > MAX_ARGUMENT_LENGTH || value.chars().any(char::is_control) {
        Err("Assistant resource command argument is invalid".to_string())
    } else {
        Ok(())
    }
}

fn validate_completion(completion: &AssistantResourceExecuteCompletion) -> Result<(), String> {
    let AssistantResourceExecuteCompletion::JsonlResponseId { id } = completion;
    let valid = match id {
        serde_json::Value::String(value) => {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        }
        serde_json::Value::Number(value) => value.as_i64().is_some() || value.as_u64().is_some(),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("Assistant resource command completion is invalid".to_string())
    }
}

fn bounded(value: Option<usize>, default: usize, maximum: usize) -> usize {
    value.unwrap_or(default).clamp(1, maximum)
}

fn bounded_u64(value: Option<u64>, default: u64, maximum: u64) -> u64 {
    value.unwrap_or(default).clamp(1, maximum)
}

#[cfg(test)]
mod tests {
    use super::{
        execute, read, read_jsonl_response, write, AssistantResourceExecuteCompletion,
        AssistantResourceExecuteInput, AssistantResourceReadInput, AssistantResourceReadRequest,
        AssistantResourceWriteInput,
    };
    use std::fs;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn refuses_parent_traversal_before_touching_the_home_directory() {
        let result = read(AssistantResourceReadInput {
            request: AssistantResourceReadRequest::File {
                resource_id: "fixture".to_string(),
                relative_path: "../outside".to_string(),
                max_bytes: None,
            },
        });
        assert!(result.is_err());
    }

    #[test]
    fn write_refuses_parent_traversal() {
        let result = write(AssistantResourceWriteInput {
            resource_id: "fixture".to_string(),
            relative_path: "../outside".to_string(),
            content: "no".to_string(),
        });
        assert!(result.is_err());
    }

    #[test]
    fn resource_id_rejects_control_characters() {
        let sequence = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let result = write(AssistantResourceWriteInput {
            resource_id: format!("fixture-{sequence}\n"),
            relative_path: "safe".to_string(),
            content: "no".to_string(),
        });
        assert!(result.is_err());
        let _ = fs::remove_file("safe");
    }

    #[test]
    fn missing_tree_is_an_empty_prelaunch_snapshot() {
        let sequence = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let result = read(AssistantResourceReadInput {
            request: AssistantResourceReadRequest::Tree {
                resource_id: "fixture".to_string(),
                relative_path: format!(".shipctl-missing-resource-{sequence}"),
                max_files: None,
                max_bytes_per_file: None,
                extensions: None,
            },
        });
        assert!(matches!(
            result,
            Ok(super::AssistantResourceReadResult::Tree { files, .. }) if files.is_empty()
        ));
    }

    #[test]
    fn jsonl_completion_returns_all_output_through_the_matching_response() {
        let output = concat!(
            "{\"id\":1,\"result\":{\"ready\":true}}\n",
            "{\"id\":2,\"result\":{\"data\":[\"opaque\"]}}\n",
            "{\"id\":3,\"result\":{}}\n",
        );
        let captured = read_jsonl_response(Cursor::new(output), 1_024, &serde_json::json!(2))
            .expect("matching JSONL response");
        assert_eq!(
            String::from_utf8(captured).expect("UTF-8 output"),
            concat!(
                "{\"id\":1,\"result\":{\"ready\":true}}\n",
                "{\"id\":2,\"result\":{\"data\":[\"opaque\"]}}\n",
            ),
        );
    }

    #[test]
    fn jsonl_completion_ends_a_long_lived_generic_process_after_its_response() {
        let result = execute(AssistantResourceExecuteInput {
            resource_id: "fixture-response".to_string(),
            program: "sh".to_string(),
            arguments: vec![
                "-c".to_string(),
                "printf '{\"id\":2,\"result\":{}}\\n'; exec tail -f /dev/null".to_string(),
            ],
            stdin: None,
            timeout_ms: Some(1_000),
            max_output_bytes: None,
            completion: Some(AssistantResourceExecuteCompletion::JsonlResponseId {
                id: serde_json::json!(2),
            }),
        })
        .expect("generic response completion succeeds");

        assert_eq!(result.status, 0);
        assert_eq!(result.stdout, "{\"id\":2,\"result\":{}}\n");
    }
}
