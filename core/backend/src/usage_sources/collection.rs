//! Generic, permission-bounded resource reads for plugin-owned usage sources.
//!
//! This module deliberately has no product-provider names, paths, parsers, or
//! cache rules. The caller supplies a declarative request and owns interpreting
//! the returned bytes. Native code owns only the resource boundary and bounds.

use std::fs;
use std::path::{Component, Path, PathBuf};

use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde_json::{Map, Number, Value};
use url::Url;

use super::helpers::{home_join, run_command};
use super::types::{
    UsageSourceFile, UsageSourceHttpHeader, UsageSourceResourceRequest, UsageSourceResourceResult,
};

const DEFAULT_FILE_BYTES: usize = 512 * 1024;
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_TREE_FILES: usize = 256;
const MAX_TREE_FILES: usize = 1_024;
const DEFAULT_SQLITE_ROWS: usize = 2_000;
const MAX_SQLITE_ROWS: usize = 10_000;
const DEFAULT_HTTP_BYTES: usize = 512 * 1024;
const MAX_HTTP_BYTES: usize = 4 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 256 * 1024;
const MAX_COMMAND_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

pub fn read_resource(
    request: UsageSourceResourceRequest,
) -> Result<UsageSourceResourceResult, String> {
    validate_resource_id(resource_id(&request))?;
    match request {
        UsageSourceResourceRequest::File {
            resource_id,
            relative_path,
            max_bytes,
        } => Ok(UsageSourceResourceResult::File {
            resource_id,
            content: read_text(
                &relative_path,
                bounded(max_bytes, DEFAULT_FILE_BYTES, MAX_FILE_BYTES),
            )?,
        }),
        UsageSourceResourceRequest::Tree {
            resource_id,
            relative_path,
            max_files,
            max_bytes_per_file,
            extensions,
        } => Ok(UsageSourceResourceResult::Tree {
            resource_id,
            files: read_tree(
                &relative_path,
                bounded(max_files, DEFAULT_TREE_FILES, MAX_TREE_FILES),
                bounded(max_bytes_per_file, DEFAULT_FILE_BYTES, MAX_FILE_BYTES),
                extensions.as_deref(),
            )?,
        }),
        UsageSourceResourceRequest::Sqlite {
            resource_id,
            relative_path,
            query,
            max_rows,
        } => Ok(UsageSourceResourceResult::Sqlite {
            resource_id,
            rows: read_sqlite(
                &relative_path,
                &query,
                bounded(max_rows, DEFAULT_SQLITE_ROWS, MAX_SQLITE_ROWS),
            )?,
        }),
        UsageSourceResourceRequest::Processes { resource_id } => {
            Ok(UsageSourceResourceResult::Processes {
                resource_id,
                output: bounded_command("ps", &["-axo", "pid=,command="])?,
            })
        }
        UsageSourceResourceRequest::ListeningPorts { resource_id } => {
            Ok(UsageSourceResourceResult::ListeningPorts {
                resource_id,
                output: bounded_command("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"])?,
            })
        }
        UsageSourceResourceRequest::Http {
            resource_id,
            url,
            method,
            headers,
            body,
            max_bytes,
        } => {
            let (status, body) = read_http(
                &url,
                &method,
                headers.as_deref().unwrap_or_default(),
                body.as_deref(),
                bounded(max_bytes, DEFAULT_HTTP_BYTES, MAX_HTTP_BYTES),
            )?;
            Ok(UsageSourceResourceResult::Http {
                resource_id,
                status,
                body,
            })
        }
        UsageSourceResourceRequest::KeychainPassword {
            resource_id,
            service,
            account,
        } => Ok(UsageSourceResourceResult::KeychainPassword {
            resource_id,
            secret: read_keychain_password(&service, account.as_deref())?,
        }),
    }
}

fn resource_id(request: &UsageSourceResourceRequest) -> &str {
    match request {
        UsageSourceResourceRequest::File { resource_id, .. }
        | UsageSourceResourceRequest::Tree { resource_id, .. }
        | UsageSourceResourceRequest::Sqlite { resource_id, .. }
        | UsageSourceResourceRequest::Processes { resource_id }
        | UsageSourceResourceRequest::ListeningPorts { resource_id }
        | UsageSourceResourceRequest::Http { resource_id, .. }
        | UsageSourceResourceRequest::KeychainPassword { resource_id, .. } => resource_id,
    }
}

fn validate_resource_id(resource_id: &str) -> Result<(), String> {
    if resource_id.is_empty() || resource_id.chars().any(char::is_control) {
        return Err("Usage source resource identifier is invalid".to_string());
    }
    Ok(())
}

