mod commands;
mod data_events;
mod database;
mod focus;
mod media_cache;
mod models;
mod recommendation;
mod reminders;
mod secret_store;
mod sync;
mod sync_clock;

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::Context;
use data_events::emit_data_changed;
use database::{Database, LearningGenerationStateUpdate};
use focus::FocusService;
use models::*;
use parking_lot::Mutex;
use recommendation::GeneratedSection;
use secret_store::{API_KEY, SYNC_PASSPHRASE, SecretStore, WEBDAV_PASSWORD};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;
use zeroize::Zeroizing;

#[cfg(desktop)]
use tauri::{
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt as AutostartExt;
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

struct AppState {
    database: Arc<Database>,
    focus: Arc<FocusService>,
    secrets: Arc<SecretStore>,
    thumbnail_cache: PathBuf,
    canceled_learning: Mutex<HashMap<String, Arc<AtomicBool>>>,
    #[cfg(desktop)]
    quitting: AtomicBool,
}

fn command_result<T>(result: anyhow::Result<T>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
}

fn task_mutation(task: Option<Task>, removed_task_ids: Vec<String>) -> TaskMutationResult {
    let upserted_tags = task
        .as_ref()
        .map(|item| item.tags.clone())
        .unwrap_or_default();
    TaskMutationResult {
        changes: EntityChangeSet {
            upserted_tasks: task.iter().cloned().collect(),
            removed_task_ids,
            upserted_tags,
        },
        task,
    }
}

#[tauri::command]
async fn media_thumbnail_data_url(
    state: State<'_, AppState>,
    source: String,
) -> Result<String, String> {
    command_result(media_cache::thumbnail_data_url(&state.thumbnail_cache, &source).await)
}

#[tauri::command]
fn app_bootstrap(state: State<'_, AppState>) -> Result<BootstrapSnapshot, String> {
    command_result((|| {
        let mut recommendation_settings: RecommendationSettings = state
            .database
            .setting("recommendationSettings", RecommendationSettings::default())?;
        recommendation_settings.has_api_key = state.secrets.has(API_KEY);
        let mut sync_settings = state.database.get_sync_settings()?;
        sync_settings.has_credentials = state.secrets.has(WEBDAV_PASSWORD);
        let migration = state
            .database
            .setting("secretMigration", "not-needed".to_string())?;
        Ok(BootstrapSnapshot {
            tasks: state.database.list_tasks()?,
            lists: state.database.list_lists()?,
            tags: state.database.list_tags()?,
            settings: state.database.get_settings()?,
            focus_state: state.focus.get_state(),
            focus_stats: state.database.get_focus_stats()?,
            recommendation_settings,
            sync_settings,
            sync_state: state.database.get_sync_state()?,
            sync_conflicts: state.database.list_conflicts()?,
            secret_store: state.secrets.status(&migration),
        })
    })())
}

#[cfg(desktop)]
fn settings_as_update(settings: &AppSettings) -> UpdateAppSettingsInput {
    UpdateAppSettingsInput {
        daily_goal_minutes: Some(settings.daily_goal_minutes),
        long_term_goal_hours: Some(settings.long_term_goal_hours),
        long_term_goal_label: Some(settings.long_term_goal_label.clone()),
        pomodoro_focus_minutes: Some(settings.pomodoro_focus_minutes),
        pomodoro_break_minutes: Some(settings.pomodoro_break_minutes),
        auto_start: Some(settings.auto_start),
        close_to_tray: Some(settings.close_to_tray),
        global_shortcut: Some(settings.global_shortcut.clone()),
    }
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    #[cfg(desktop)]
    let _ = window.unminimize();
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn trigger_quick_add(app: &AppHandle) {
    let _ = show_main_window(app);
    let _ = app.emit("desktop-quick-add", ());
}

#[cfg(desktop)]
fn apply_desktop_preferences(app: &AppHandle, settings: &AppSettings) -> anyhow::Result<()> {
    let shortcuts = app.global_shortcut();
    shortcuts.unregister_all().context("清理旧的全局快捷键")?;
    let shortcut = settings.global_shortcut.trim();
    shortcuts
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                trigger_quick_add(app);
            }
        })
        .context("注册全局快速添加快捷键")?;

    if std::env::var_os("NUDGE_TEST_DATA_DIR").is_some() {
        return Ok(());
    }
    let autostart = app.autolaunch();
    let autostart_enabled = autostart.is_enabled().context("读取开机启动状态")?;
    if settings.auto_start && !autostart_enabled {
        autostart.enable().context("启用开机启动")?;
    } else if !settings.auto_start && autostart_enabled {
        autostart.disable().context("关闭开机启动")?;
    }
    Ok(())
}

