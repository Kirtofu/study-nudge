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
    AppSettings, CreateLearningResourceInput, CreateTaskInput, FocusSession, FocusState,
    FocusStats, LearningEdge, LearningNode, LearningPack, LearningResource, SyncConflict,
    SyncSettings, SyncState, Tag, Task, TaskList, UpdateAppSettingsInput,
    UpdateLearningResourceInput, UpdateTaskInput, UpsertLearningNodeInput,
};

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
        let mut database = Self {
            connection: Mutex::new(connection),
            backup_dir,
            device_id: String::new(),
        };
        database.migrate()?;
        database.ensure_defaults()?;
        database.device_id = database.setting("deviceId", String::new())?;
        if database.device_id.is_empty() {
            database.device_id = Uuid::new_v4().to_string();
            database.set_setting("deviceId", &database.device_id)?;
        }
        database.recover_interrupted_work()?;
        database.import_legacy_sessions(&legacy_json_paths)?;
        database.seed_onboarding_tasks()?;
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
              updated_at TEXT NOT NULL
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

        for table in ["lists", "tasks", "tags", "focus_sessions"] {
            Self::ensure_column(&connection, table, "revision", "INTEGER NOT NULL DEFAULT 1")?;
            Self::ensure_column(&connection, table, "device_id", "TEXT NOT NULL DEFAULT ''")?;
            Self::ensure_column(&connection, table, "hlc", "TEXT NOT NULL DEFAULT ''")?;
            Self::ensure_column(
                &connection,
                table,
                "tombstone",
                "INTEGER NOT NULL DEFAULT 0",
            )?;
        }
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
        self.connection.lock().execute(
            r#"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"#,
            params![key, serde_json::to_string(value)?, now_iso()],
        )?;
        Ok(())
    }

    fn hlc(&self) -> String {
        format!(
            "{:013}-0000-{}",
            Utc::now().timestamp_millis(),
            self.device_id
        )
    }

    fn queue_change(
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

    pub fn get_focus_state(&self) -> Result<FocusState> {
        self.setting("focusState", FocusState::default())
    }

    pub fn set_focus_state(&self, state: &FocusState) -> Result<()> {
        self.set_setting("focusState", state)
    }

    pub fn list_lists(&self) -> Result<Vec<TaskList>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, name, color, position, created_at, updated_at FROM lists WHERE tombstone = 0 ORDER BY position, name",
        )?;
        Ok(statement
            .query_map([], |row| {
                Ok(TaskList {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    position: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn create_list(&self, name: String) -> Result<TaskList> {
        let name = clean_text(&name, 80);
        if name.is_empty() {
            bail!("清单名称不能为空");
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now_iso();
        let connection = self.connection.lock();
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM lists WHERE tombstone = 0",
            [],
            |row| row.get(0),
        )?;
        let colors = [ACCENT, SUCCESS, INFO, WARNING, MAUVE];
        connection.execute(
            r#"INSERT INTO lists (id, name, color, position, is_system, created_at, updated_at, revision, device_id, hlc, tombstone)
               VALUES (?, ?, ?, ?, 0, ?, ?, 1, ?, ?, 0)"#,
            params![id, name, colors[count as usize % colors.len()], count, timestamp, timestamp, self.device_id, self.hlc()],
        )?;
        self.queue_change(&connection, "lists", &id)?;
        drop(connection);
        self.get_list(&id)
    }

    pub fn update_list(
        &self,
        id: &str,
        name: Option<String>,
        color: Option<String>,
    ) -> Result<TaskList> {
        let current = self.get_list(id)?;
        let name = name
            .map(|value| clean_text(&value, 80))
            .unwrap_or(current.name);
        if name.is_empty() {
            bail!("清单名称不能为空");
        }
        let color = color.unwrap_or(current.color);
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE lists SET name = ?, color = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![name, color, now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "lists", id)?;
        drop(connection);
        self.get_list(id)
    }

    pub fn delete_list(&self, id: &str) -> Result<()> {
        if id == "inbox" {
            bail!("收集箱不能删除");
        }
        self.get_list(id)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let timestamp = now_iso();
        let hlc = self.hlc();
        transaction.execute(
            "UPDATE tasks SET list_id = 'inbox', updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE list_id = ?",
            params![timestamp, self.device_id, hlc, id],
        )?;
        transaction.execute(
            "UPDATE lists SET tombstone = 1, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![timestamp, self.device_id, hlc, id],
        )?;
        self.queue_change(&transaction, "lists", id)?;
        transaction.commit()?;
        Ok(())
    }

    fn get_list(&self, id: &str) -> Result<TaskList> {
        self.connection
            .lock()
            .query_row(
                "SELECT id, name, color, position, created_at, updated_at FROM lists WHERE id = ? AND tombstone = 0",
                [id],
                |row| {
                    Ok(TaskList {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        color: row.get(2)?,
                        position: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!("找不到该清单"))
    }

    pub fn list_tags(&self) -> Result<Vec<Tag>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, name, color FROM tags WHERE tombstone = 0 ORDER BY name COLLATE NOCASE",
        )?;
        Ok(statement
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>> {
        self.list_tasks_internal(false)
    }

    fn list_tasks_internal(&self, include_deleted: bool) -> Result<Vec<Task>> {
        let connection = self.connection.lock();
        let filter = if include_deleted {
            "tombstone = 0"
        } else {
            "tombstone = 0 AND status != 'deleted'"
        };
        let mut statement = connection.prepare(&format!(
            r#"SELECT id, list_id, parent_id, title, notes, status, scheduled_for, due_at,
                      reminder_at, priority, estimate_minutes, position, completed_at, deleted_at,
                      created_at, updated_at FROM tasks WHERE {filter} ORDER BY position, created_at"#
        ))?;
        let mut tasks = statement
            .query_map([], |row| self.map_task_row(row))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut tag_statement = connection.prepare(
            r#"SELECT tt.task_id, t.id, t.name, t.color FROM task_tags tt
               JOIN tags t ON t.id = tt.tag_id WHERE t.tombstone = 0 ORDER BY t.name"#,
        )?;
        let tag_rows = tag_statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Tag {
                        id: row.get(1)?,
                        name: row.get(2)?,
                        color: row.get(3)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(tag_statement);
        drop(statement);
        drop(connection);

        let mut tags_by_task: HashMap<String, Vec<Tag>> = HashMap::new();
        for (task_id, tag) in tag_rows {
            tags_by_task.entry(task_id).or_default().push(tag);
        }
        for task in &mut tasks {
            task.tags = tags_by_task.remove(&task.id).unwrap_or_default();
        }

        let ids = tasks
            .iter()
            .map(|task| task.id.clone())
            .collect::<HashSet<_>>();
        let mut by_parent: HashMap<Option<String>, Vec<Task>> = HashMap::new();
        for mut task in tasks {
            if task
                .parent_id
                .as_ref()
                .is_some_and(|parent| !ids.contains(parent))
            {
                task.parent_id = None;
            }
            by_parent
                .entry(task.parent_id.clone())
                .or_default()
                .push(task);
        }

        fn attach(
            parent: Option<String>,
            by_parent: &mut HashMap<Option<String>, Vec<Task>>,
        ) -> Vec<Task> {
            let mut items = by_parent.remove(&parent).unwrap_or_default();
            for item in &mut items {
                item.subtasks = attach(Some(item.id.clone()), by_parent);
            }
            items
        }
        Ok(attach(None, &mut by_parent))
    }

    fn map_task_row(&self, row: &Row<'_>) -> rusqlite::Result<Task> {
        Ok(Task {
            id: row.get(0)?,
            list_id: row.get(1)?,
            parent_id: row.get(2)?,
            title: row.get(3)?,
            notes: row.get(4)?,
            status: row.get(5)?,
            scheduled_for: row.get(6)?,
            due_at: row.get(7)?,
            reminder_at: row.get(8)?,
            priority: row.get(9)?,
            estimate_minutes: row.get(10)?,
            position: row.get(11)?,
            completed_at: row.get(12)?,
            deleted_at: row.get(13)?,
            created_at: row.get(14)?,
            updated_at: row.get(15)?,
            tags: vec![],
            subtasks: vec![],
        })
    }

    pub fn get_task(&self, id: &str) -> Result<Task> {
        fn find<'a>(tasks: &'a [Task], id: &str) -> Option<&'a Task> {
            for task in tasks {
                if task.id == id {
                    return Some(task);
                }
                if let Some(found) = find(&task.subtasks, id) {
                    return Some(found);
                }
            }
            None
        }
        let tasks = self.list_tasks_internal(true)?;
        find(&tasks, id)
            .cloned()
            .ok_or_else(|| anyhow!("找不到该任务"))
    }

    pub fn create_task(&self, input: CreateTaskInput) -> Result<Task> {
        let title = clean_text(&input.title, 240);
        if title.is_empty() {
            bail!("请输入任务标题");
        }
        let notes = input
            .notes
            .map(|value| clean_text(&value, 20_000))
            .unwrap_or_default();
        let list_id = input.list_id.unwrap_or_else(|| "inbox".into());
        self.get_list(&list_id)?;
        let priority = input.priority.unwrap_or_else(|| "none".into());
        validate_priority(&priority)?;
        if input
            .estimate_minutes
            .is_some_and(|value| !(1..=100_000).contains(&value))
        {
            bail!("预计时长无效");
        }
        if let Some(parent) = input.parent_id.as_ref() {
            self.get_task(parent)?;
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now_iso();
        let connection = self.connection.lock();
        let max_position: f64 = connection.query_row(
            "SELECT COALESCE(MAX(position), 0) FROM tasks WHERE parent_id IS ?",
            [input.parent_id.as_deref()],
            |row| row.get(0),
        )?;
        connection.execute(
            r#"INSERT INTO tasks (
                 id, list_id, parent_id, title, notes, status, scheduled_for, due_at, reminder_at,
                 priority, estimate_minutes, position, created_at, updated_at, revision, device_id, hlc, tombstone
               ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)"#,
            params![id, list_id, input.parent_id, title, notes, input.scheduled_for, input.due_at,
                    input.reminder_at, priority, input.estimate_minutes, max_position + 1000.0,
                    timestamp, timestamp, self.device_id, self.hlc()],
        )?;
        self.replace_task_tags_locked(&connection, &id, &input.tag_names)?;
        self.queue_change(&connection, "tasks", &id)?;
        drop(connection);
        self.get_task(&id)
    }

    pub fn update_task(&self, id: &str, input: UpdateTaskInput) -> Result<Task> {
        self.get_task(id)?;
        let mut fields: Vec<String> = vec![];
        let mut values: Vec<SqlValue> = vec![];
        if let Some(title) = input.title {
            let title = clean_text(&title, 240);
            if title.is_empty() {
                bail!("任务标题不能为空");
            }
            fields.push("title = ?".into());
            values.push(title.into());
        }
        if let Some(notes) = input.notes {
            fields.push("notes = ?".into());
            values.push(clean_text(&notes, 20_000).into());
        }
        if let Some(list_id) = input.list_id {
            self.get_list(&list_id)?;
            fields.push("list_id = ?".into());
            values.push(list_id.into());
        }
        for (column, value) in [
            ("parent_id", input.parent_id),
            ("scheduled_for", input.scheduled_for),
            ("due_at", input.due_at),
            ("reminder_at", input.reminder_at),
        ] {
            if let Some(value) = value {
                fields.push(format!("{column} = ?"));
                values.push(value.map(SqlValue::Text).unwrap_or(SqlValue::Null));
                if column == "reminder_at" {
                    fields.push("notified_at = NULL".into());
                }
            }
        }
        if let Some(priority) = input.priority {
            validate_priority(&priority)?;
            fields.push("priority = ?".into());
            values.push(priority.into());
        }
        if let Some(estimate) = input.estimate_minutes {
            if estimate.is_some_and(|value| !(1..=100_000).contains(&value)) {
                bail!("预计时长无效");
            }
            fields.push("estimate_minutes = ?".into());
            values.push(estimate.map(SqlValue::Integer).unwrap_or(SqlValue::Null));
        }
        if let Some(status) = input.status {
            validate_task_status(&status)?;
            fields.push("status = ?".into());
            values.push(status.into());
        }

        let connection = self.connection.lock();
        if !fields.is_empty() {
            fields.extend([
                "updated_at = ?".into(),
                "revision = revision + 1".into(),
                "device_id = ?".into(),
                "hlc = ?".into(),
            ]);
            values.push(now_iso().into());
            values.push(self.device_id.clone().into());
            values.push(self.hlc().into());
            values.push(id.to_string().into());
            connection.execute(
                &format!("UPDATE tasks SET {} WHERE id = ?", fields.join(", ")),
                rusqlite::params_from_iter(values),
            )?;
        }
        if let Some(names) = input.tag_names {
            self.replace_task_tags_locked(&connection, id, &names)?;
        }
        self.queue_change(&connection, "tasks", id)?;
        drop(connection);
        self.get_task(id)
    }

    pub fn complete_task(&self, id: &str, completed: bool) -> Result<Task> {
        self.get_task(id)?;
        let timestamp = now_iso();
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE tasks SET status = ?, completed_at = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![if completed { "completed" } else { "open" }, if completed { Some(timestamp.clone()) } else { None }, timestamp, self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "tasks", id)?;
        drop(connection);
        self.get_task(id)
    }

    pub fn delete_task(&self, id: &str) -> Result<()> {
        self.get_task(id)?;
        let timestamp = now_iso();
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE tasks SET status = 'deleted', deleted_at = ?, tombstone = 1, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![timestamp, timestamp, self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "tasks", id)?;
        Ok(())
    }

    pub fn restore_task(&self, id: &str) -> Result<Task> {
        let connection = self.connection.lock();
        let exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?)",
            [id],
            |row| row.get(0),
        )?;
        if !exists {
            bail!("找不到该任务");
        }
        connection.execute(
            "UPDATE tasks SET status = 'open', deleted_at = NULL, tombstone = 0, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "tasks", id)?;
        drop(connection);
        self.get_task(id)
    }

    pub fn reorder_tasks(&self, ids: &[String]) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let timestamp = now_iso();
        let hlc = self.hlc();
        for (index, id) in ids.iter().enumerate() {
            transaction.execute(
                "UPDATE tasks SET position = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
                params![((index + 1) * 1000) as f64, timestamp, self.device_id, hlc, id],
            )?;
            self.queue_change(&transaction, "tasks", id)?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn replace_task_tags_locked(
        &self,
        connection: &Connection,
        task_id: &str,
        names: &[String],
    ) -> Result<()> {
        connection.execute("DELETE FROM task_tags WHERE task_id = ?", [task_id])?;
        let colors = [ACCENT, SUCCESS, INFO, WARNING, MAUVE];
        let clean_names = names
            .iter()
            .map(|name| clean_text(name, 40))
            .filter(|name| !name.is_empty())
            .collect::<HashSet<_>>()
            .into_iter()
            .take(8)
            .collect::<Vec<_>>();
        for (index, name) in clean_names.iter().enumerate() {
            let existing = connection
                .query_row(
                    "SELECT id FROM tags WHERE name = ? COLLATE NOCASE",
                    [name],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let tag_id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
            connection.execute(
                r#"INSERT OR IGNORE INTO tags (id, name, color, created_at, revision, device_id, hlc, tombstone)
                   VALUES (?, ?, ?, ?, 1, ?, ?, 0)"#,
                params![tag_id, name, colors[index % colors.len()], now_iso(), self.device_id, self.hlc()],
            )?;
            connection.execute(
                "INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)",
                params![task_id, tag_id],
            )?;
            self.queue_change(connection, "tags", &tag_id)?;
        }
        Ok(())
    }

    pub fn add_focus_session(&self, mut session: FocusSession) -> Result<FocusSession> {
        if session.id.is_empty() {
            session.id = Uuid::new_v4().to_string();
        }
        session.duration_seconds = session.duration_seconds.max(0);
        let connection = self.connection.lock();
        connection.execute(
            r#"INSERT OR IGNORE INTO focus_sessions (
                 id, task_id, mode, started_at, ended_at, duration_seconds, note, source, source_key,
                 revision, device_id, hlc, tombstone
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)"#,
            params![session.id, session.task_id, session.mode, session.started_at, session.ended_at,
                    session.duration_seconds, session.note, session.source, session.source_key,
                    self.device_id, self.hlc()],
        )?;
        let stored = connection
            .query_row(
                "SELECT id, task_id, mode, started_at, ended_at, duration_seconds, note, source, source_key FROM focus_sessions WHERE id = ? OR (? IS NOT NULL AND source_key = ?)",
                params![session.id, session.source_key, session.source_key],
                Self::map_focus_row,
            )
            .optional()?
            .ok_or_else(|| anyhow!("专注记录没有保存成功"))?;
        self.queue_change(&connection, "focus_sessions", &stored.id)?;
        Ok(stored)
    }

    fn map_focus_row(row: &Row<'_>) -> rusqlite::Result<FocusSession> {
        Ok(FocusSession {
            id: row.get(0)?,
            task_id: row.get(1)?,
            mode: row.get(2)?,
            started_at: row.get(3)?,
            ended_at: row.get(4)?,
            duration_seconds: row.get(5)?,
            note: row.get(6)?,
            source: row.get(7)?,
            source_key: row.get(8)?,
        })
    }

    pub fn get_focus_stats(&self) -> Result<FocusStats> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, task_id, mode, started_at, ended_at, duration_seconds, note, source, source_key FROM focus_sessions WHERE tombstone = 0 ORDER BY started_at DESC",
        )?;
        let sessions = statement
            .query_map([], Self::map_focus_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        drop(connection);

        let mut totals = HashMap::<String, i64>::new();
        let mut total_seconds = 0;
        for session in &sessions {
            if let Ok(started) = DateTime::parse_from_rfc3339(&session.started_at) {
                let key = local_date_key(started.with_timezone(&Local));
                *totals.entry(key).or_default() += session.duration_seconds;
            }
            total_seconds += session.duration_seconds;
        }
        let today = local_date_key(Local::now());
        let today_seconds = totals.get(&today).copied().unwrap_or_default();
        let mut cursor = Local::now().date_naive();
        if !totals.contains_key(&today) {
            cursor = cursor.pred_opt().unwrap_or(cursor);
        }
        let mut streak_days = 0;
        loop {
            let key = format!(
                "{:04}-{:02}-{:02}",
                cursor.year(),
                cursor.month(),
                cursor.day()
            );
            if !totals.contains_key(&key) {
                break;
            }
            streak_days += 1;
            cursor = cursor.pred_opt().unwrap_or(cursor);
        }
        let settings = self.get_settings()?;
        Ok(FocusStats {
            today_seconds,
            total_seconds,
            streak_days,
            daily_goal_minutes: settings.daily_goal_minutes,
            long_term_goal_hours: settings.long_term_goal_hours,
            long_term_goal_label: settings.long_term_goal_label,
            sessions: sessions.into_iter().take(60).collect(),
        })
    }

    pub fn due_reminders(&self) -> Result<Vec<(String, String, String)>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            r#"SELECT id, title, notes FROM tasks WHERE status = 'open' AND tombstone = 0
               AND reminder_at IS NOT NULL AND reminder_at <= ? AND notified_at IS NULL"#,
        )?;
        Ok(statement
            .query_map([now_iso()], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn mark_reminder_notified(&self, id: &str) -> Result<()> {
        self.connection.lock().execute(
            "UPDATE tasks SET notified_at = ? WHERE id = ?",
            params![now_iso(), id],
        )?;
        Ok(())
    }

    fn seed_onboarding_tasks(&self) -> Result<()> {
        if self.setting("onboardingSeeded", false)? {
            return Ok(());
        }
        let count: i64 =
            self.connection
                .lock()
                .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))?;
        if count == 0 {
            let today = local_date_key(Local::now());
            self.create_task(CreateTaskInput {
                title: "把第一件事记下来".into(),
                notes: Some("按 Ctrl+N，或直接使用上方的快速添加。".into()),
                list_id: Some("personal".into()),
                parent_id: None,
                scheduled_for: Some(today.clone()),
                due_at: None,
                reminder_at: None,
                priority: Some("medium".into()),
                estimate_minutes: Some(10),
                tag_names: vec!["开始".into()],
            })?;
            self.create_task(CreateTaskInput {
                title: "点击学习包，把任务变成可执行路线".into(),
                notes: Some("资料、视频与路线图都能离线编辑；联网推荐始终由你主动触发。".into()),
                list_id: Some("study".into()),
                parent_id: None,
                scheduled_for: Some(today.clone()),
                due_at: None,
                reminder_at: None,
                priority: Some("high".into()),
                estimate_minutes: Some(25),
                tag_names: vec!["学习包".into()],
            })?;
            self.create_task(CreateTaskInput {
                title: "开始一次 25 分钟专注".into(),
                notes: Some("点击任务右侧的计时按钮，专注记录会自动关联到任务。".into()),
                list_id: Some("study".into()),
                parent_id: None,
                scheduled_for: Some(today),
                due_at: None,
                reminder_at: None,
                priority: Some("none".into()),
                estimate_minutes: Some(25),
                tag_names: vec!["专注".into()],
            })?;
        }
        self.set_setting("onboardingSeeded", &true)
    }

    fn import_legacy_sessions(&self, paths: &[PathBuf]) -> Result<()> {
        for path in paths {
            if !path.exists() {
                continue;
            }
            let Ok(raw) = fs::read_to_string(path) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let entries = value.as_array().cloned().unwrap_or_else(|| vec![value]);
            for entry in entries {
                let Some(object) = entry.as_object() else {
                    continue;
                };
                let Some(date) = object.get("date").and_then(Value::as_str) else {
                    continue;
                };
                let hours = object.get("hours").and_then(Value::as_f64).unwrap_or(0.0);
                if hours <= 0.0 {
                    continue;
                }
                let time = object
                    .get("time")
                    .and_then(Value::as_str)
                    .unwrap_or("12:00");
                let note = object
                    .get("note")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let key_source = format!("{date}|{time}|{hours}|{note}");
                let source_key = hex::encode(Sha256::digest(key_source.as_bytes()));
                let Ok(naive) = chrono::NaiveDateTime::parse_from_str(
                    &format!("{date} {time}:00"),
                    "%Y-%m-%d %H:%M:%S",
                ) else {
                    continue;
                };
                let Some(started) = Local.from_local_datetime(&naive).single() else {
                    continue;
                };
                let duration_seconds = (hours * 3600.0).round() as i64;
                let ended = started + chrono::Duration::seconds(duration_seconds);
                let _ = self.add_focus_session(FocusSession {
                    id: Uuid::new_v4().to_string(),
                    task_id: None,
                    mode: "legacy".into(),
                    started_at: started.to_rfc3339(),
                    ended_at: ended.to_rfc3339(),
                    duration_seconds,
                    note: note.into(),
                    source: "study-nudge".into(),
                    source_key: Some(source_key),
                });
            }
        }
        Ok(())
    }

    pub fn get_learning_pack(&self, task_id: &str) -> Result<Option<LearningPack>> {
        let connection = self.connection.lock();
        let pack_row = connection
            .query_row(
                r#"SELECT id, task_id, status, provider, model, generation_id, completed_sections,
                          failed_sections, created_at, updated_at FROM learning_packs
                   WHERE task_id = ? AND tombstone = 0"#,
                [task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            id,
            task_id,
            status,
            provider,
            model,
            generation_id,
            completed,
            failed,
            created_at,
            updated_at,
        )) = pack_row
        else {
            return Ok(None);
        };

        let mut resource_statement = connection.prepare(
            r#"SELECT id, pack_id, task_id, kind, title, summary, url, platform, language,
                      thumbnail_url, pinned, verified, source, position, created_at, updated_at
               FROM learning_resources WHERE pack_id = ? AND tombstone = 0
               ORDER BY kind, pinned DESC, position, created_at"#,
        )?;
        let resources = resource_statement
            .query_map([&id], |row| {
                Ok(LearningResource {
                    id: row.get(0)?,
                    pack_id: row.get(1)?,
                    task_id: row.get(2)?,
                    kind: row.get(3)?,
                    title: row.get(4)?,
                    summary: row.get(5)?,
                    url: row.get(6)?,
                    platform: row.get(7)?,
                    language: row.get(8)?,
                    thumbnail_url: row.get(9)?,
                    pinned: bool_from_i64(row.get(10)?),
                    verified: bool_from_i64(row.get(11)?),
                    source: row.get(12)?,
                    position: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut node_statement = connection.prepare(
            r#"SELECT id, pack_id, task_id, kind, title, description, estimated_minutes, status,
                      x, y, position, pinned, created_at, updated_at FROM learning_nodes
               WHERE pack_id = ? AND tombstone = 0 ORDER BY position, created_at"#,
        )?;
        let nodes = node_statement
            .query_map([&id], |row| {
                Ok(LearningNode {
                    id: row.get(0)?,
                    pack_id: row.get(1)?,
                    task_id: row.get(2)?,
                    kind: row.get(3)?,
                    title: row.get(4)?,
                    description: row.get(5)?,
                    estimated_minutes: row.get(6)?,
                    status: row.get(7)?,
                    x: row.get(8)?,
                    y: row.get(9)?,
                    position: row.get(10)?,
                    pinned: bool_from_i64(row.get(11)?),
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut edge_statement = connection.prepare(
            r#"SELECT id, pack_id, source_node_id, target_node_id, relation, created_at
               FROM learning_edges WHERE pack_id = ? AND tombstone = 0 ORDER BY created_at"#,
        )?;
        let edges = edge_statement
            .query_map([&id], |row| {
                Ok(LearningEdge {
                    id: row.get(0)?,
                    pack_id: row.get(1)?,
                    source_node_id: row.get(2)?,
                    target_node_id: row.get(3)?,
                    relation: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(LearningPack {
            id,
            task_id,
            status,
            provider,
            model,
            generation_id,
            completed_sections: parse_json(&completed, vec![]),
            failed_sections: parse_json(&failed, vec![]),
            created_at,
            updated_at,
            resources,
            nodes,
            edges,
        }))
    }

    pub fn ensure_learning_pack(&self, task_id: &str) -> Result<LearningPack> {
        let task = self.get_task(task_id)?;
        if let Some(pack) = self.get_learning_pack(task_id)? {
            return Ok(pack);
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now_iso();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute(
            r#"INSERT INTO learning_packs (
                 id, task_id, status, provider, completed_sections, failed_sections, created_at, updated_at,
                 revision, device_id, hlc, tombstone
               ) VALUES (?, ?, 'ready', 'offline', '["resources","videos","roadmap"]', '[]', ?, ?, 1, ?, ?, 0)"#,
            params![id, task_id, timestamp, timestamp, self.device_id, self.hlc()],
        )?;
        self.insert_offline_template(&transaction, &id, &task)?;
        self.queue_change(&transaction, "learning_packs", &id)?;
        transaction.commit()?;
        drop(connection);
        self.get_learning_pack(task_id)?
            .ok_or_else(|| anyhow!("学习包没有创建成功"))
    }

    fn insert_offline_template(
        &self,
        transaction: &Transaction<'_>,
        pack_id: &str,
        task: &Task,
    ) -> Result<()> {
        let timestamp = now_iso();
        let query = &task.title;
        let resources = [
            (
                "document",
                format!("查找“{query}”官方文档"),
                "优先阅读维护者发布的入门、概念与 API 文档。".to_string(),
                search_url(
                    "https://www.google.com/search?q=",
                    &format!("{query} 官方 文档"),
                ),
                "Web",
            ),
            (
                "tool",
                format!("寻找“{query}”练习工具"),
                "从可立即动手的沙盒、题库或示例仓库开始。".to_string(),
                search_url(
                    "https://github.com/search?q=",
                    &format!("{query} tutorial examples"),
                ),
                "GitHub",
            ),
            (
                "video",
                format!("YouTube：{query}"),
                "搜索高质量完整课程；打开后可按时长和发布时间筛选。".to_string(),
                search_url("https://www.youtube.com/results?search_query=", query),
                "YouTube",
            ),
            (
                "video",
                format!("B站：{query}"),
                "优先选择有章节、配套资料和完整项目的系列视频。".to_string(),
                search_url("https://search.bilibili.com/all?keyword=", query),
                "哔哩哔哩",
            ),
        ];
        for (index, (kind, title, summary, url, platform)) in resources.into_iter().enumerate() {
            let resource_id = Uuid::new_v4().to_string();
            transaction.execute(
                r#"INSERT INTO learning_resources (
                     id, pack_id, task_id, kind, title, summary, url, platform, language, pinned,
                     verified, source, position, created_at, updated_at, revision, device_id, hlc, tombstone
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'zh-CN', 0, 0, 'local-template', ?, ?, ?, 1, ?, ?, 0)"#,
                params![resource_id, pack_id, task.id, kind, title, summary, url, platform,
                        (index + 1) as i64 * 1000, timestamp, timestamp, self.device_id, self.hlc()],
            )?;
            self.queue_change(transaction, "learning_resources", &resource_id)?;
        }

        let stages = [
            (
                "goal",
                "明确目标",
                format!("定义完成“{}”后要能独立做到什么。", task.title),
                20_i64,
            ),
            (
                "concept",
                "基础概念",
                "梳理核心术语、基本原理与常见误区。".into(),
                60,
            ),
            (
                "practice",
                "跟练",
                "跟随一个小而完整的示例，边做边记录问题。".into(),
                90,
            ),
            (
                "project",
                "独立实践",
                "脱离教程完成一个能验证目标的小作品。".into(),
                120,
            ),
            (
                "review",
                "复盘输出",
                "用笔记、讲解或清单总结收获与下一步。".into(),
                30,
            ),
        ];
        let mut previous: Option<String> = None;
        for (index, (kind, title, description, minutes)) in stages.into_iter().enumerate() {
            let node_id = Uuid::new_v4().to_string();
            transaction.execute(
                r#"INSERT INTO learning_nodes (
                     id, pack_id, task_id, kind, title, description, estimated_minutes, status,
                     x, y, position, pinned, created_at, updated_at, revision, device_id, hlc, tombstone
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?, 1, ?, ?, 0)"#,
                params![node_id, pack_id, task.id, kind, title, description, minutes,
                        24.0 + index as f64 * 32.0, 32.0 + index as f64 * 128.0,
                        (index + 1) as i64 * 1000, timestamp, timestamp, self.device_id, self.hlc()],
            )?;
            self.queue_change(transaction, "learning_nodes", &node_id)?;
            if let Some(source) = previous {
                let edge_id = Uuid::new_v4().to_string();
                transaction.execute(
                    r#"INSERT INTO learning_edges (
                         id, pack_id, source_node_id, target_node_id, relation, created_at,
                         revision, device_id, hlc, tombstone
                       ) VALUES (?, ?, ?, ?, 'depends-on', ?, 1, ?, ?, 0)"#,
                    params![
                        edge_id,
                        pack_id,
                        source,
                        node_id,
                        timestamp,
                        self.device_id,
                        self.hlc()
                    ],
                )?;
                self.queue_change(transaction, "learning_edges", &edge_id)?;
            }
            previous = Some(node_id);
        }
        Ok(())
    }

    pub fn set_learning_generation_state(
        &self,
        task_id: &str,
        update: LearningGenerationStateUpdate<'_>,
    ) -> Result<LearningPack> {
        let pack = self.ensure_learning_pack(task_id)?;
        let connection = self.connection.lock();
        connection.execute(
            r#"UPDATE learning_packs SET status = ?, provider = ?, model = ?, generation_id = ?,
               completed_sections = ?, failed_sections = ?, updated_at = ?, revision = revision + 1,
               device_id = ?, hlc = ? WHERE id = ?"#,
            params![
                update.status,
                update.provider,
                update.model,
                update.generation_id,
                serde_json::to_string(update.completed_sections)?,
                serde_json::to_string(update.failed_sections)?,
                now_iso(),
                self.device_id,
                self.hlc(),
                pack.id
            ],
        )?;
        self.queue_change(&connection, "learning_packs", &pack.id)?;
        drop(connection);
        self.get_learning_pack(task_id)?
            .ok_or_else(|| anyhow!("学习包不存在"))
    }

    pub fn replace_generated_section(
        &self,
        task_id: &str,
        section: &str,
        resources: &[CreateLearningResourceInput],
        nodes: &[UpsertLearningNodeInput],
    ) -> Result<()> {
        let pack = self.ensure_learning_pack(task_id)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let timestamp = now_iso();
        if section == "resources" || section == "videos" {
            let kind_filter = if section == "videos" {
                "video"
            } else {
                "document"
            };
            transaction.execute(
                r#"UPDATE learning_resources SET tombstone = 1, updated_at = ?, revision = revision + 1,
                   device_id = ?, hlc = ? WHERE pack_id = ? AND pinned = 0 AND source = 'ai' AND
                   ((? = 'video' AND kind = 'video') OR (? != 'video' AND kind != 'video'))"#,
                params![timestamp, self.device_id, self.hlc(), pack.id, kind_filter, kind_filter],
            )?;
            for (index, resource) in resources.iter().enumerate() {
                validate_resource_kind(&resource.kind)?;
                validate_https_url(&resource.url)?;
                let id = Uuid::new_v4().to_string();
                transaction.execute(
                    r#"INSERT INTO learning_resources (
                         id, pack_id, task_id, kind, title, summary, url, platform, language, thumbnail_url, pinned,
                         verified, source, position, created_at, updated_at, revision, device_id, hlc, tombstone
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ai', ?, ?, ?, 1, ?, ?, 0)"#,
                    params![id, pack.id, task_id, resource.kind, clean_text(&resource.title, 160),
                            clean_text(&resource.summary, 600), resource.url, clean_text(&resource.platform, 40),
                            clean_text(&resource.language, 20), resource.thumbnail_url,
                            resource.verified as i64, (index + 1) as i64 * 1000,
                            timestamp, timestamp, self.device_id, self.hlc()],
                )?;
                self.queue_change(&transaction, "learning_resources", &id)?;
            }
        } else if section == "roadmap" {
            transaction.execute(
                "UPDATE learning_edges SET tombstone = 1, revision = revision + 1, device_id = ?, hlc = ? WHERE pack_id = ?",
                params![self.device_id, self.hlc(), pack.id],
            )?;
            transaction.execute(
                "UPDATE learning_nodes SET tombstone = 1, revision = revision + 1, device_id = ?, hlc = ? WHERE pack_id = ? AND pinned = 0",
                params![self.device_id, self.hlc(), pack.id],
            )?;
            let mut previous: Option<String> = None;
            for (index, node) in nodes.iter().take(50).enumerate() {
                let id = Uuid::new_v4().to_string();
                let title = clean_text(&node.title, 120);
                if title.is_empty() {
                    continue;
                }
                let status = node.status.as_deref().unwrap_or("pending");
                validate_node_status(status)?;
                transaction.execute(
                    r#"INSERT INTO learning_nodes (
                         id, pack_id, task_id, kind, title, description, estimated_minutes, status,
                         x, y, position, pinned, created_at, updated_at, revision, device_id, hlc, tombstone
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, 0)"#,
                    params![id, pack.id, task_id, node.kind.as_deref().unwrap_or("custom"), title,
                            clean_text(&node.description, 1000), node.estimated_minutes, status,
                            node.x.unwrap_or(24.0), node.y.unwrap_or(32.0 + index as f64 * 128.0),
                            (index + 1) as i64 * 1000, timestamp, timestamp, self.device_id, self.hlc()],
                )?;
                self.queue_change(&transaction, "learning_nodes", &id)?;
                if let Some(source) = previous {
                    let edge_id = Uuid::new_v4().to_string();
                    transaction.execute(
                        r#"INSERT INTO learning_edges (id, pack_id, source_node_id, target_node_id, relation,
                           created_at, revision, device_id, hlc, tombstone) VALUES (?, ?, ?, ?, 'depends-on', ?, 1, ?, ?, 0)"#,
                        params![edge_id, pack.id, source, id, timestamp, self.device_id, self.hlc()],
                    )?;
                    self.queue_change(&transaction, "learning_edges", &edge_id)?;
                }
                previous = Some(id);
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn create_learning_resource(
        &self,
        task_id: &str,
        input: CreateLearningResourceInput,
    ) -> Result<LearningResource> {
        validate_resource_kind(&input.kind)?;
        validate_https_url(&input.url)?;
        let title = clean_text(&input.title, 160);
        if title.is_empty() {
            bail!("资源标题不能为空");
        }
        let pack = self.ensure_learning_pack(task_id)?;
        let connection = self.connection.lock();
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM learning_resources WHERE pack_id = ? AND kind = ? AND tombstone = 0",
            params![pack.id, input.kind],
            |row| row.get(0),
        )?;
        let limit = if input.kind == "video" { 12 } else { 20 };
        if count >= limit {
            bail!("这一栏已达到建议上限，请先整理现有内容");
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now_iso();
        connection.execute(
            r#"INSERT INTO learning_resources (
                 id, pack_id, task_id, kind, title, summary, url, platform, language, pinned, verified,
                 source, position, created_at, updated_at, revision, device_id, hlc, tombstone
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'user', ?, ?, ?, 1, ?, ?, 0)"#,
            params![id, pack.id, task_id, input.kind, title, clean_text(&input.summary, 600), input.url,
                    clean_text(&input.platform, 40), clean_text(&input.language, 20), (count + 1) * 1000,
                    timestamp, timestamp, self.device_id, self.hlc()],
        )?;
        self.queue_change(&connection, "learning_resources", &id)?;
        drop(connection);
        self.get_learning_resource(&id)
    }

    fn get_learning_resource(&self, id: &str) -> Result<LearningResource> {
        self.connection
            .lock()
            .query_row(
                r#"SELECT id, pack_id, task_id, kind, title, summary, url, platform, language,
                          thumbnail_url, pinned, verified, source, position, created_at, updated_at
                   FROM learning_resources WHERE id = ? AND tombstone = 0"#,
                [id],
                |row| {
                    Ok(LearningResource {
                        id: row.get(0)?,
                        pack_id: row.get(1)?,
                        task_id: row.get(2)?,
                        kind: row.get(3)?,
                        title: row.get(4)?,
                        summary: row.get(5)?,
                        url: row.get(6)?,
                        platform: row.get(7)?,
                        language: row.get(8)?,
                        thumbnail_url: row.get(9)?,
                        pinned: bool_from_i64(row.get(10)?),
                        verified: bool_from_i64(row.get(11)?),
                        source: row.get(12)?,
                        position: row.get(13)?,
                        created_at: row.get(14)?,
                        updated_at: row.get(15)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!("找不到该学习资源"))
    }

    pub fn update_learning_resource(
        &self,
        id: &str,
        input: UpdateLearningResourceInput,
    ) -> Result<LearningResource> {
        let current = self.get_learning_resource(id)?;
        let kind = input.kind.unwrap_or(current.kind);
        validate_resource_kind(&kind)?;
        let title = input
            .title
            .map(|value| clean_text(&value, 160))
            .unwrap_or(current.title);
        if title.is_empty() {
            bail!("资源标题不能为空");
        }
        let url = input.url.unwrap_or(current.url);
        validate_https_url(&url)?;
        let thumbnail = input.thumbnail_url.unwrap_or(current.thumbnail_url);
        if let Some(url) = thumbnail.as_deref() {
            validate_https_url(url)?;
        }
        let connection = self.connection.lock();
        connection.execute(
            r#"UPDATE learning_resources SET kind = ?, title = ?, summary = ?, url = ?, platform = ?,
               language = ?, thumbnail_url = ?, verified = ?, updated_at = ?, revision = revision + 1,
               device_id = ?, hlc = ? WHERE id = ?"#,
            params![kind, title, input.summary.map(|value| clean_text(&value, 600)).unwrap_or(current.summary),
                    url, input.platform.map(|value| clean_text(&value, 40)).unwrap_or(current.platform),
                    input.language.map(|value| clean_text(&value, 20)).unwrap_or(current.language), thumbnail,
                    input.verified.unwrap_or(current.verified) as i64, now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "learning_resources", id)?;
        drop(connection);
        self.get_learning_resource(id)
    }

    pub fn delete_learning_resource(&self, id: &str) -> Result<()> {
        self.get_learning_resource(id)?;
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE learning_resources SET tombstone = 1, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "learning_resources", id)?;
        Ok(())
    }

    pub fn reorder_learning_resources(&self, pack_id: &str, ids: &[String]) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        for (index, id) in ids.iter().enumerate() {
            transaction.execute(
                "UPDATE learning_resources SET position = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ? AND pack_id = ?",
                params![((index + 1) * 1000) as i64, now_iso(), self.device_id, self.hlc(), id, pack_id],
            )?;
            self.queue_change(&transaction, "learning_resources", id)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn pin_learning_resource(&self, id: &str, pinned: bool) -> Result<LearningResource> {
        self.get_learning_resource(id)?;
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE learning_resources SET pinned = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![pinned as i64, now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "learning_resources", id)?;
        drop(connection);
        self.get_learning_resource(id)
    }

    pub fn upsert_learning_node(
        &self,
        task_id: &str,
        input: UpsertLearningNodeInput,
    ) -> Result<LearningNode> {
        let title = clean_text(&input.title, 120);
        if title.is_empty() {
            bail!("路线节点标题不能为空");
        }
        let pack = self.ensure_learning_pack(task_id)?;
        if let Some(id) = input.id.as_deref() {
            let current = self
                .find_learning_node(id, true)?
                .ok_or_else(|| anyhow!("找不到路线节点"))?;
            if current.task_id != task_id || current.pack_id != pack.id {
                bail!("路线节点不属于当前任务");
            }
            let status = input.status.unwrap_or(current.status);
            validate_node_status(&status)?;
            let connection = self.connection.lock();
            connection.execute(
                r#"UPDATE learning_nodes SET kind = ?, title = ?, description = ?, estimated_minutes = ?,
                   status = ?, x = ?, y = ?, position = ?, pinned = ?, updated_at = ?, revision = revision + 1,
                   device_id = ?, hlc = ?, tombstone = 0 WHERE id = ? AND task_id = ?"#,
                params![input.kind.unwrap_or(current.kind), title,
                        if input.description.is_empty() { current.description } else { clean_text(&input.description, 1000) },
                        input.estimated_minutes.or(current.estimated_minutes), status, input.x.unwrap_or(current.x),
                        input.y.unwrap_or(current.y), input.position.unwrap_or(current.position),
                        input.pinned.unwrap_or(current.pinned) as i64, now_iso(), self.device_id, self.hlc(), id, task_id],
            )?;
            self.queue_change(&connection, "learning_nodes", id)?;
            drop(connection);
            return self.get_learning_node(id);
        }
        let connection = self.connection.lock();
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM learning_nodes WHERE pack_id = ? AND tombstone = 0",
            [&pack.id],
            |row| row.get(0),
        )?;
        if count >= 50 {
            bail!("路线图最多支持 50 个节点");
        }
        let id = Uuid::new_v4().to_string();
        let status = input.status.unwrap_or_else(|| "pending".into());
        validate_node_status(&status)?;
        let timestamp = now_iso();
        connection.execute(
            r#"INSERT INTO learning_nodes (
                 id, pack_id, task_id, kind, title, description, estimated_minutes, status, x, y,
                 position, pinned, created_at, updated_at, revision, device_id, hlc, tombstone
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)"#,
            params![
                id,
                pack.id,
                task_id,
                input.kind.unwrap_or_else(|| "custom".into()),
                title,
                clean_text(&input.description, 1000),
                input.estimated_minutes,
                status,
                input.x.unwrap_or(24.0),
                input.y.unwrap_or(32.0 + count as f64 * 128.0),
                input.position.unwrap_or((count + 1) * 1000),
                input.pinned.unwrap_or(false) as i64,
                timestamp,
                timestamp,
                self.device_id,
                self.hlc()
            ],
        )?;
        self.queue_change(&connection, "learning_nodes", &id)?;
        drop(connection);
        self.get_learning_node(&id)
    }

    fn get_learning_node(&self, id: &str) -> Result<LearningNode> {
        self.find_learning_node(id, false)?
            .ok_or_else(|| anyhow!("找不到路线节点"))
    }

    fn find_learning_node(&self, id: &str, include_deleted: bool) -> Result<Option<LearningNode>> {
        let query = if include_deleted {
            r#"SELECT id, pack_id, task_id, kind, title, description, estimated_minutes, status,
                      x, y, position, pinned, created_at, updated_at FROM learning_nodes WHERE id = ?"#
        } else {
            r#"SELECT id, pack_id, task_id, kind, title, description, estimated_minutes, status,
                      x, y, position, pinned, created_at, updated_at FROM learning_nodes
               WHERE id = ? AND tombstone = 0"#
        };
        Ok(self
            .connection
            .lock()
            .query_row(query, [id], |row| {
                Ok(LearningNode {
                    id: row.get(0)?,
                    pack_id: row.get(1)?,
                    task_id: row.get(2)?,
                    kind: row.get(3)?,
                    title: row.get(4)?,
                    description: row.get(5)?,
                    estimated_minutes: row.get(6)?,
                    status: row.get(7)?,
                    x: row.get(8)?,
                    y: row.get(9)?,
                    position: row.get(10)?,
                    pinned: bool_from_i64(row.get(11)?),
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            })
            .optional()?)
    }

    pub fn delete_learning_node(&self, id: &str) -> Result<()> {
        self.get_learning_node(id)?;
        let connection = self.connection.lock();
        let related_edges = {
            let mut statement = connection.prepare(
                "SELECT id FROM learning_edges WHERE (source_node_id = ? OR target_node_id = ?) AND tombstone = 0",
            )?;
            statement
                .query_map(params![id, id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        connection.execute(
            "UPDATE learning_nodes SET tombstone = 1, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![now_iso(), self.device_id, self.hlc(), id],
        )?;
        connection.execute(
            "UPDATE learning_edges SET tombstone = 1, revision = revision + 1, device_id = ?, hlc = ? WHERE source_node_id = ? OR target_node_id = ?",
            params![self.device_id, self.hlc(), id, id],
        )?;
        self.queue_change(&connection, "learning_nodes", id)?;
        for edge_id in related_edges {
            self.queue_change(&connection, "learning_edges", &edge_id)?;
        }
        Ok(())
    }

    pub fn connect_learning_nodes(
        &self,
        pack_id: &str,
        source: &str,
        target: &str,
    ) -> Result<LearningEdge> {
        if source == target {
            bail!("节点不能依赖自己");
        }
        let source_node = self.get_learning_node(source)?;
        let target_node = self.get_learning_node(target)?;
        if source_node.pack_id != pack_id || target_node.pack_id != pack_id {
            bail!("只能连接同一个学习包中的节点");
        }
        let existing = self.connection.lock().query_row(
            "SELECT id, created_at, tombstone FROM learning_edges WHERE pack_id = ? AND source_node_id = ? AND target_node_id = ?",
            params![pack_id, source, target],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, bool_from_i64(row.get(2)?))),
        ).optional()?;
        if let Some((id, created_at, false)) = existing.as_ref() {
            return Ok(LearningEdge {
                id: id.clone(),
                pack_id: pack_id.into(),
                source_node_id: source.into(),
                target_node_id: target.into(),
                relation: "depends-on".into(),
                created_at: created_at.clone(),
            });
        }
        if self.would_create_cycle(pack_id, source, target)? {
            bail!("这条连接会形成循环依赖");
        }
        if let Some((id, created_at, true)) = existing {
            let connection = self.connection.lock();
            connection.execute(
                "UPDATE learning_edges SET tombstone = 0, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
                params![self.device_id, self.hlc(), id],
            )?;
            self.queue_change(&connection, "learning_edges", &id)?;
            return Ok(LearningEdge {
                id,
                pack_id: pack_id.into(),
                source_node_id: source.into(),
                target_node_id: target.into(),
                relation: "depends-on".into(),
                created_at,
            });
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now_iso();
        let connection = self.connection.lock();
        connection.execute(
            r#"INSERT INTO learning_edges (
                 id, pack_id, source_node_id, target_node_id, relation, created_at,
                 revision, device_id, hlc, tombstone
               ) VALUES (?, ?, ?, ?, 'depends-on', ?, 1, ?, ?, 0)"#,
            params![
                id,
                pack_id,
                source,
                target,
                timestamp,
                self.device_id,
                self.hlc()
            ],
        )?;
        self.queue_change(&connection, "learning_edges", &id)?;
        Ok(LearningEdge {
            id,
            pack_id: pack_id.into(),
            source_node_id: source.into(),
            target_node_id: target.into(),
            relation: "depends-on".into(),
            created_at: timestamp,
        })
    }

    fn would_create_cycle(&self, pack_id: &str, source: &str, target: &str) -> Result<bool> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT source_node_id, target_node_id FROM learning_edges WHERE pack_id = ? AND tombstone = 0",
        )?;
        let edges = statement
            .query_map([pack_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
        for (from, to) in edges {
            adjacency.entry(from).or_default().push(to);
        }
        adjacency
            .entry(source.into())
            .or_default()
            .push(target.into());
        let mut stack = vec![target.to_string()];
        let mut visited = HashSet::new();
        while let Some(node) = stack.pop() {
            if node == source {
                return Ok(true);
            }
            if visited.insert(node.clone())
                && let Some(next) = adjacency.get(&node)
            {
                stack.extend(next.iter().cloned());
            }
        }
        Ok(false)
    }

    pub fn disconnect_learning_edge(&self, id: &str) -> Result<()> {
        let connection = self.connection.lock();
        let changed = connection.execute(
            "UPDATE learning_edges SET tombstone = 1, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ? AND tombstone = 0",
            params![self.device_id, self.hlc(), id],
        )?;
        if changed == 0 {
            bail!("找不到路线连接");
        }
        self.queue_change(&connection, "learning_edges", id)?;
        Ok(())
    }

    pub fn set_learning_node_status(&self, id: &str, status: &str) -> Result<LearningNode> {
        validate_node_status(status)?;
        self.get_learning_node(id)?;
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE learning_nodes SET status = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![status, now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "learning_nodes", id)?;
        drop(connection);
        self.get_learning_node(id)
    }

    pub fn auto_layout_learning(&self, task_id: &str) -> Result<LearningPack> {
        let pack = self.ensure_learning_pack(task_id)?;
        let mut indegree = pack
            .nodes
            .iter()
            .map(|node| (node.id.clone(), 0_usize))
            .collect::<HashMap<_, _>>();
        let mut outgoing: HashMap<String, Vec<String>> = HashMap::new();
        for edge in &pack.edges {
            *indegree.entry(edge.target_node_id.clone()).or_default() += 1;
            outgoing
                .entry(edge.source_node_id.clone())
                .or_default()
                .push(edge.target_node_id.clone());
        }
        let mut queue = indegree
            .iter()
            .filter(|(_, degree)| **degree == 0)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        queue.sort();
        let mut layer = HashMap::<String, usize>::new();
        while let Some(node) = queue.pop() {
            let current_layer = layer.get(&node).copied().unwrap_or_default();
            for target in outgoing.get(&node).into_iter().flatten() {
                layer
                    .entry(target.clone())
                    .and_modify(|value| *value = (*value).max(current_layer + 1))
                    .or_insert(current_layer + 1);
                if let Some(degree) = indegree.get_mut(target) {
                    *degree -= 1;
                    if *degree == 0 {
                        queue.push(target.clone());
                    }
                }
            }
        }
        let mut counts = HashMap::<usize, usize>::new();
        let connection = self.connection.lock();
        for node in &pack.nodes {
            let level = layer.get(&node.id).copied().unwrap_or_default();
            let slot = counts.entry(level).or_default();
            connection.execute(
                "UPDATE learning_nodes SET x = ?, y = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
                params![32.0 + *slot as f64 * 248.0, 32.0 + level as f64 * 132.0, now_iso(), self.device_id, self.hlc(), node.id],
            )?;
            *slot += 1;
            self.queue_change(&connection, "learning_nodes", &node.id)?;
        }
        drop(connection);
        self.get_learning_pack(task_id)?
            .ok_or_else(|| anyhow!("学习包不存在"))
    }

    pub fn create_database_backup(&self, force: bool) -> Result<Option<PathBuf>> {
        let today = local_date_key(Local::now());
        if !force && self.setting("lastBackupDate", String::new())? == today {
            return Ok(None);
        }
        fs::create_dir_all(&self.backup_dir)?;
        self.checkpoint()?;
        let target = self.backup_dir.join(format!(
            "nudge-{today}-{}.db",
            Utc::now().timestamp_millis()
        ));
        {
            let source = self.connection.lock();
            let mut destination = Connection::open(&target)?;
            let backup = Backup::new(&source, &mut destination)?;
            backup.run_to_completion(32, Duration::from_millis(10), None)?;
        }
        let mut backups = fs::read_dir(&self.backup_dir)?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("nudge-") && name.ends_with(".db"))
            })
            .collect::<Vec<_>>();
        backups.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        for old in backups.into_iter().skip(7) {
            let _ = fs::remove_file(old);
        }
        self.set_setting("lastBackupDate", &today)?;
        Ok(Some(target))
    }

    pub fn export_json(&self) -> Result<Value> {
        let connection = self.connection.lock();
        let tables = [
            ("lists", "lists"),
            ("tasks", "tasks"),
            ("tags", "tags"),
            ("task_tags", "taskTags"),
            ("focus_sessions", "focusSessions"),
            ("settings", "settings"),
            ("learning_packs", "learningPacks"),
            ("learning_resources", "learningResources"),
            ("learning_nodes", "learningNodes"),
            ("learning_edges", "learningEdges"),
        ];
        let mut data = Map::new();
        for (table, key) in tables {
            let mut rows = self.export_table_locked(&connection, table)?;
            if table == "settings" {
                rows.retain(|row| {
                    row.get("key").and_then(Value::as_str).is_none_or(|key| {
                        !matches!(
                            key,
                            "recommendationApiKey" | "webdavPassword" | "syncPassphrase"
                        )
                    })
                });
            }
            data.insert(key.into(), Value::Array(rows));
        }
        Ok(json!({
            "schemaVersion": 2,
            "exportedAt": now_iso(),
            "data": Value::Object(data)
        }))
    }

    pub fn export_sync_snapshot(&self) -> Result<Value> {
        let mut payload = self.export_json()?;
        if let Some(settings) = payload
            .pointer_mut("/data/settings")
            .and_then(Value::as_array_mut)
        {
            settings.retain(|row| {
                row.get("key").and_then(Value::as_str).is_some_and(|key| {
                    matches!(
                        key,
                        "dailyGoalMinutes"
                            | "longTermGoalHours"
                            | "longTermGoalLabel"
                            | "pomodoroFocusMinutes"
                            | "pomodoroBreakMinutes"
                    )
                })
            });
        }
        Ok(payload)
    }

    fn export_table_locked(&self, connection: &Connection, table: &str) -> Result<Vec<Value>> {
        let mut statement = connection.prepare(&format!("SELECT * FROM {table}"))?;
        let column_names = statement
            .column_names()
            .iter()
            .map(|name| name.to_string())
            .collect::<Vec<_>>();
        let rows = statement
            .query_map([], |row| {
                let mut object = Map::new();
                for (index, name) in column_names.iter().enumerate() {
                    let value = match row.get_ref(index)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(value) => Value::from(value),
                        ValueRef::Real(value) => Value::from(value),
                        ValueRef::Text(value) => {
                            Value::String(String::from_utf8_lossy(value).into())
                        }
                        ValueRef::Blob(value) => Value::String(base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            value,
                        )),
                    };
                    object.insert(name.clone(), value);
                }
                Ok(Value::Object(object))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn import_json(&self, payload: Value, mode: &str) -> Result<i64> {
        if !matches!(mode, "merge" | "replace") {
            bail!("导入模式无效");
        }
        let version = payload
            .get("schemaVersion")
            .and_then(Value::as_i64)
            .unwrap_or(1);
        if !(1..=2).contains(&version) {
            bail!("暂不支持这个版本的 Nudge 备份");
        }
        let data = payload
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("这不是有效的 Nudge 备份文件"))?;
        if mode == "replace" {
            self.create_database_backup(true)?;
        }

        let mappings = [
            ("lists", "lists"),
            ("tasks", "tasks"),
            ("tags", "tags"),
            ("taskTags", "task_tags"),
            ("focusSessions", "focus_sessions"),
            ("settings", "settings"),
            ("learningPacks", "learning_packs"),
            ("learningResources", "learning_resources"),
            ("learningNodes", "learning_nodes"),
            ("learningEdges", "learning_edges"),
        ];
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        if mode == "replace" {
            transaction.execute_batch(
                r#"DELETE FROM task_tags; DELETE FROM learning_edges; DELETE FROM learning_resources;
                   DELETE FROM learning_nodes; DELETE FROM learning_packs; DELETE FROM focus_sessions;
                   DELETE FROM tasks; DELETE FROM tags; DELETE FROM lists; DELETE FROM settings;"#,
            )?;
        }
        let mut imported = 0_i64;
        for (json_key, table) in mappings {
            let Some(rows) = data.get(json_key).and_then(Value::as_array) else {
                continue;
            };
            let columns = Self::table_columns(&transaction, table)?;
            for row in rows {
                let Some(object) = row.as_object() else {
                    continue;
                };
                imported +=
                    Self::insert_json_row(&transaction, table, object, &columns, mode == "merge")?;
            }
        }
        transaction.commit()?;
        drop(connection);
        self.ensure_defaults()?;
        Ok(imported)
    }

    fn table_columns(connection: &Connection, table: &str) -> Result<HashSet<String>> {
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        Ok(statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<HashSet<_>>>()?)
    }

    fn insert_json_row(
        transaction: &Transaction<'_>,
        table: &str,
        object: &Map<String, Value>,
        columns: &HashSet<String>,
        ignore_conflicts: bool,
    ) -> Result<i64> {
        let mut names = object
            .keys()
            .filter(|key| columns.contains(*key))
            .cloned()
            .collect::<Vec<_>>();
        names.sort();
        if names.is_empty() {
            return Ok(0);
        }
        let values = names
            .iter()
            .map(|name| Self::json_to_sql(object.get(name).unwrap_or(&Value::Null)))
            .collect::<Vec<_>>();
        let placeholders = (0..names.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "INSERT {}INTO {table} ({}) VALUES ({placeholders})",
            if ignore_conflicts { "OR IGNORE " } else { "" },
            names.join(", ")
        );
        Ok(transaction.execute(&sql, rusqlite::params_from_iter(values))? as i64)
    }

    fn json_to_sql(value: &Value) -> SqlValue {
        match value {
            Value::Null => SqlValue::Null,
            Value::Bool(value) => SqlValue::Integer(*value as i64),
            Value::Number(value) => value
                .as_i64()
                .map(SqlValue::Integer)
                .or_else(|| value.as_f64().map(SqlValue::Real))
                .unwrap_or(SqlValue::Null),
            Value::String(value) => SqlValue::Text(value.clone()),
            Value::Array(_) | Value::Object(_) => SqlValue::Text(value.to_string()),
        }
    }

    pub fn merge_sync_snapshot(&self, payload: &Value) -> Result<()> {
        let data = payload
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("远端同步数据格式无效"))?;
        let mappings = [
            ("lists", "lists", "id"),
            ("tasks", "tasks", "id"),
            ("tags", "tags", "id"),
            ("focusSessions", "focus_sessions", "id"),
            ("learningPacks", "learning_packs", "id"),
            ("learningResources", "learning_resources", "id"),
            ("learningNodes", "learning_nodes", "id"),
            ("learningEdges", "learning_edges", "id"),
        ];
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute_batch("PRAGMA defer_foreign_keys = ON")?;
        for (json_key, table, key_column) in mappings {
            let Some(rows) = data.get(json_key).and_then(Value::as_array) else {
                continue;
            };
            let columns = Self::table_columns(&transaction, table)?;
            for remote in rows.iter().filter_map(Value::as_object) {
                let Some(id) = remote.get(key_column).and_then(Value::as_str) else {
                    continue;
                };
                let remote_hlc = remote
                    .get("hlc")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let local = Self::export_row_by_id(&transaction, table, key_column, id)?;
                let local_hlc = local
                    .as_ref()
                    .and_then(|row| row.get("hlc"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if local.is_none() || remote_hlc > local_hlc {
                    Self::upsert_json_row(&transaction, table, key_column, remote, &columns)?;
                } else if remote_hlc == local_hlc {
                    if let Some(local_payload) = local.filter(|row| row != remote) {
                        transaction.execute(
                            "INSERT INTO sync_conflicts (id, entity_type, entity_id, local_payload, remote_payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                            params![Uuid::new_v4().to_string(), table, id, Value::Object(local_payload).to_string(), Value::Object(remote.clone()).to_string(), now_iso()],
                        )?;
                    }
                }
            }
        }
        if let Some(task_tags) = data.get("taskTags").and_then(Value::as_array) {
            for row in task_tags.iter().filter_map(Value::as_object) {
                let columns = Self::table_columns(&transaction, "task_tags")?;
                let _ = Self::insert_json_row(&transaction, "task_tags", row, &columns, true)?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    fn export_row_by_id(
        connection: &Connection,
        table: &str,
        key_column: &str,
        id: &str,
    ) -> Result<Option<Map<String, Value>>> {
        let mut statement =
            connection.prepare(&format!("SELECT * FROM {table} WHERE {key_column} = ?"))?;
        let columns = statement
            .column_names()
            .iter()
            .map(|name| name.to_string())
            .collect::<Vec<_>>();
        statement
            .query_row([id], |row| {
                let mut object = Map::new();
                for (index, name) in columns.iter().enumerate() {
                    let value = match row.get_ref(index)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(value) => Value::from(value),
                        ValueRef::Real(value) => Value::from(value),
                        ValueRef::Text(value) => {
                            Value::String(String::from_utf8_lossy(value).into())
                        }
                        ValueRef::Blob(value) => Value::String(base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            value,
                        )),
                    };
                    object.insert(name.clone(), value);
                }
                Ok(object)
            })
            .optional()
            .map_err(Into::into)
    }

    fn upsert_json_row(
        transaction: &Transaction<'_>,
        table: &str,
        key_column: &str,
        object: &Map<String, Value>,
        columns: &HashSet<String>,
    ) -> Result<()> {
        let mut names = object
            .keys()
            .filter(|key| columns.contains(*key))
            .cloned()
            .collect::<Vec<_>>();
        names.sort();
        let values = names
            .iter()
            .map(|name| Self::json_to_sql(object.get(name).unwrap_or(&Value::Null)))
            .collect::<Vec<_>>();
        let assignments = names
            .iter()
            .filter(|name| name.as_str() != key_column)
            .map(|name| format!("{name} = excluded.{name}"))
            .collect::<Vec<_>>()
            .join(", ");
        let placeholders = (0..names.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
        transaction.execute(
            &format!(
                "INSERT INTO {table} ({}) VALUES ({placeholders}) ON CONFLICT({key_column}) DO UPDATE SET {assignments}",
                names.join(", ")
            ),
            rusqlite::params_from_iter(values),
        )?;
        Ok(())
    }

    pub fn list_conflicts(&self) -> Result<Vec<SyncConflict>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, entity_type, entity_id, local_payload, remote_payload, created_at, resolved_at FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY created_at DESC",
        )?;
        Ok(statement
            .query_map([], |row| {
                let local: String = row.get(3)?;
                let remote: String = row.get(4)?;
                Ok(SyncConflict {
                    id: row.get(0)?,
                    entity_type: row.get(1)?,
                    entity_id: row.get(2)?,
                    local_payload: serde_json::from_str(&local).unwrap_or(Value::Null),
                    remote_payload: serde_json::from_str(&remote).unwrap_or(Value::Null),
                    created_at: row.get(5)?,
                    resolved_at: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn resolve_conflict(&self, id: &str, choice: &str) -> Result<()> {
        let conflict = self
            .list_conflicts()?
            .into_iter()
            .find(|conflict| conflict.id == id)
            .ok_or_else(|| anyhow!("找不到同步冲突"))?;
        if choice == "remote" {
            let object = conflict
                .remote_payload
                .as_object()
                .ok_or_else(|| anyhow!("远端冲突内容无效"))?;
            let mut connection = self.connection.lock();
            let transaction = connection.transaction()?;
            let columns = Self::table_columns(&transaction, &conflict.entity_type)?;
            Self::upsert_json_row(&transaction, &conflict.entity_type, "id", object, &columns)?;
            transaction.commit()?;
        } else if choice == "keep-both" && conflict.entity_type == "tasks" {
            if let Some(mut object) = conflict.remote_payload.as_object().cloned() {
                let new_id = Uuid::new_v4().to_string();
                object.insert("id".into(), Value::String(new_id.clone()));
                if let Some(title) = object.get("title").and_then(Value::as_str) {
                    object.insert(
                        "title".into(),
                        Value::String(format!("{title}（冲突副本）")),
                    );
                }
                object.insert("device_id".into(), Value::String(self.device_id.clone()));
                object.insert("hlc".into(), Value::String(self.hlc()));
                let mut connection = self.connection.lock();
                let transaction = connection.transaction()?;
                let columns = Self::table_columns(&transaction, "tasks")?;
                Self::insert_json_row(&transaction, "tasks", &object, &columns, false)?;
                self.queue_change(&transaction, "tasks", &new_id)?;
                transaction.commit()?;
            }
        } else if choice != "local" {
            bail!("冲突处理方式无效");
        }
        self.connection.lock().execute(
            "UPDATE sync_conflicts SET resolved_at = ? WHERE id = ?",
            params![now_iso(), id],
        )?;
        Ok(())
    }

    pub fn get_sync_settings(&self) -> Result<SyncSettings> {
        let mut value: SyncSettings = self.setting(
            "syncSettings",
            SyncSettings {
                enabled: false,
                server_url: String::new(),
                username: String::new(),
                remote_path: "Nudge/nudge-v2.enc".into(),
                remember_passphrase: false,
                has_credentials: false,
                device_id: self.device_id.clone(),
                device_name: hostname::get()
                    .ok()
                    .and_then(|name| name.into_string().ok())
                    .unwrap_or_else(|| "Nudge 设备".into()),
            },
        )?;
        value.device_id = self.device_id.clone();
        Ok(value)
    }

    pub fn set_sync_settings(&self, settings: &SyncSettings) -> Result<()> {
        self.set_setting("syncSettings", settings)
    }

    pub fn get_sync_state(&self) -> Result<SyncState> {
        let mut state: SyncState = self.setting("syncState", SyncState::default())?;
        state.pending_changes = self.pending_sync_changes()?;
        state.conflict_count = self.list_conflicts()?.len() as i64;
        Ok(state)
    }

    pub fn set_sync_state(&self, state: &SyncState) -> Result<()> {
        self.set_setting("syncState", state)
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

    #[test]
    fn offline_learning_pack_is_idempotent_and_acyclic() {
        let (path, root) = temporary_database("learning");
        let database = Database::open(path, None, vec![]).unwrap();
        let task = database.list_tasks().unwrap().into_iter().next().unwrap();
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
        let task = database.list_tasks().unwrap().into_iter().next().unwrap();
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
    fn v2_backup_round_trip_keeps_learning_data() {
        let (source_path, source_root) = temporary_database("export");
        let source = Database::open(source_path, None, vec![]).unwrap();
        let task = source.list_tasks().unwrap().into_iter().next().unwrap();
        source.ensure_learning_pack(&task.id).unwrap();
        let backup = source.export_json().unwrap();

        let (target_path, target_root) = temporary_database("import");
        let target = Database::open(target_path, None, vec![]).unwrap();
        target.import_json(backup, "replace").unwrap();
        assert!(target.get_learning_pack(&task.id).unwrap().is_some());
        drop(source);
        drop(target);
        let _ = fs::remove_dir_all(source_root);
        let _ = fs::remove_dir_all(target_root);
    }
}