fn bounded(value: Option<usize>, default: usize, maximum: usize) -> usize {
    value.unwrap_or(default).clamp(1, maximum)
}

fn home_relative_path(relative_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let relative = Path::new(relative_path);
    if relative_path.is_empty()
        || relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::CurDir
                    | Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
    {
        return Err("Usage source path must be a safe user-home-relative path".to_string());
    }
    let home = home_join("")?;
    let candidate = home.join(relative);
    let resolved = candidate
        .canonicalize()
        .map_err(|_| "Usage source resource is unavailable".to_string())?;
    let home = home
        .canonicalize()
        .map_err(|_| "Usage source home directory is unavailable".to_string())?;
    if !resolved.starts_with(&home) {
        return Err("Usage source path escapes the user-home boundary".to_string());
    }
    Ok((home, resolved))
}

fn read_text(relative_path: &str, max_bytes: usize) -> Result<String, String> {
    let (_, path) = home_relative_path(relative_path)?;
    read_text_path(&path, max_bytes)
}

fn read_text_path(path: &Path, max_bytes: usize) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "Usage source resource is unavailable".to_string())?;
    if !metadata.is_file() {
        return Err("Usage source resource is not a regular file".to_string());
    }
    if metadata.len() > max_bytes as u64 {
        return Err("Usage source resource exceeds its declared byte bound".to_string());
    }
    fs::read_to_string(path)
        .map_err(|_| "Usage source resource is not valid UTF-8 text".to_string())
}

fn read_tree(
    relative_path: &str,
    max_files: usize,
    max_bytes_per_file: usize,
    extensions: Option<&[String]>,
) -> Result<Vec<UsageSourceFile>, String> {
    let (_, root) = home_relative_path(relative_path)?;
    if !root.is_dir() {
        return Err("Usage source tree is unavailable".to_string());
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
                Err("Usage source tree extension is invalid".to_string())
            } else {
                Ok(extension.as_str())
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let files = tree_files(&root, &allowed_extensions, max_files)?;
    files
        .into_iter()
        .map(|path| {
            let relative_path = path
                .strip_prefix(&root)
                .map_err(|_| "Usage source tree escaped its root".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            Ok(UsageSourceFile {
                relative_path,
                content: read_text_path(&path, max_bytes_per_file)?,
            })
        })
        .collect()
}

fn tree_files(
    root: &Path,
    allowed_extensions: &[&str],
    max_files: usize,
) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries =
            fs::read_dir(&directory).map_err(|_| "Usage source tree is unavailable".to_string())?;
        for entry in entries {
            let entry = entry.map_err(|_| "Usage source tree is unavailable".to_string())?;
            let file_type = entry
                .file_type()
                .map_err(|_| "Usage source tree is unavailable".to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file()
                || (!allowed_extensions.is_empty()
                    && !path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| allowed_extensions.contains(&extension)))
            {
                continue;
            }
            let resolved = path
                .canonicalize()
                .map_err(|_| "Usage source tree is unavailable".to_string())?;
            if !resolved.starts_with(root) {
                return Err("Usage source tree escaped its root".to_string());
            }
            files.push(resolved);
            if files.len() > max_files {
                return Err("Usage source tree exceeds its declared file bound".to_string());
            }
        }
    }
    files.sort();
    Ok(files)
}

fn read_sqlite(
    relative_path: &str,
    query: &str,
    max_rows: usize,
) -> Result<Vec<Map<String, Value>>, String> {
    let (_, path) = home_relative_path(relative_path)?;
    let normalized = query.trim();
    if !is_read_only_sqlite_query(normalized) {
        return Err("Usage source SQLite query must be one read-only statement".to_string());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Usage source SQLite resource is unavailable".to_string())?;
    let mut statement = connection
        .prepare(normalized)
        .map_err(|_| "Usage source SQLite query is invalid".to_string())?;
    let names = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>();
    let mut rows = statement
        .query([])
        .map_err(|_| "Usage source SQLite query failed".to_string())?;
    let mut values = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|_| "Usage source SQLite row read failed".to_string())?
    {
        if values.len() >= max_rows {
            return Err("Usage source SQLite query exceeds its declared row bound".to_string());
        }
        let mut value = Map::new();
        for (index, name) in names.iter().enumerate() {
            value.insert(
                name.clone(),
                sqlite_value(
                    row.get_ref(index)
                        .map_err(|_| "Usage source SQLite value is invalid".to_string())?,
                ),
            );
        }
        values.push(value);
    }
    Ok(values)
}

fn is_read_only_sqlite_query(query: &str) -> bool {
    let lower = query.to_ascii_lowercase();
    !query.is_empty()
        && !query.contains(';')
        && (lower.starts_with("select") || lower.starts_with("with"))
}