#[cfg(desktop)]
fn setup_tray(app: &AppHandle) -> anyhow::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show", "打开 Nudge")
        .text("quick-add", "快速添加任务")
        .text("focus", "专注迷你窗")
        .separator()
        .text("quit", "退出 Nudge")
        .build()?;
    let mut tray = TrayIconBuilder::with_id("nudge")
        .menu(&menu)
        .tooltip("Nudge · 待办与专注")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let _ = show_main_window(app);
            }
            "quick-add" => trigger_quick_add(app),
            "focus" => {
                let _ = toggle_mini_window(app);
            }
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    state.quitting.store(true, Ordering::Relaxed);
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Down,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            ) {
                let _ = show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
async fn desktop_toggle_mini_window(app: AppHandle) -> Result<(), String> {
    let result = toggle_mini_window(&app);
    if let Err(error) = result.as_ref() {
        log::error!("无法切换专注迷你窗：{error}");
    }
    result
}

#[cfg(desktop)]
fn toggle_mini_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("focus") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|error| error.to_string())?;
        } else {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    let mut builder = WebviewWindowBuilder::new(app, "focus", WebviewUrl::App("index.html".into()))
        .title("Nudge 专注")
        .inner_size(360.0, 190.0)
        .min_inner_size(360.0, 190.0)
        .max_inner_size(520.0, 260.0)
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .background_color(Color(245, 244, 237, 255))
        .center()
        .visible(false);
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon).map_err(|error| error.to_string())?;
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(mobile)]
fn toggle_mini_window(_app: &AppHandle) -> Result<(), String> {
    Err("移动端不支持置顶专注迷你窗".into())
}

#[tauri::command]
fn desktop_show_main(app: AppHandle) -> Result<(), String> {
    show_main_window(&app)
}

#[tauri::command]
fn desktop_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "链接格式无效".to_string())?;
    if parsed.scheme() != "https" {
        return Err("只允许打开 HTTPS 外链".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(desktop)]
fn desktop_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(mobile)]
fn desktop_minimize() -> Result<(), String> {
    Err("移动端不支持桌面窗口最小化".into())
}

#[tauri::command]
#[cfg(desktop)]
fn desktop_toggle_maximize(window: WebviewWindow) -> Result<(), String> {
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    if maximized {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
#[cfg(mobile)]
fn desktop_toggle_maximize() -> Result<(), String> {
    Err("移动端不支持桌面窗口最大化".into())
}

#[tauri::command]
#[cfg(desktop)]
fn desktop_close(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
#[cfg(mobile)]
fn desktop_close() -> Result<(), String> {
    Err("移动端不支持桌面窗口关闭操作".into())
}

#[tauri::command]
fn desktop_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    return "windows";
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "linux")]
    return "linux";
    #[cfg(target_os = "android")]
    return "android";
    #[cfg(target_os = "ios")]
    return "ios";
    #[allow(unreachable_code)]
    "unknown"
}

#[tauri::command]
fn notifications_prepare(app: AppHandle) -> Result<bool, String> {
    let notifications = app.notification();
    let permission = notifications
        .permission_state()
        .map_err(|error| error.to_string())?;
    if permission == PermissionState::Granted {
        return Ok(true);
    }
    if permission == PermissionState::Denied {
        return Ok(false);
    }
    notifications
        .request_permission()
        .map(|state| state == PermissionState::Granted)
        .map_err(|error| error.to_string())
}

