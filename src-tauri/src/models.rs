use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub fn deserialize_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub list_id: String,
    pub parent_id: Option<String>,
    pub status: String,
    pub scheduled_for: Option<String>,
    pub due_at: Option<String>,
    pub reminder_at: Option<String>,
    pub priority: String,
    pub estimate_minutes: Option<i64>,
    pub position: f64,
    pub completed_at: Option<String>,
    pub deleted_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub tags: Vec<Tag>,
    pub subtasks: Vec<Task>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskList {
    pub id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskInput {
    pub title: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub list_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub scheduled_for: Option<String>,
    #[serde(default)]
    pub due_at: Option<String>,
    #[serde(default)]
    pub reminder_at: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub estimate_minutes: Option<i64>,
    #[serde(default)]
    pub tag_names: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskInput {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub list_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub scheduled_for: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub due_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub reminder_at: Option<Option<String>>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub estimate_minutes: Option<Option<i64>>,
    #[serde(default)]
    pub tag_names: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSession {
    pub id: String,
    pub task_id: Option<String>,
    pub mode: String,
    pub started_at: String,
    pub ended_at: String,
    pub duration_seconds: i64,
    pub note: String,
    pub source: String,
    pub source_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusState {
    pub status: String,
    pub mode: String,
    pub phase: String,
    pub task_id: Option<String>,
    pub started_at: Option<String>,
    pub accumulated_seconds: i64,
    pub duration_seconds: Option<i64>,
}

impl Default for FocusState {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            mode: "pomodoro".into(),
            phase: "focus".into(),
            task_id: None,
            started_at: None,
            accumulated_seconds: 0,
            duration_seconds: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusStats {
    pub today_seconds: i64,
    pub total_seconds: i64,
    pub streak_days: i64,
    pub daily_goal_minutes: i64,
    pub long_term_goal_hours: f64,
    pub long_term_goal_label: String,
    pub sessions: Vec<FocusSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub daily_goal_minutes: i64,
    pub long_term_goal_hours: f64,
    pub long_term_goal_label: String,
    pub pomodoro_focus_minutes: i64,
    pub pomodoro_break_minutes: i64,
    pub auto_start: bool,
    pub close_to_tray: bool,
    pub global_shortcut: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            daily_goal_minutes: 120,
            long_term_goal_hours: 350.0,
            long_term_goal_label: "学习进度".into(),
            pomodoro_focus_minutes: 25,
            pomodoro_break_minutes: 5,
            auto_start: false,
            close_to_tray: true,
            global_shortcut: "Ctrl+Alt+Space".into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAppSettingsInput {
    pub daily_goal_minutes: Option<i64>,
    pub long_term_goal_hours: Option<f64>,
    pub long_term_goal_label: Option<String>,
    pub pomodoro_focus_minutes: Option<i64>,
    pub pomodoro_break_minutes: Option<i64>,
    pub auto_start: Option<bool>,
    pub close_to_tray: Option<bool>,
    pub global_shortcut: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningPack {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub provider: String,
    pub model: Option<String>,
    pub generation_id: Option<String>,
    pub completed_sections: Vec<String>,
    pub failed_sections: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub resources: Vec<LearningResource>,
    pub nodes: Vec<LearningNode>,
    pub edges: Vec<LearningEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningResource {
    pub id: String,
    pub pack_id: String,
    pub task_id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub url: String,
    pub platform: String,
    pub language: String,
    pub thumbnail_url: Option<String>,
    pub pinned: bool,
    pub verified: bool,
    pub source: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningNode {
    pub id: String,
    pub pack_id: String,
    pub task_id: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub estimated_minutes: Option<i64>,
    pub status: String,
    pub x: f64,
    pub y: f64,
    pub position: i64,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningEdge {
    pub id: String,
    pub pack_id: String,
    pub source_node_id: String,
    pub target_node_id: String,
    pub relation: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateLearningResourceInput {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub verified: bool,
}

fn default_language() -> String {
    "zh-CN".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLearningResourceInput {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub url: Option<String>,
    pub platform: Option<String>,
    pub language: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub thumbnail_url: Option<Option<String>>,
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertLearningNodeInput {
    pub id: Option<String>,
    pub kind: Option<String>,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub estimated_minutes: Option<i64>,
    pub status: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub position: Option<i64>,
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningProgressEvent {
    pub task_id: String,
    pub pack_id: String,
    pub generation_id: String,
    pub section: String,
    pub state: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationSettings {
    pub provider: String,
    pub endpoint: String,
    pub model: String,
    pub network_enabled: bool,
    pub send_notes: bool,
    pub has_api_key: bool,
}

impl Default for RecommendationSettings {
    fn default() -> Self {
        Self {
            provider: "offline".into(),
            endpoint: "https://api.openai.com/v1".into(),
            model: "gpt-4.1-mini".into(),
            network_enabled: false,
            send_notes: false,
            has_api_key: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRecommendationSettingsInput {
    pub provider: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub network_enabled: Option<bool>,
    pub send_notes: Option<bool>,
    pub api_key: Option<String>,
    pub clear_api_key: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSettings {
    pub enabled: bool,
    pub server_url: String,
    pub username: String,
    pub remote_path: String,
    pub remember_passphrase: bool,
    pub has_credentials: bool,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureSyncInput {
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub passphrase: String,
    #[serde(default = "default_remote_path")]
    pub remote_path: String,
    #[serde(default)]
    pub remember_passphrase: bool,
    #[serde(default)]
    pub device_name: String,
}

fn default_remote_path() -> String {
    "Nudge/nudge-v2.enc".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub status: String,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
    pub pending_changes: i64,
    pub conflict_count: i64,
    pub remote_etag: Option<String>,
}

impl Default for SyncState {
    fn default() -> Self {
        Self {
            status: "disconnected".into(),
            last_synced_at: None,
            last_error: None,
            pending_changes: 0,
            conflict_count: 0,
            remote_etag: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub local_payload: Value,
    pub remote_payload: Value,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub canceled: bool,
    pub path: Option<String>,
    pub imported: Option<i64>,
}
