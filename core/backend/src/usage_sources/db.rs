use crate::state::DurableWriteBarrier;
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

const GENERIC_SCHEMA_VERSION: i64 = 12;

#[derive(Clone)]
pub struct UsageDb {
    pub conn: Arc<Mutex<Connection>>,
    pub(crate) durable_writes: DurableWriteBarrier,
}

impl UsageDb {
    /// Fallback: in-memory DB so the app still opens even if the disk DB fails.
    /// Usage data won't persist across restarts but nothing blocks.
    pub fn open_in_memory() -> Self {
        Self::open_in_memory_with_barrier(DurableWriteBarrier::default())
    }

    pub fn open_in_memory_with_barrier(durable_writes: DurableWriteBarrier) -> Self {
        let conn = Connection::open_in_memory()
            .expect("Failed to open in-memory SQLite — this should never fail");
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .ok();
        let _ = migrate(&conn);
        Self {
            conn: Arc::new(Mutex::new(conn)),
            durable_writes,
        }
    }

    pub fn open_at(db_path: &Path) -> Result<Self, String> {
        Self::open_at_with_barrier(db_path, DurableWriteBarrier::default())
    }

    pub fn open_at_with_barrier(
        db_path: &Path,
        durable_writes: DurableWriteBarrier,
    ) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create usage DB directory: {e}"))?;
        }
        let conn =
            Connection::open(db_path).map_err(|e| format!("Failed to open usage DB: {e}"))?;

        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|e| format!("Failed to set DB pragmas: {e}"))?;

        migrate(&conn)?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            durable_writes,
        })
    }
}

/// Upgrade historic usage databases to one generic source-record schema.
///
/// Earlier migrations embedded individual source repair rules in the host.
/// Those repairs now belong to the owning artifact. This migration deliberately
/// preserves every existing source namespace and makes only schema-level,
/// source-agnostic repairs.
fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS usage_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            session_id TEXT NOT NULL,
            project TEXT,
            model TEXT,
            timestamp INTEGER NOT NULL,
            tokens_input INTEGER NOT NULL DEFAULT 0,
            tokens_output INTEGER NOT NULL DEFAULT 0,
            tokens_cache_write INTEGER NOT NULL DEFAULT 0,
            tokens_cache_read INTEGER NOT NULL DEFAULT 0,
            tokens_thoughts INTEGER NOT NULL DEFAULT 0,
            tokens_total INTEGER NOT NULL DEFAULT 0,
            pricing_provider TEXT,
            recorded_cost REAL
         );
         CREATE TABLE IF NOT EXISTS usage_daily (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            date TEXT NOT NULL,
            model TEXT,
            project TEXT,
            tokens_input INTEGER NOT NULL DEFAULT 0,
            tokens_output INTEGER NOT NULL DEFAULT 0,
            tokens_cache_write INTEGER NOT NULL DEFAULT 0,
            tokens_cache_read INTEGER NOT NULL DEFAULT 0,
            tokens_thoughts INTEGER NOT NULL DEFAULT 0,
            tokens_total INTEGER NOT NULL DEFAULT 0,
            message_count INTEGER NOT NULL DEFAULT 0,
            pricing_provider TEXT,
            recorded_cost REAL,
            UNIQUE(provider, date, model, project)
         );",
    )
    .map_err(|e| format!("Failed to initialize generic usage schema: {e}"))?;

    ensure_columns(
        conn,
        "usage_messages",
        &[
            ("id", "INTEGER"),
            ("provider", "TEXT NOT NULL DEFAULT ''"),
            ("session_id", "TEXT NOT NULL DEFAULT ''"),
            ("project", "TEXT"),
            ("model", "TEXT"),
            ("timestamp", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_input", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_output", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_cache_write", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_cache_read", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_thoughts", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_total", "INTEGER NOT NULL DEFAULT 0"),
            ("pricing_provider", "TEXT"),
            ("recorded_cost", "REAL"),
        ],
    )?;
    ensure_columns(
        conn,
        "usage_daily",
        &[
            ("id", "INTEGER"),
            ("provider", "TEXT NOT NULL DEFAULT ''"),
            ("date", "TEXT NOT NULL DEFAULT ''"),
            ("model", "TEXT"),
            ("project", "TEXT"),
            ("tokens_input", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_output", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_cache_write", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_cache_read", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_thoughts", "INTEGER NOT NULL DEFAULT 0"),
            ("tokens_total", "INTEGER NOT NULL DEFAULT 0"),
            ("message_count", "INTEGER NOT NULL DEFAULT 0"),
            ("pricing_provider", "TEXT"),
            ("recorded_cost", "REAL"),
        ],
    )?;

    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_msg_provider_ts ON usage_messages(provider, timestamp);
         CREATE INDEX IF NOT EXISTS idx_msg_session ON usage_messages(provider, session_id);",
    )
    .map_err(|e| format!("Failed to initialize generic usage indexes: {e}"))?;

    let version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if version < GENERIC_SCHEMA_VERSION {
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            [GENERIC_SCHEMA_VERSION],
        )
        .map_err(|e| format!("Failed to record generic usage schema version: {e}"))?;
    }
    Ok(())
}

fn ensure_columns(conn: &Connection, table: &str, columns: &[(&str, &str)]) -> Result<(), String> {
    for (column, definition) in columns {
        ensure_column(conn, table, column, definition)?;
    }
    Ok(())
}

#[allow(
    clippy::let_and_return,
    reason = "the rusqlite row iterator must drop before the statement"
)]
fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let pragma = format!("PRAGMA table_info({table})");
    let mut stmt = match conn.prepare(&pragma) {
        Ok(stmt) => stmt,
        Err(_) => return false,
    };

    let rows = match stmt.query_map([], |row| row.get::<_, String>(1)) {
        Ok(rows) => rows,
        Err(_) => return false,
    };

    let exists = rows.filter_map(|row| row.ok()).any(|name| name == column);
    exists
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    if column_exists(conn, table, column) {
        return Ok(());
    }
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    conn.execute(&sql, [])
        .map_err(|e| format!("Failed adding column {table}.{column}: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_legacy_source_rows_without_source_specific_rewrites() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version (version) VALUES (7);
             CREATE TABLE usage_messages (provider TEXT, pricing_provider TEXT);
             CREATE TABLE usage_daily (provider TEXT, pricing_provider TEXT);
             INSERT INTO usage_messages (provider, pricing_provider) VALUES ('fixture-old', '');
             INSERT INTO usage_daily (provider, pricing_provider) VALUES ('fixture-old', NULL);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let message: (String, Option<String>, i64, String) = conn
            .query_row(
                "SELECT provider, pricing_provider, tokens_total, session_id FROM usage_messages",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let daily: (String, Option<String>, i64, String) = conn
            .query_row(
                "SELECT provider, pricing_provider, tokens_total, date FROM usage_daily",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
                row.get(0)
            })
            .unwrap();

        assert_eq!(
            message,
            (
                "fixture-old".to_string(),
                Some("".to_string()),
                0,
                "".to_string(),
            ),
        );
        assert_eq!(daily, ("fixture-old".to_string(), None, 0, "".to_string(),),);
        assert_eq!(version, GENERIC_SCHEMA_VERSION);
    }

    #[test]
    fn migration_is_idempotent_for_a_generic_database() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO usage_messages (provider, session_id, timestamp, tokens_total, pricing_provider)
             VALUES ('fixture-source', 'fixture-session', 42, 9, 'fixture-pricing')",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let records: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_messages", [], |row| row.get(0))
            .unwrap();
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(records, 1);
        assert_eq!(version, GENERIC_SCHEMA_VERSION);
    }
}