fn data_directory(app: &AppHandle) -> anyhow::Result<PathBuf> {
    if let Some(path) = std::env::var_os("NUDGE_TEST_DATA_DIR") {
        let path = PathBuf::from(path);
        anyhow::ensure!(path.is_absolute(), "NUDGE_TEST_DATA_DIR 必须是绝对路径");
        return Ok(path);
    }
    Ok(app.path().app_data_dir()?)
}

fn app_paths(app: &AppHandle) -> anyhow::Result<(PathBuf, Option<PathBuf>, Vec<PathBuf>)> {
    let app_data = data_directory(app)?;
    fs::create_dir_all(&app_data)?;
    let database_path = app_data.join("nudge.db");
    if std::env::var_os("NUDGE_TEST_DATA_DIR").is_some() {
        return Ok((database_path, None, vec![]));
    }
    #[cfg(target_os = "windows")]
    let legacy_database = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("Nudge").join("nudge.db"))
        .filter(|path| path != &database_path && path.exists());
    #[cfg(not(target_os = "windows"))]
    let legacy_database = None;

    let mut legacy_json = vec![];
    if let Ok(current) = std::env::current_dir() {
        legacy_json.push(current.join("data.json"));
    }
    if let Ok(resources) = app.path().resource_dir() {
        legacy_json.push(resources.join("legacy").join("data.json"));
    }
    #[cfg(target_os = "windows")]
    legacy_json.push(PathBuf::from(r"D:\项目\study-nudge\data.json"));
    Ok((database_path, legacy_database, legacy_json))
}

