mod backup;
mod focus;
mod learning;
#[cfg(test)]
#[path = "database_tests.rs"]
mod regression_tests;
mod sync_records;
mod tasks;

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Datelike, Local, TimeZone, Utc};
use parking_lot::Mutex;
use rusqlite::{
    Connection, OptionalExtension, Row, Transaction,
    backup::Backup,
    params,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::models::{
    AppSettings, CreateLearningResourceInput, CreateTaskInput, FocusHistoryPage, FocusHistoryQuery,
    FocusSession, FocusState, FocusStats, LearningEdge, LearningNode, LearningPack,
    LearningResource, SyncConflict, SyncSettings, SyncState, Tag, Task, TaskList, TaskOrderPatch,
    UpdateAppSettingsInput, UpdateLearningResourceInput, UpdateTaskInput, UpsertLearningNodeInput,
};
use crate::sync_clock::HybridClock;

const ACCENT: &str = "#c96442";
const SUCCESS: &str = "#247a48";
const INFO: &str = "#5d658c";
const WARNING: &str = "#9a681b";
const MAUVE: &str = "#8c5d79";

pub struct LearningGenerationStateUpdate<'a> {
    pub status: &'a str,
    pub provider: &'a str,
    pub model: Option<&'a str>,
    pub generation_id: Option<&'a str>,
    pub completed_sections: &'a [String],
    pub failed_sections: &'a [String],
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn local_date_key(date: DateTime<Local>) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

fn parse_json<T: serde::de::DeserializeOwned>(raw: &str, fallback: T) -> T {
    serde_json::from_str(raw).unwrap_or(fallback)
}

fn bool_from_i64(value: i64) -> bool {
    value != 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VectorRelation {
    Equal,
    LocalDominates,
    RemoteDominates,
    Concurrent,
}

fn row_version(row: &Map<String, Value>) -> HashMap<String, u64> {
    let mut vector = row
        .get("version_vector")
        .and_then(Value::as_str)
        .and_then(|raw| serde_json::from_str::<HashMap<String, u64>>(raw).ok())
        .unwrap_or_default();
    if vector.is_empty()
        && let Some(device) = row.get("device_id").and_then(Value::as_str)
        && !device.is_empty()
    {
        let revision = row.get("revision").and_then(Value::as_u64).unwrap_or(1);
        vector.insert(device.to_string(), revision.max(1));
    }
    vector
}

fn compare_vectors(local: &HashMap<String, u64>, remote: &HashMap<String, u64>) -> VectorRelation {
    let devices = local.keys().chain(remote.keys()).collect::<HashSet<_>>();
    let local_ge = devices.iter().all(|device| {
        local.get(*device).copied().unwrap_or(0) >= remote.get(*device).copied().unwrap_or(0)
    });
    let remote_ge = devices.iter().all(|device| {
        remote.get(*device).copied().unwrap_or(0) >= local.get(*device).copied().unwrap_or(0)
    });
    match (local_ge, remote_ge) {
        (true, true) => VectorRelation::Equal,
        (true, false) => VectorRelation::LocalDominates,
        (false, true) => VectorRelation::RemoteDominates,
        (false, false) => VectorRelation::Concurrent,
    }
}

fn clean_text(value: &str, max: usize) -> String {
    let without_tags = regex::Regex::new(r"(?is)<[^>]*>")
        .expect("valid sanitizing regex")
        .replace_all(value, " ");
    without_tags
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn clean_notes(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .chars()
        .filter(|character| *character == '\n' || *character == '\t' || !character.is_control())
        .take(20_000)
        .collect::<String>()
}

fn validate_priority(value: &str) -> Result<&str> {
    match value {
        "none" | "low" | "medium" | "high" => Ok(value),
        _ => bail!("优先级无效"),
    }
}

fn validate_task_status(value: &str) -> Result<&str> {
    match value {
        "open" | "completed" | "deleted" => Ok(value),
        _ => bail!("任务状态无效"),
    }
}

fn validate_resource_kind(value: &str) -> Result<&str> {
    match value {
        "document" | "tool" | "video" => Ok(value),
        _ => bail!("学习资源类型无效"),
    }
}

fn validate_node_status(value: &str) -> Result<&str> {
    match value {
        "pending" | "active" | "completed" => Ok(value),
        _ => bail!("路线节点状态无效"),
    }
}

fn validate_https_url(value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Ok(());
    }
    let parsed = url::Url::parse(value).context("链接格式无效")?;
    if parsed.scheme() != "https" {
        bail!("学习资源仅允许 HTTPS 链接");
    }
    if parsed.username() != "" || parsed.password().is_some() {
        bail!("链接不能包含用户名或密码");
    }
    Ok(())
}

fn search_url(base: &str, query: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
    format!("{base}{encoded}")
}

pub struct Database {
    connection: Mutex<Connection>,
    backup_dir: PathBuf,
    device_id: String,
    clock: Mutex<HybridClock>,
}

impl Database {
    pub fn open(
        path: PathBuf,
        legacy_database: Option<PathBuf>,
        legacy_json_paths: Vec<PathBuf>,
    ) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        if !path.exists()
            && let Some(source_path) = legacy_database.as_ref()
            && source_path.exists()
            && source_path != &path
        {
            let source = Connection::open_with_flags(
                source_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let mut destination = Connection::open(&path)?;
            let backup = Backup::new(&source, &mut destination)?;
            backup.run_to_completion(32, Duration::from_millis(25), None)?;
        }

        let connection = Connection::open(&path)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
        )?;
        let backup_dir = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("backups");
        let clock_path = backup_dir
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("hlc-state.json");
        let mut database = Self {
            connection: Mutex::new(connection),
            backup_dir,
            device_id: String::new(),
            clock: Mutex::new(HybridClock::load(clock_path.clone(), String::new())),
        };
        database.backup_before_v3_migration()?;
        database.migrate()?;
        database.ensure_defaults()?;
        database.device_id = database.setting("deviceId", String::new())?;
        if database.device_id.is_empty() {
            database.device_id = Uuid::new_v4().to_string();
            database.set_setting("deviceId", &database.device_id)?;
        }
        database.clock = Mutex::new(HybridClock::load(clock_path, database.device_id.clone()));
        database.recover_interrupted_work()?;
        database.import_legacy_sessions(&legacy_json_paths)?;
        Ok(database)
    }

    pub fn checkpoint(&self) -> Result<()> {
        self.connection
            .lock()
            .execute_batch("PRAGMA wal_checkpoint(FULL)")?;
        Ok(())
    }

    fn migrate(&self) -> Result<()> {
        let connection = self.connection.lock();
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS lists (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              color TEXT NOT NULL,
              position INTEGER NOT NULL DEFAULT 0,
              is_system INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              device_id TEXT NOT NULL DEFAULT '',
              hlc TEXT NOT NULL DEFAULT '',
              tombstone INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS tasks (
              id TEXT PRIMARY KEY,
              list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE RESTRICT,
              parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
              title TEXT NOT NULL,
              notes TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'open',
              scheduled_for TEXT,
              due_at TEXT,
              reminder_at TEXT,
              notified_at TEXT,
              priority TEXT NOT NULL DEFAULT 'none',
              estimate_minutes INTEGER,
              position REAL NOT NULL DEFAULT 0,
              completed_at TEXT,
              deleted_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              device_id TEXT NOT NULL DEFAULT '',
              hlc TEXT NOT NULL DEFAULT '',
              tombstone INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks(scheduled_for);
            CREATE INDEX IF NOT EXISTS idx_tasks_reminder ON tasks(reminder_at, notified_at);

            CREATE TABLE IF NOT EXISTS tags (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL UNIQUE COLLATE NOCASE,
              color TEXT NOT NULL,
              created_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              device_id TEXT NOT NULL DEFAULT '',
              hlc TEXT NOT NULL DEFAULT '',
              tombstone INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS task_tags (
              task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
              tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
              updated_at TEXT NOT NULL DEFAULT '',
              revision INTEGER NOT NULL DEFAULT 1,
              device_id TEXT NOT NULL DEFAULT '',
              hlc TEXT NOT NULL DEFAULT '',
              version_vector TEXT NOT NULL DEFAULT '{}',
              tombstone INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY(task_id, tag_id)
            );

            CREATE TABLE IF NOT EXISTS focus_sessions (
              id TEXT PRIMARY KEY,
              task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
              mode TEXT NOT NULL,
              started_at TEXT NOT NULL,
              ended_at TEXT NOT NULL,
              duration_seconds INTEGER NOT NULL,
              note TEXT NOT NULL DEFAULT '',
              source TEXT NOT NULL DEFAULT 'nudge',
              source_key TEXT UNIQUE,
              revision INTEGER NOT NULL DEFAULT 1,
              device_id TEXT NOT NULL DEFAULT '',
              hlc TEXT NOT NULL DEFAULT '',
              tombstone INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_focus_started ON focus_sessions(started_at);

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              device_id TEXT NOT NULL DEFAULT '',
              hlc TEXT NOT NULL DEFAULT '',
              version_vector TEXT NOT NULL DEFAULT '{}',
              tombstone INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS learning_packs (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
              status TEXT NOT NULL DEFAULT 'empty',
              provider TEXT NOT NULL DEFAULT 'offline',
              model TEXT,
              generation_id TEXT,
              completed_sections TEXT NOT NULL DEFAULT '[]',
              failed_sections TEXT NOT NULL DEFAULT '[]',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              device_id TEXT NOT NULL DEFAULT '',
              hlc TEXT NOT NULL DEFAULT '',
              tombstone INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS learning_resources (
              id TEXT PRIMARY KEY,
              pack_id TEXT NOT NULL REFERENCES learning_packs(id) ON DELETE CASCADE,
              task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              summary TEXT NOT NULL DEFAULT '',
              url TEXT NOT NULL DEFAULT '',
              platform TEXT NOT NULL DEFAULT '',
              language TEXT NOT NULL DEFAULT 'zh-CN',
              thumbnail_url TEXT,
              pinned INTEGER NOT NULL DEFAULT 0,
              verified INTEGER NOT NULL DEFAULT 0,
              source TEXT NOT NULL DEFAULT 'user',
              position INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              device_id TEXT NOT NULL DEFAULT '',
              hlc TEXT NOT NULL DEFAULT '',
              tombstone INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_learning_resources_pack ON learning_resources(pack_id, kind, position);

            CREATE TABLE IF NOT EXISTS learning_nodes (
              id TEXT PRIMARY KEY,
              pack_id TEXT NOT NULL REFERENCES learning_packs(id) ON DELETE CASCADE,
              task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
              kind TEXT NOT NULL DEFAULT 'custom',
              title TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              estimated_minutes INTEGER,
              status TEXT NOT NULL DEFAULT 'pending',
              x REAL NOT NULL DEFAULT 0,
              y REAL NOT NULL DEFAULT 0,
              position INTEGER NOT NULL DEFAULT 0,
              pinned INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              device_id TEXT NOT NULL DEFAULT '',
              hlc TEXT NOT NULL DEFAULT '',
              tombstone INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_learning_nodes_pack ON learning_nodes(pack_id, position);

            CREATE TABLE IF NOT EXISTS learning_edges (
              id TEXT PRIMARY KEY,
              pack_id TEXT NOT NULL REFERENCES learning_packs(id) ON DELETE CASCADE,
              source_node_id TEXT NOT NULL REFERENCES learning_nodes(id) ON DELETE CASCADE,
              target_node_id TEXT NOT NULL REFERENCES learning_nodes(id) ON DELETE CASCADE,
              relation TEXT NOT NULL DEFAULT 'depends-on',
              created_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              device_id TEXT NOT NULL DEFAULT '',
              hlc TEXT NOT NULL DEFAULT '',
              tombstone INTEGER NOT NULL DEFAULT 0,
              UNIQUE(pack_id, source_node_id, target_node_id)
            );

            CREATE TABLE IF NOT EXISTS sync_conflicts (
              id TEXT PRIMARY KEY,
              entity_type TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              local_payload TEXT NOT NULL,
              remote_payload TEXT NOT NULL,
              created_at TEXT NOT NULL,
              resolved_at TEXT
            );

            CREATE TABLE IF NOT EXISTS sync_queue (
              id TEXT PRIMARY KEY,
              entity_type TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              queued_at TEXT NOT NULL,
              UNIQUE(entity_type, entity_id)
            );
            "#,
        )?;

        for table in [
            "lists",
            "tasks",
            "tags",
            "focus_sessions",
            "learning_packs",
            "learning_resources",
            "learning_nodes",
            "learning_edges",
        ] {
            Self::ensure_column(&connection, table, "revision", "INTEGER NOT NULL DEFAULT 1")?;
            Self::ensure_column(&connection, table, "device_id", "TEXT NOT NULL DEFAULT ''")?;
            Self::ensure_column(&connection, table, "hlc", "TEXT NOT NULL DEFAULT ''")?;
            Self::ensure_column(
                &connection,
                table,
                "tombstone",
                "INTEGER NOT NULL DEFAULT 0",
            )?;
            Self::ensure_column(
                &connection,
                table,
                "version_vector",
                "TEXT NOT NULL DEFAULT '{}'",
            )?;
        }
        for (column, declaration) in [
            ("updated_at", "TEXT NOT NULL DEFAULT ''"),
            ("revision", "INTEGER NOT NULL DEFAULT 1"),
            ("device_id", "TEXT NOT NULL DEFAULT ''"),
            ("hlc", "TEXT NOT NULL DEFAULT ''"),
            ("version_vector", "TEXT NOT NULL DEFAULT '{}'"),
            ("tombstone", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            Self::ensure_column(&connection, "task_tags", column, declaration)?;
        }
        for (column, declaration) in [
            ("revision", "INTEGER NOT NULL DEFAULT 1"),
            ("device_id", "TEXT NOT NULL DEFAULT ''"),
            ("hlc", "TEXT NOT NULL DEFAULT ''"),
            ("version_vector", "TEXT NOT NULL DEFAULT '{}'"),
            ("tombstone", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            Self::ensure_column(&connection, "settings", column, declaration)?;
        }
        connection.pragma_update(None, "user_version", 3)?;
        Ok(())
    }

    fn backup_before_v3_migration(&self) -> Result<()> {
        let connection = self.connection.lock();
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let has_tasks: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks')",
            [],
            |row| row.get(0),
        )?;
        if version >= 3 || !has_tasks {
            return Ok(());
        }
        fs::create_dir_all(&self.backup_dir)?;
        let target_path = self
            .backup_dir
            .join(format!("nudge-pre-v3-{}.db", Utc::now().timestamp_millis()));
        let mut target = Connection::open(target_path)?;
        let backup = Backup::new(&connection, &mut target)?;
        backup.run_to_completion(128, Duration::from_millis(10), None)?;
        Ok(())
    }

    fn ensure_column(
        connection: &Connection,
        table: &str,
        column: &str,
        declaration: &str,
    ) -> Result<()> {
        let exists = connection
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|name| name == column);
        if !exists {
            connection.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
            ))?;
        }
        Ok(())
    }

    fn ensure_defaults(&self) -> Result<()> {
        let timestamp = now_iso();
        let connection = self.connection.lock();
        let lists = [
            ("inbox", "收集箱", ACCENT, 0_i64, 1_i64),
            ("personal", "个人", WARNING, 1, 0),
            ("study", "学习", SUCCESS, 2, 0),
            ("work", "工作", INFO, 3, 0),
        ];
        for (id, name, color, position, is_system) in lists {
            connection.execute(
                "INSERT OR IGNORE INTO lists (id, name, color, position, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![id, name, color, position, is_system, timestamp, timestamp],
            )?;
        }
        drop(connection);

        let defaults = AppSettings::default();
        self.set_setting_if_missing("dailyGoalMinutes", &defaults.daily_goal_minutes)?;
        self.set_setting_if_missing("longTermGoalHours", &defaults.long_term_goal_hours)?;
        self.set_setting_if_missing("longTermGoalLabel", &defaults.long_term_goal_label)?;
        self.set_setting_if_missing("pomodoroFocusMinutes", &defaults.pomodoro_focus_minutes)?;
        self.set_setting_if_missing("pomodoroBreakMinutes", &defaults.pomodoro_break_minutes)?;
        self.set_setting_if_missing("autoStart", &defaults.auto_start)?;
        self.set_setting_if_missing("closeToTray", &defaults.close_to_tray)?;
        self.set_setting_if_missing("globalShortcut", &defaults.global_shortcut)?;
        self.set_setting_if_missing("focusState", &FocusState::default())?;
        self.set_setting_if_missing("onboardingSeeded", &false)?;
        self.set_setting_if_missing("lastBackupDate", &String::new())?;
        self.set_setting_if_missing(
            "recommendationSettings",
            &crate::models::RecommendationSettings::default(),
        )?;
        self.set_setting_if_missing("syncState", &SyncState::default())?;
        self.set_setting_if_missing(
            "syncSettings",
            &json!({
                "enabled": false,
                "serverUrl": "",
                "username": "",
                "remotePath": "Nudge/nudge-v2.enc",
                "rememberPassphrase": false,
                "hasCredentials": false,
                "deviceId": "",
                "deviceName": ""
            }),
        )?;
        Ok(())
    }

    fn recover_interrupted_work(&self) -> Result<()> {
        let connection = self.connection.lock();
        let interrupted = {
            let mut statement = connection.prepare(
                "SELECT id FROM learning_packs WHERE status = 'generating' AND tombstone = 0",
            )?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in interrupted {
            connection.execute(
                "UPDATE learning_packs SET status = 'partial', generation_id = NULL, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
                params![now_iso(), self.device_id, self.hlc(), id],
            )?;
            self.queue_change(&connection, "learning_packs", &id)?;
        }
        drop(connection);
        let mut sync_state: SyncState = self.setting("syncState", SyncState::default())?;
        if sync_state.status == "syncing" {
            sync_state.status = "offline".into();
            sync_state.last_error = Some("上次同步被应用退出中断，可再次同步恢复。".into());
            self.set_sync_state(&sync_state)?;
        }
        Ok(())
    }

    fn set_setting_if_missing<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.connection.lock().execute(
            "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
            params![key, serde_json::to_string(value)?, now_iso()],
        )?;
        Ok(())
    }

    pub fn setting<T: serde::de::DeserializeOwned>(&self, key: &str, fallback: T) -> Result<T> {
        let raw = self
            .connection
            .lock()
            .query_row("SELECT value FROM settings WHERE key = ?", [key], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
        Ok(raw
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or(fallback))
    }

    pub fn set_setting<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<()> {
        let connection = self.connection.lock();
        let timestamp = now_iso();
        let hlc = self.hlc();
        connection.execute(
            r#"INSERT INTO settings (key, value, updated_at, revision, device_id, hlc, tombstone)
               VALUES (?, ?, ?, 1, ?, ?, 0)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
                 revision = settings.revision + 1, device_id = excluded.device_id, hlc = excluded.hlc,
                 tombstone = 0"#,
            params![key, serde_json::to_string(value)?, timestamp, self.device_id, hlc],
        )?;
        if self.device_id.is_empty() || !Self::portable_setting(key) {
            return Ok(());
        }
        self.bump_version(&connection, "settings", "key", key)?;
        self.queue_change_only(&connection, "settings", key)?;
        Ok(())
    }

    fn hlc(&self) -> String {
        self.clock.lock().tick()
    }

    fn portable_setting(key: &str) -> bool {
        matches!(
            key,
            "dailyGoalMinutes"
                | "longTermGoalHours"
                | "longTermGoalLabel"
                | "pomodoroFocusMinutes"
                | "pomodoroBreakMinutes"
        )
    }

    fn bump_version(
        &self,
        connection: &Connection,
        table: &str,
        key_column: &str,
        entity_id: &str,
    ) -> Result<()> {
        let raw: Option<String> = connection
            .query_row(
                &format!("SELECT version_vector FROM {table} WHERE {key_column} = ?"),
                [entity_id],
                |row| row.get(0),
            )
            .optional()?;
        let mut vector = raw
            .and_then(|value| serde_json::from_str::<HashMap<String, u64>>(&value).ok())
            .unwrap_or_default();
        *vector.entry(self.device_id.clone()).or_default() += 1;
        connection.execute(
            &format!("UPDATE {table} SET version_vector = ? WHERE {key_column} = ?"),
            params![serde_json::to_string(&vector)?, entity_id],
        )?;
        Ok(())
    }

    fn queue_change_only(
        &self,
        connection: &Connection,
        entity_type: &str,
        entity_id: &str,
    ) -> Result<()> {
        connection.execute(
            r#"INSERT INTO sync_queue (id, entity_type, entity_id, queued_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(entity_type, entity_id) DO UPDATE SET queued_at = excluded.queued_at"#,
            params![
                Uuid::new_v4().to_string(),
                entity_type,
                entity_id,
                now_iso()
            ],
        )?;
        Ok(())
    }

    fn queue_change(
        &self,
        connection: &Connection,
        entity_type: &str,
        entity_id: &str,
    ) -> Result<()> {
        self.bump_version(connection, entity_type, "id", entity_id)?;
        self.queue_change_only(connection, entity_type, entity_id)
    }

    pub fn pending_sync_changes(&self) -> Result<i64> {
        Ok(self
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM sync_queue", [], |row| row.get(0))?)
    }

    pub fn clear_sync_queue(&self) -> Result<()> {
        self.connection
            .lock()
            .execute("DELETE FROM sync_queue", [])?;
        Ok(())
    }

    pub fn get_settings(&self) -> Result<AppSettings> {
        let defaults = AppSettings::default();
        Ok(AppSettings {
            daily_goal_minutes: self.setting("dailyGoalMinutes", defaults.daily_goal_minutes)?,
            long_term_goal_hours: self
                .setting("longTermGoalHours", defaults.long_term_goal_hours)?,
            long_term_goal_label: self
                .setting("longTermGoalLabel", defaults.long_term_goal_label)?,
            pomodoro_focus_minutes: self
                .setting("pomodoroFocusMinutes", defaults.pomodoro_focus_minutes)?,
            pomodoro_break_minutes: self
                .setting("pomodoroBreakMinutes", defaults.pomodoro_break_minutes)?,
            auto_start: self.setting("autoStart", defaults.auto_start)?,
            close_to_tray: self.setting("closeToTray", defaults.close_to_tray)?,
            global_shortcut: self.setting("globalShortcut", defaults.global_shortcut)?,
        })
    }

    pub fn update_settings(&self, input: UpdateAppSettingsInput) -> Result<AppSettings> {
        if let Some(value) = input.daily_goal_minutes {
            if !(1..=1440).contains(&value) {
                bail!("每日目标需在 1–1440 分钟之间");
            }
            self.set_setting("dailyGoalMinutes", &value)?;
        }
        if let Some(value) = input.long_term_goal_hours {
            if !(1.0..=100_000.0).contains(&value) {
                bail!("长期目标数值无效");
            }
            self.set_setting("longTermGoalHours", &value)?;
        }
        if let Some(value) = input.long_term_goal_label {
            let value = clean_text(&value, 80);
            if value.is_empty() {
                bail!("长期目标名称不能为空");
            }
            self.set_setting("longTermGoalLabel", &value)?;
        }
        if let Some(value) = input.pomodoro_focus_minutes {
            if !(1..=180).contains(&value) {
                bail!("专注时长需在 1–180 分钟之间");
            }
            self.set_setting("pomodoroFocusMinutes", &value)?;
        }
        if let Some(value) = input.pomodoro_break_minutes {
            if !(1..=60).contains(&value) {
                bail!("休息时长需在 1–60 分钟之间");
            }
            self.set_setting("pomodoroBreakMinutes", &value)?;
        }
        if let Some(value) = input.auto_start {
            self.set_setting("autoStart", &value)?;
        }
        if let Some(value) = input.close_to_tray {
            self.set_setting("closeToTray", &value)?;
        }
        if let Some(value) = input.global_shortcut {
            let value = clean_text(&value, 80);
            if value.is_empty() {
                bail!("全局快捷键不能为空");
            }
            self.set_setting("globalShortcut", &value)?;
        }
        self.get_settings()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_database(name: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("nudge-test-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        (root.join("nudge.db"), root)
    }

    fn create_test_task(database: &Database, title: &str) -> Task {
        database
            .create_task(CreateTaskInput {
                title: title.into(),
                notes: None,
                list_id: Some("inbox".into()),
                parent_id: None,
                scheduled_for: None,
                due_at: None,
                reminder_at: None,
                priority: Some("none".into()),
                estimate_minutes: None,
                tag_names: vec![],
            })
            .unwrap()
    }

    #[test]
    fn fresh_database_starts_without_demo_tasks() {
        let (path, root) = temporary_database("empty");
        let database = Database::open(path, None, vec![]).unwrap();
        assert!(database.list_tasks().unwrap().is_empty());
        drop(database);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn version_vectors_detect_order_and_concurrency() {
        let vector = |entries: &[(&str, u64)]| {
            entries
                .iter()
                .map(|(device, revision)| ((*device).to_string(), *revision))
                .collect::<HashMap<_, _>>()
        };

        assert_eq!(
            compare_vectors(&vector(&[("a", 2)]), &vector(&[("a", 2)])),
            VectorRelation::Equal
        );
        assert_eq!(
            compare_vectors(&vector(&[("a", 3), ("b", 1)]), &vector(&[("a", 2)])),
            VectorRelation::LocalDominates
        );
        assert_eq!(
            compare_vectors(&vector(&[("a", 1)]), &vector(&[("a", 2), ("b", 1)])),
            VectorRelation::RemoteDominates
        );
        assert_eq!(
            compare_vectors(&vector(&[("a", 2)]), &vector(&[("b", 2)])),
            VectorRelation::Concurrent
        );
    }

    #[test]
    fn concurrent_remote_task_tag_tombstone_creates_conflict_and_wins_by_hlc() {
        let (path, root) = temporary_database("task-tag-tombstone");
        let database = Database::open(path, None, vec![]).unwrap();
        let task = database
            .create_task(CreateTaskInput {
                title: "同步标签".into(),
                notes: None,
                list_id: Some("inbox".into()),
                parent_id: None,
                scheduled_for: None,
                due_at: None,
                reminder_at: None,
                priority: Some("none".into()),
                estimate_minutes: None,
                tag_names: vec!["Rust".into()],
            })
            .unwrap();
        let snapshot = database.export_sync_snapshot().unwrap();
        let mut remote_link = snapshot["data"]["taskTags"][0].as_object().unwrap().clone();
        remote_link.insert("tombstone".into(), Value::from(1));
        remote_link.insert("revision".into(), Value::from(2));
        remote_link.insert("device_id".into(), Value::String("remote".into()));
        remote_link.insert(
            "hlc".into(),
            Value::String("9999999999999-0000000001-remote".into()),
        );
        remote_link.insert(
            "version_vector".into(),
            Value::String(r#"{"remote":1}"#.into()),
        );

        database
            .merge_sync_snapshot(&json!({
                "schemaVersion": 3,
                "data": { "taskTags": [Value::Object(remote_link)] }
            }))
            .unwrap();

        assert!(database.get_task(&task.id).unwrap().tags.is_empty());
        let conflicts = database.list_conflicts().unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].entity_type, "task_tags");
        drop(database);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn offline_learning_pack_is_idempotent_and_acyclic() {
        let (path, root) = temporary_database("learning");
        let database = Database::open(path, None, vec![]).unwrap();
        let task = create_test_task(&database, "学习 Rust");
        let first = database.ensure_learning_pack(&task.id).unwrap();
        let second = database.ensure_learning_pack(&task.id).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.nodes.len(), 5);
        assert_eq!(first.edges.len(), 4);
        let cycle =
            database.connect_learning_nodes(&first.id, &first.nodes[4].id, &first.nodes[0].id);
        assert!(cycle.is_err());
        drop(database);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deleted_roadmap_node_and_edge_can_be_restored_for_undo() {
        let (path, root) = temporary_database("roadmap-undo");
        let database = Database::open(path, None, vec![]).unwrap();
        let task = create_test_task(&database, "梳理路线图");
        let pack = database.ensure_learning_pack(&task.id).unwrap();
        let edge = pack.edges[0].clone();
        let node = pack
            .nodes
            .iter()
            .find(|node| node.id == edge.target_node_id)
            .unwrap()
            .clone();
        database.delete_learning_node(&node.id).unwrap();
        let restored = database
            .upsert_learning_node(
                &task.id,
                UpsertLearningNodeInput {
                    id: Some(node.id.clone()),
                    kind: Some(node.kind.clone()),
                    title: node.title.clone(),
                    description: node.description.clone(),
                    estimated_minutes: node.estimated_minutes,
                    status: Some(node.status.clone()),
                    x: Some(node.x),
                    y: Some(node.y),
                    position: Some(node.position),
                    pinned: Some(node.pinned),
                },
            )
            .unwrap();
        assert_eq!(restored.id, node.id);
        let restored_edge = database
            .connect_learning_nodes(&pack.id, &edge.source_node_id, &edge.target_node_id)
            .unwrap();
        assert_eq!(restored_edge.id, edge.id);
        drop(database);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn v3_backup_round_trip_keeps_learning_data() {
        let (source_path, source_root) = temporary_database("export");
        let source = Database::open(source_path, None, vec![]).unwrap();
        let task = create_test_task(&source, "备份学习包");
        source.ensure_learning_pack(&task.id).unwrap();
        let backup = source.export_json().unwrap();
        assert_eq!(backup["schemaVersion"], 3);

        let (target_path, target_root) = temporary_database("import");
        let target = Database::open(target_path, None, vec![]).unwrap();
        target.import_json(backup, "replace").unwrap();
        assert!(target.get_learning_pack(&task.id).unwrap().is_some());
        drop(source);
        drop(target);
        let _ = fs::remove_dir_all(source_root);
        let _ = fs::remove_dir_all(target_root);
    }

    #[test]
    fn v1_v2_and_v3_backups_import_idempotently() {
        let (source_path, source_root) = temporary_database("compat-export");
        let source = Database::open(source_path, None, vec![]).unwrap();
        let task = create_test_task(&source, "兼容旧备份");
        let exported = source.export_json().unwrap();

        for version in 1..=3 {
            let (target_path, target_root) = temporary_database(&format!("compat-v{version}"));
            let target = Database::open(target_path, None, vec![]).unwrap();
            let mut backup = exported.clone();
            backup["schemaVersion"] = Value::from(version);
            target.import_json(backup.clone(), "merge").unwrap();
            target.import_json(backup, "merge").unwrap();
            assert_eq!(target.get_task(&task.id).unwrap().title, "兼容旧备份");
            drop(target);
            let _ = fs::remove_dir_all(target_root);
        }

        drop(source);
        let _ = fs::remove_dir_all(source_root);
    }
}
