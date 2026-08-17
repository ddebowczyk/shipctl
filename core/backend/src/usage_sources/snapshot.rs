use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::backup::{Backup, StepResult};
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use shipctl_module_api::{
    CapturedSnapshotEntry, SnapshotClassification, SnapshotEntryDeclaration, SnapshotProvider,
};

pub struct UsageSnapshotProvider {
    path: PathBuf,
}

impl UsageSnapshotProvider {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl SnapshotProvider for UsageSnapshotProvider {
    fn id(&self) -> &'static str {
        "usage.database"
    }

    fn schema_version(&self) -> u32 {
        1
    }

    fn entries(&self) -> Vec<SnapshotEntryDeclaration> {
        vec![
            SnapshotEntryDeclaration {
                id: "database",
                classification: SnapshotClassification::Portable,
                source_paths: vec![PathBuf::from("usage.sqlite3")],
                target_path: Some(PathBuf::from("usage.sqlite3")),
                redaction: "coherent SQLite backup; no provider credentials",
            },
            SnapshotEntryDeclaration {
                id: "sqlite_runtime",
                classification: SnapshotClassification::LiveOnly,
                source_paths: vec![
                    PathBuf::from("usage.sqlite3-shm"),
                    PathBuf::from("usage.sqlite3-wal"),
                    PathBuf::from("usage.sqlite3-journal"),
                ],
                target_path: None,
                redaction: "SQLite WAL, shared-memory, and rollback files are never copied",
            },
            SnapshotEntryDeclaration {
                id: "transcript_sources",
                classification: SnapshotClassification::ReferenceOnly,
                source_paths: Vec::new(),
                target_path: None,
                redaction: "assistant transcript sources remain external",
            },
        ]
    }

    fn capture(&self) -> Result<Vec<CapturedSnapshotEntry>, String> {
        let payload = if self.path.exists() {
            Some(online_backup(&self.path)?)
        } else {
            None
        };
        Ok(vec![
            CapturedSnapshotEntry {
                id: "database",
                decision: if payload.is_some() {
                    "included_via_sqlite_backup".to_string()
                } else {
                    "source_absent".to_string()
                },
                payload,
            },
            excluded("sqlite_runtime"),
            excluded("transcript_sources"),
        ])
    }

    fn validate_payload(&self, entry_id: &str, payload: &[u8]) -> Result<(), String> {
        if entry_id != "database" {
            return Err(format!("Unknown usage.database payload {entry_id}"));
        }
        validate_database_bytes(payload)
    }

    fn canonical_payload(&self, entry_id: &str, payload: &[u8]) -> Result<Vec<u8>, String> {
        if entry_id != "database" {
            return Err(format!("Unknown usage.database payload {entry_id}"));
        }
        canonical_database_bytes(payload)
    }
}