fn setup_background_services(app: &AppHandle, focus: Arc<FocusService>, database: Arc<Database>) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        loop {
            interval.tick().await;
            if let Ok(Some((next, title, body))) = focus.tick() {
                let _ = app_handle.emit("focus-changed", &next);
                emit_data_changed(&app_handle, &["focus"], "local");
                let _ = app_handle
                    .notification()
                    .builder()
                    .title(title)
                    .body(body)
                    .show();
            }
        }
    });

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let _ = reminders::deliver_pending(&database, |title, body| {
                app_handle
                    .notification()
                    .builder()
                    .title(title)
                    .body(body)
                    .show()
                    .is_ok()
            });
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let stronghold = tauri_plugin_stronghold::Builder::new(|password: &str| {
        let mut hasher = Sha256::new();
        hasher.update(password.as_bytes());
        hasher.finalize().to_vec()
    })
    .build();

    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(stronghold)
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle()
                    .plugin(
                        tauri_plugin_log::Builder::default()
                            .level(log::LevelFilter::Info)
                            .build(),
                    )
                    .context("初始化调试日志")?;
            }
            let (database_path, legacy_database, legacy_json) =
                app_paths(app.handle()).context("解析应用数据路径")?;
            let database = Arc::new(
                Database::open(database_path, legacy_database, legacy_json)
                    .context("打开并迁移数据库")?,
            );
            let isolated = std::env::var_os("NUDGE_TEST_DATA_DIR").is_some();
            let secrets = Arc::new(if isolated {
                SecretStore::isolated()
            } else {
                SecretStore::new()
            });
            let thumbnail_cache = if isolated {
                data_directory(app.handle())?.join("thumbnails")
            } else {
                app.path().app_cache_dir()?.join("thumbnails")
            };
            let legacy_vault = data_directory(app.handle())?.join("nudge-vault.hold");
            let previous_migration: String = database.setting("secretMigration", String::new())?;
            if previous_migration != "completed" {
                database.set_setting(
                    "secretMigration",
                    &if legacy_vault.exists() {
                        "pending"
                    } else {
                        "not-needed"
                    },
                )?;
            }
            let _ = database.create_database_backup(false);
            let focus = Arc::new(FocusService::new(database.clone()).context("恢复专注计时状态")?);
            setup_background_services(app.handle(), focus.clone(), database.clone());
            #[cfg(desktop)]
            let settings = database.get_settings()?;
            app.manage(AppState {
                database,
                focus,
                secrets,
                thumbnail_cache,
                canceled_learning: Mutex::new(HashMap::new()),
                #[cfg(desktop)]
                quitting: AtomicBool::new(false),
            });
            #[cfg(desktop)]
            {
                setup_tray(app.handle()).context("创建系统托盘")?;
                apply_desktop_preferences(app.handle(), &settings)
                    .context("应用全局快捷键和开机启动设置")?;
                if let (Some(window), Some(icon)) = (
                    app.get_webview_window("main"),
                    app.default_window_icon().cloned(),
                ) {
                    window.set_icon(icon).context("设置主窗口图标")?;
                }
                if std::env::args().any(|argument| argument == "--hidden")
                    && let Some(window) = app.get_webview_window("main")
                {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|_window, event| {
            if let WindowEvent::CloseRequested { api: _api, .. } = event {
                #[cfg(desktop)]
                if _window.label() == "main" {
                    let app = _window.app_handle();
                    let state = app.state::<AppState>();
                    if !state.quitting.load(Ordering::Relaxed)
                        && state
                            .database
                            .get_settings()
                            .map(|settings| settings.close_to_tray)
                            .unwrap_or(false)
                    {
                        _api.prevent_close();
                        let _ = _window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_bootstrap,
            commands::tasks::tasks_list,
            commands::tasks::tasks_create,
            commands::tasks::tasks_update,
            commands::tasks::tasks_complete,
            commands::tasks::tasks_delete,
            commands::tasks::tasks_restore,
            commands::tasks::tasks_reorder,
            commands::tasks::lists_list,
            commands::tasks::lists_create,
            commands::tasks::lists_update,
            commands::tasks::lists_delete,
            commands::tasks::tags_list,
            commands::focus::focus_get_state,
            commands::focus::focus_get_stats,
            commands::focus::focus_history,
            commands::focus::focus_start,
            commands::focus::focus_pause,
            commands::focus::focus_resume,
            commands::focus::focus_stop,
            commands::focus::focus_skip,
            commands::settings::settings_get,
            commands::settings::settings_update,
            commands::settings::backup_export,
            commands::settings::backup_import,
            commands::learning::learning_get,
            commands::learning::learning_ensure,
            commands::learning::learning_generate,
            commands::learning::learning_cancel,
            commands::learning::learning_resource_create,
            commands::learning::learning_resource_update,
            commands::learning::learning_resource_delete,
            commands::learning::learning_resource_reorder,
            commands::learning::learning_resource_pin,
            commands::learning::learning_node_upsert,
            commands::learning::learning_node_delete,
            commands::learning::learning_edge_connect,
            commands::learning::learning_edge_disconnect,
            commands::learning::learning_auto_layout,
            commands::learning::learning_node_set_status,
            commands::learning::recommendation_get_settings,
            commands::learning::recommendation_update_settings,
            commands::learning::recommendation_test_connection,
            commands::sync::secrets_status,
            commands::sync::secrets_import_legacy,
            commands::sync::sync_configure,
            commands::sync::sync_test,
            commands::sync::sync_run,
            commands::sync::sync_disconnect,
            commands::sync::sync_get_settings,
            commands::sync::sync_confirm_upgrade,
            commands::sync::sync_get_state,
            commands::sync::sync_list_conflicts,
            commands::sync::sync_resolve_conflict,
            desktop_toggle_mini_window,
            desktop_show_main,
            desktop_open_external,
            desktop_minimize,
            desktop_toggle_maximize,
            desktop_close,
            desktop_platform,
            notifications_prepare,
            media_thumbnail_data_url
        ]);

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .run(tauri::generate_context!())
        .expect("error while running Nudge");
}