fn sqlite_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::Number(value.into()),
        ValueRef::Real(value) => Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        // Binary SQLite values are never a valid Usage source result. Keeping
        // them out of the API avoids turning the resource port into a general
        // file-exfiltration channel.
        ValueRef::Blob(_) => Value::Null,
    }
}

fn bounded_command(program: &str, args: &[&str]) -> Result<String, String> {
    let output = run_command(program, args)?;
    if output.len() > MAX_COMMAND_OUTPUT_BYTES {
        return Err("Usage source command exceeds its output bound".to_string());
    }
    Ok(output)
}

fn read_http(
    raw_url: &str,
    method: &str,
    headers: &[UsageSourceHttpHeader],
    body: Option<&str>,
    max_bytes: usize,
) -> Result<(u16, String), String> {
    let url = Url::parse(raw_url).map_err(|_| "Usage source HTTP URL is invalid".to_string())?;
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or_default();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if (scheme != "https" && !(scheme == "http" && loopback))
        || url.username() != ""
        || url.password().is_some()
    {
        return Err("Usage source HTTP destination is not permitted".to_string());
    }
    if !matches!(method, "GET" | "POST") {
        return Err("Usage source HTTP method is not permitted".to_string());
    }
    if body.is_some_and(|value| value.len() > MAX_HTTP_BODY_BYTES) {
        return Err("Usage source HTTP body exceeds its bound".to_string());
    }
    let mut args = vec![
        "-sS".to_string(),
        "--max-time".to_string(),
        "10".to_string(),
        "--max-filesize".to_string(),
        max_bytes.to_string(),
        "-X".to_string(),
        method.to_string(),
    ];
    for header in headers {
        if header.name.is_empty()
            || header.name.len() > 128
            || header.value.len() > 16 * 1024
            || header.name.contains(['\r', '\n'])
            || header.value.contains(['\r', '\n'])
        {
            return Err("Usage source HTTP header is invalid".to_string());
        }
        args.push("-H".to_string());
        args.push(format!("{}: {}", header.name, header.value));
    }
    if let Some(body) = body {
        args.push("--data-binary".to_string());
        args.push(body.to_string());
    }
    args.push("-w".to_string());
    args.push("\\n%{http_code}".to_string());
    args.push(raw_url.to_string());
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = bounded_command("curl", &refs)?;
    let Some((body, status)) = output.rsplit_once('\n') else {
        return Err("Usage source HTTP response is malformed".to_string());
    };
    let status = status
        .trim()
        .parse::<u16>()
        .map_err(|_| "Usage source HTTP status is invalid".to_string())?;
    Ok((status, body.to_string()))
}

fn read_keychain_password(service: &str, account: Option<&str>) -> Result<String, String> {
    if service.is_empty()
        || service.len() > 256
        || service.contains(['\r', '\n'])
        || account.is_some_and(|value| {
            value.is_empty() || value.len() > 256 || value.contains(['\r', '\n'])
        })
    {
        return Err("Usage source keychain reference is invalid".to_string());
    }
    let mut args = vec!["find-generic-password", "-s", service];
    if let Some(account) = account {
        args.extend(["-a", account]);
    }
    args.push("-w");
    let secret = run_command("security", &args)?;
    if secret.is_empty() {
        return Err("Usage source keychain credential is unavailable".to_string());
    }
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_paths_reject_traversal_and_absolute_paths() {
        for path in [".", "../secret", "/private/secret", "../../.ssh/id_rsa", ""] {
            assert!(home_relative_path(path).is_err(), "{path} should be denied");
        }
    }

    #[test]
    fn resource_identifiers_reject_empty_and_control_values() {
        for resource_id in ["", "line\nbreak"] {
            assert!(validate_resource_id(resource_id).is_err());
        }
        assert!(validate_resource_id("transcript").is_ok());
    }

    #[test]
    fn http_rejects_non_web_and_non_loopback_plaintext_destinations() {
        for url in [
            "file:///private/secret",
            "http://example.com",
            "ftp://example.com",
        ] {
            assert!(
                read_http(url, "GET", &[], None, 1).is_err(),
                "{url} should be denied"
            );
        }
    }

    #[test]
    fn sqlite_rejects_mutating_or_compound_queries() {
        for query in [
            "DELETE FROM records",
            "SELECT 1; DELETE FROM records",
            "PRAGMA database_list",
        ] {
            assert!(!is_read_only_sqlite_query(query));
        }
        assert!(is_read_only_sqlite_query("SELECT * FROM records"));
    }
}