fn online_backup(source_path: &Path) -> Result<Vec<u8>, String> {
    let temporary = temporary_path(source_path, "snapshot");
    let result = (|| {
        let source = Connection::open(source_path)
            .map_err(|error| format!("Could not open usage database for backup: {error}"))?;
        let mut destination = Connection::open(&temporary)
            .map_err(|error| format!("Could not create usage database backup: {error}"))?;
        let backup = Backup::new(&source, &mut destination)
            .map_err(|error| format!("Could not initialize SQLite backup: {error}"))?;
        if backup
            .step(-1)
            .map_err(|error| format!("SQLite backup failed: {error}"))?
            != StepResult::Done
        {
            return Err("SQLite backup could not acquire a coherent read point".to_string());
        }
        drop(backup);
        drop(destination);
        fs::read(&temporary).map_err(|error| format!("Could not read SQLite backup: {error}"))
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn validate_database_bytes(payload: &[u8]) -> Result<(), String> {
    let base = std::env::temp_dir().join("shipctl-state-validation.sqlite3");
    let temporary = temporary_path(&base, "verify");
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("Could not stage usage database validation: {error}"))?;
        file.write_all(payload)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Could not stage usage database validation: {error}"))?;
        drop(file);
        let connection = Connection::open(&temporary)
            .map_err(|error| format!("Restored usage database is invalid: {error}"))?;
        let integrity: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|error| format!("Could not verify restored usage database: {error}"))?;
        if integrity != "ok" {
            return Err(format!(
                "Restored usage database failed integrity check: {integrity}"
            ));
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn canonical_database_bytes(payload: &[u8]) -> Result<Vec<u8>, String> {
    let base = std::env::temp_dir().join("shipctl-state-canonical.sqlite3");
    let temporary = temporary_path(&base, "canonical");
    let result = (|| {
        stage_database_payload(&temporary, payload)?;
        let connection = Connection::open(&temporary).map_err(|error| {
            format!("Could not open usage database for canonicalization: {error}")
        })?;
        canonicalize_connection(&connection)
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn stage_database_payload(path: &Path, payload: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Could not stage usage database: {error}"))?;
    file.write_all(payload)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Could not stage usage database: {error}"))
}

/// Serialize SQLite's logical schema and values without page layout, WAL
/// position, row insertion order, or other storage-engine artifacts.
fn canonicalize_connection(connection: &Connection) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut schema = connection
        .prepare(
            "SELECT type, name, tbl_name, sql
             FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_autoindex_%'
             ORDER BY type, name, tbl_name, sql",
        )
        .map_err(|error| format!("Could not inspect usage database schema: {error}"))?;
    let schema_rows = schema
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| format!("Could not read usage database schema: {error}"))?;
    for row in schema_rows {
        let (kind, name, table, sql) =
            row.map_err(|error| format!("Could not decode usage database schema: {error}"))?;
        append_bytes(&mut output, kind.as_bytes());
        append_bytes(&mut output, name.as_bytes());
        append_bytes(&mut output, table.as_bytes());
        append_bytes(&mut output, sql.as_deref().unwrap_or("").as_bytes());
    }
    drop(schema);

    let mut table_statement = connection
        .prepare(
            "SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name != 'sqlite_schema'
             ORDER BY name",
        )
        .map_err(|error| format!("Could not enumerate usage database tables: {error}"))?;
    let table_names = table_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Could not read usage database tables: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode usage database table name: {error}"))?;
    drop(table_statement);

    for table in table_names {
        append_bytes(&mut output, table.as_bytes());
        let columns = connection
            .prepare("SELECT name FROM pragma_table_xinfo(?1) ORDER BY cid")
            .and_then(|mut statement| {
                statement
                    .query_map([&table], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|error| format!("Could not inspect usage table {table}: {error}"))?;
        for column in &columns {
            append_bytes(&mut output, column.as_bytes());
        }
        let projection = columns
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!("SELECT {projection} FROM {}", quote_identifier(&table));
        let mut statement = connection
            .prepare(&query)
            .map_err(|error| format!("Could not prepare usage table {table}: {error}"))?;
        let column_count = statement.column_count();
        let mut rows = statement
            .query([])
            .map_err(|error| format!("Could not query usage table {table}: {error}"))?;
        let mut encoded_rows = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("Could not read usage table {table}: {error}"))?
        {
            let mut encoded = Vec::new();
            for index in 0..column_count {
                encode_value(
                    &mut encoded,
                    row.get_ref(index).map_err(|error| {
                        format!("Could not decode usage table {table}: {error}")
                    })?,
                );
            }
            encoded_rows.push(encoded);
        }
        encoded_rows.sort();
        for encoded in encoded_rows {
            append_bytes(&mut output, &encoded);
        }
    }
    Ok(output)
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn append_bytes(output: &mut Vec<u8>, value: &[u8]) {
    output.extend_from_slice(&(value.len() as u64).to_be_bytes());
    output.extend_from_slice(value);
}

fn encode_value(output: &mut Vec<u8>, value: ValueRef<'_>) {
    match value {
        ValueRef::Null => output.push(0),
        ValueRef::Integer(value) => {
            output.push(1);
            output.extend_from_slice(&value.to_be_bytes());
        }
        ValueRef::Real(value) => {
            output.push(2);
            output.extend_from_slice(&value.to_bits().to_be_bytes());
        }
        ValueRef::Text(value) => {
            output.push(3);
            append_bytes(output, value);
        }
        ValueRef::Blob(value) => {
            output.push(4);
            append_bytes(output, value);
        }
    }
}

fn temporary_path(base: &Path, purpose: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let parent = base.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(
        ".usage-{purpose}-{}-{nonce}.sqlite3",
        std::process::id()
    ))
}

fn excluded(id: &'static str) -> CapturedSnapshotEntry {
    CapturedSnapshotEntry {
        id,
        payload: None,
        decision: "excluded_by_classification".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_sources::UsageDb;

    #[test]
    fn captures_a_coherent_database_including_wal_commits() {
        let source_path = temporary_path(
            &std::env::temp_dir().join("shipctl-usage-snapshot-test.sqlite3"),
            "source",
        );
        let restored_path = temporary_path(&source_path, "restored");
        let db = UsageDb::open_at(&source_path).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO usage_messages (
                    provider, session_id, timestamp, tokens_input, tokens_output, tokens_total
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                ("codex", "snapshot-proof", 1_i64, 2_i64, 3_i64, 5_i64),
            )
            .unwrap();

        let source_provider = UsageSnapshotProvider::new(source_path.clone());
        let captured = source_provider.capture().unwrap();
        let payload = captured
            .iter()
            .find(|entry| entry.id == "database")
            .and_then(|entry| entry.payload.as_ref())
            .unwrap();
        validate_database_bytes(payload).unwrap();
        fs::write(&restored_path, payload).unwrap();

        let restored = Connection::open(&restored_path).unwrap();
        let total: i64 = restored
            .query_row(
                "SELECT tokens_total FROM usage_messages WHERE session_id = 'snapshot-proof'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(total, 5);

        drop(restored);
        let reopened = UsageDb::open_at(&restored_path).unwrap();
        let restored_provider = UsageSnapshotProvider::new(restored_path.clone());
        let restored_capture = restored_provider.capture().unwrap();
        let restored_payload = restored_capture
            .iter()
            .find(|entry| entry.id == "database")
            .and_then(|entry| entry.payload.as_ref())
            .unwrap();
        assert_eq!(
            source_provider
                .canonical_payload("database", payload)
                .unwrap(),
            restored_provider
                .canonical_payload("database", restored_payload)
                .unwrap()
        );

        drop(reopened);
        drop(db);
        for path in [
            source_path.clone(),
            source_path.with_extension("sqlite3-wal"),
            source_path.with_extension("sqlite3-shm"),
            restored_path,
        ] {
            let _ = fs::remove_file(path);
        }
    }
}
