mod database;
mod focus;
mod models;
mod recommendation;
mod sync;

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
use database::{Database, LearningGenerationStateUpdate};
use focus::FocusService;
use models::*;
use parking_lot::Mutex;
use recommendation::GeneratedSection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

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
    canceled_learning: Mutex<HashMap<String, Arc<AtomicBool>>>,
    #[cfg(desktop)]
    quitting: AtomicBool,
}

fn command_result<T>(result: anyhow::Result<T>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
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
fn tasks_list(state: State<'_, AppState>) -> Result<Vec<Task>, String> {
    command_result(state.database.list_tasks())
}

#[tauri::command]
fn tasks_create(state: State<'_, AppState>, input: CreateTaskInput) -> Result<Task, String> {
    command_result(state.database.create_task(input))
}

#[tauri::command]
fn tasks_update(
    state: State<'_, AppState>,
    id: String,
    input: UpdateTaskInput,
) -> Result<Task, String> {
    command_result(state.database.update_task(&id, input))
}

#[tauri::command]
fn tasks_complete(state: State<'_, AppState>, id: String, completed: bool) -> Result<Task, String> {
    command_result(state.database.complete_task(&id, completed))
}

#[tauri::command]
fn tasks_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    command_result(state.database.delete_task(&id))
}

#[tauri::command]
fn tasks_restore(state: State<'_, AppState>, id: String) -> Result<Task, String> {
    command_result(state.database.restore_task(&id))
}

#[tauri::command]
fn tasks_reorder(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    command_result(state.database.reorder_tasks(&ids))
}

#[tauri::command]
fn lists_list(state: State<'_, AppState>) -> Result<Vec<TaskList>, String> {
    command_result(state.database.list_lists())
}

#[tauri::command]
fn lists_create(state: State<'_, AppState>, name: String) -> Result<TaskList, String> {
    command_result(state.database.create_list(name))
}

#[tauri::command]
fn lists_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
) -> Result<TaskList, String> {
    command_result(state.database.update_list(&id, name, color))
}

#[tauri::command]
fn lists_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    command_result(state.database.delete_list(&id))
}

#[tauri::command]
fn tags_list(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    command_result(state.database.list_tags())
}

#[tauri::command]
fn focus_get_state(state: State<'_, AppState>) -> FocusState {
    state.focus.get_state()
}

#[tauri::command]
fn focus_get_stats(state: State<'_, AppState>) -> Result<FocusStats, String> {
    command_result(state.database.get_focus_stats())
}

#[tauri::command]
fn focus_start(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
    task_id: Option<String>,
) -> Result<FocusState, String> {
    let next = command_result(state.focus.start(&mode, task_id))?;
    let _ = app.emit("focus-changed", &next);
    Ok(next)
}

#[tauri::command]
fn focus_pause(app: AppHandle, state: State<'_, AppState>) -> Result<FocusState, String> {
    let next = command_result(state.focus.pause())?;
    let _ = app.emit("focus-changed", &next);
    Ok(next)
}

#[tauri::command]
fn focus_resume(app: AppHandle, state: State<'_, AppState>) -> Result<FocusState, String> {
    let next = command_result(state.focus.resume())?;
    let _ = app.emit("focus-changed", &next);
    Ok(next)
}

#[tauri::command]
fn focus_stop(app: AppHandle, state: State<'_, AppState>) -> Result<FocusState, String> {
    let next = command_result(state.focus.stop())?;
    let _ = app.emit("focus-changed", &next);
    Ok(next)
}

#[tauri::command]
fn focus_skip(app: AppHandle, state: State<'_, AppState>) -> Result<FocusState, String> {
    let next = command_result(state.focus.skip())?;
    let _ = app.emit("focus-changed", &next);
    Ok(next)
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    command_result(state.database.get_settings())
}

#[tauri::command]
fn settings_update(
    _app: AppHandle,
    state: State<'_, AppState>,
    input: UpdateAppSettingsInput,
) -> Result<AppSettings, String> {
    command_result((|| {
        #[cfg(desktop)]
        let previous = state.database.get_settings()?;
        let next = state.database.update_settings(input)?;
        #[cfg(desktop)]
        if let Err(error) = apply_desktop_preferences(&_app, &next) {
            let _ = state
                .database
                .update_settings(settings_as_update(&previous));
            let _ = apply_desktop_preferences(&_app, &previous);
            return Err(error);
        }
        Ok(next)
    })())
}

#[tauri::command]
fn backup_export(state: State<'_, AppState>, path: String) -> Result<BackupResult, String> {
    command_result((|| {
        let payload = state.database.export_json()?;
        fs::write(&path, serde_json::to_vec_pretty(&payload)?)?;
        Ok(BackupResult {
            canceled: false,
            path: Some(path),
            imported: None,
        })
    })())
}

#[tauri::command]
fn backup_import(
    state: State<'_, AppState>,
    path: String,
    mode: String,
) -> Result<BackupResult, String> {
    command_result((|| {
        let metadata = fs::metadata(&path)?;
        if metadata.len() > 100 * 1024 * 1024 {
            anyhow::bail!("备份文件过大");
        }
        let payload: Value = serde_json::from_slice(&fs::read(&path)?)?;
        let imported = state.database.import_json(payload, &mode)?;
        Ok(BackupResult {
            canceled: false,
            path: Some(path),
            imported: Some(imported),
        })
    })())
}

#[tauri::command]
fn learning_get(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<Option<LearningPack>, String> {
    command_result(state.database.get_learning_pack(&task_id))
}

#[tauri::command]
fn learning_ensure(state: State<'_, AppState>, task_id: String) -> Result<LearningPack, String> {
    command_result(state.database.ensure_learning_pack(&task_id))
}

#[tauri::command]
async fn learning_generate(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    sections: Option<Vec<String>>,
    include_notes: Option<bool>,
    api_key: Option<String>,
) -> Result<LearningPack, String> {
    let database = state.database.clone();
    let task = command_result(database.get_task(&task_id))?;
    let mut settings: RecommendationSettings = command_result(
        database.setting("recommendationSettings", RecommendationSettings::default()),
    )?;
    settings.has_api_key = api_key.as_ref().is_some_and(|value| !value.is_empty());
    let pack = command_result(database.ensure_learning_pack(&task_id))?;
    if settings.provider == "offline" {
        return Ok(pack);
    }
    let generation_id = Uuid::new_v4().to_string();
    let cancellation = Arc::new(AtomicBool::new(false));
    if let Some(previous) = state
        .canceled_learning
        .lock()
        .insert(task_id.clone(), cancellation.clone())
    {
        previous.store(true, Ordering::Relaxed);
    }
    let requested =
        sections.unwrap_or_else(|| vec!["resources".into(), "videos".into(), "roadmap".into()]);
    let requested = requested
        .into_iter()
        .filter(|section| matches!(section.as_str(), "resources" | "videos" | "roadmap"))
        .collect::<Vec<_>>();
    let mut completed = vec![];
    let mut failed = vec![];
    let mut canceled_count = 0_usize;
    command_result(database.set_learning_generation_state(
        &task_id,
        LearningGenerationStateUpdate {
            status: "generating",
            provider: &settings.provider,
            model: Some(&settings.model),
            generation_id: Some(&generation_id),
            completed_sections: &completed,
            failed_sections: &failed,
        },
    ))?;

    let mut jobs = tokio::task::JoinSet::new();
    for section in requested {
        let _ = app.emit(
            "learning-progress",
            LearningProgressEvent {
                task_id: task_id.clone(),
                pack_id: pack.id.clone(),
                generation_id: generation_id.clone(),
                section: section.clone(),
                state: "generating".into(),
                message: match section.as_str() {
                    "resources" => "正在整理资料与工具",
                    "videos" => "正在筛选学习视频",
                    _ => "正在规划学习路线",
                }
                .into(),
            },
        );
        let task = task.clone();
        let settings = settings.clone();
        let api_key = api_key.clone();
        let cancellation = cancellation.clone();
        let include_notes = include_notes.unwrap_or(false);
        jobs.spawn(async move {
            let requested_section = section.clone();
            let generation = recommendation::generate_section(
                &task,
                &requested_section,
                &settings,
                api_key.as_deref(),
                include_notes,
            );
            tokio::pin!(generation);
            loop {
                tokio::select! {
                    result = &mut generation => break (section, Some(result)),
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        if cancellation.load(Ordering::Relaxed) {
                            break (section, None);
                        }
                    }
                }
            }
        });
    }

    while let Some(joined) = jobs.join_next().await {
        let (section, result) = match joined {
            Ok(value) => value,
            Err(error) => {
                failed.push("unknown".into());
                let _ = app.emit(
                    "learning-progress",
                    LearningProgressEvent {
                        task_id: task_id.clone(),
                        pack_id: pack.id.clone(),
                        generation_id: generation_id.clone(),
                        section: "roadmap".into(),
                        state: "error".into(),
                        message: format!("生成任务意外停止：{error}"),
                    },
                );
                continue;
            }
        };
        let Some(result) = result else {
            canceled_count += 1;
            failed.push(section.clone());
            let _ = app.emit(
                "learning-progress",
                LearningProgressEvent {
                    task_id: task_id.clone(),
                    pack_id: pack.id.clone(),
                    generation_id: generation_id.clone(),
                    section,
                    state: "canceled".into(),
                    message: "已取消这一栏的生成".into(),
                },
            );
            continue;
        };
        match result {
            Ok(GeneratedSection::Resources(resources)) => {
                command_result(database.replace_generated_section(
                    &task_id,
                    "resources",
                    &resources,
                    &[],
                ))?;
                completed.push(section.clone());
                let _ = app.emit(
                    "learning-progress",
                    LearningProgressEvent {
                        task_id: task_id.clone(),
                        pack_id: pack.id.clone(),
                        generation_id: generation_id.clone(),
                        section,
                        state: "success".into(),
                        message: "资料与工具已经更新".into(),
                    },
                );
            }
            Ok(GeneratedSection::Videos(resources)) => {
                command_result(database.replace_generated_section(
                    &task_id,
                    "videos",
                    &resources,
                    &[],
                ))?;
                completed.push(section.clone());
                let _ = app.emit(
                    "learning-progress",
                    LearningProgressEvent {
                        task_id: task_id.clone(),
                        pack_id: pack.id.clone(),
                        generation_id: generation_id.clone(),
                        section,
                        state: "success".into(),
                        message: "视频推荐已经更新".into(),
                    },
                );
            }
            Ok(GeneratedSection::Roadmap(nodes)) => {
                command_result(database.replace_generated_section(
                    &task_id,
                    "roadmap",
                    &[],
                    &nodes,
                ))?;
                completed.push(section.clone());
                let _ = app.emit(
                    "learning-progress",
                    LearningProgressEvent {
                        task_id: task_id.clone(),
                        pack_id: pack.id.clone(),
                        generation_id: generation_id.clone(),
                        section,
                        state: "success".into(),
                        message: "学习路线已经更新".into(),
                    },
                );
            }
            Err(error) => {
                failed.push(section.clone());
                let _ = app.emit(
                    "learning-progress",
                    LearningProgressEvent {
                        task_id: task_id.clone(),
                        pack_id: pack.id.clone(),
                        generation_id: generation_id.clone(),
                        section,
                        state: "error".into(),
                        message: error.to_string(),
                    },
                );
            }
        }
    }

    let status = if failed.is_empty() {
        "ready"
    } else if completed.is_empty() && canceled_count == 0 {
        "error"
    } else {
        "partial"
    };
    let mut cancellations = state.canceled_learning.lock();
    if cancellations
        .get(&task_id)
        .is_some_and(|current| Arc::ptr_eq(current, &cancellation))
    {
        cancellations.remove(&task_id);
    }
    drop(cancellations);
    command_result(database.set_learning_generation_state(
        &task_id,
        LearningGenerationStateUpdate {
            status,
            provider: &settings.provider,
            model: Some(&settings.model),
            generation_id: Some(&generation_id),
            completed_sections: &completed,
            failed_sections: &failed,
        },
    ))
}

#[tauri::command]
fn learning_cancel(state: State<'_, AppState>, task_id: String) {
    if let Some(cancellation) = state.canceled_learning.lock().get(&task_id) {
        cancellation.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
fn learning_resource_create(
    state: State<'_, AppState>,
    task_id: String,
    input: CreateLearningResourceInput,
) -> Result<LearningResource, String> {
    command_result(state.database.create_learning_resource(&task_id, input))
}

#[tauri::command]
fn learning_resource_update(
    state: State<'_, AppState>,
    id: String,
    input: UpdateLearningResourceInput,
) -> Result<LearningResource, String> {
    command_result(state.database.update_learning_resource(&id, input))
}

#[tauri::command]
fn learning_resource_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    command_result(state.database.delete_learning_resource(&id))
}

#[tauri::command]
fn learning_resource_reorder(
    state: State<'_, AppState>,
    pack_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    command_result(state.database.reorder_learning_resources(&pack_id, &ids))
}

#[tauri::command]
fn learning_resource_pin(
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<LearningResource, String> {
    command_result(state.database.pin_learning_resource(&id, pinned))
}

#[tauri::command]
fn learning_node_upsert(
    state: State<'_, AppState>,
    task_id: String,
    input: UpsertLearningNodeInput,
) -> Result<LearningNode, String> {
    command_result(state.database.upsert_learning_node(&task_id, input))
}

#[tauri::command]
fn learning_node_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    command_result(state.database.delete_learning_node(&id))
}

#[tauri::command]
fn learning_edge_connect(
    state: State<'_, AppState>,
    pack_id: String,
    source_node_id: String,
    target_node_id: String,
) -> Result<LearningEdge, String> {
    command_result(state.database.connect_learning_nodes(
        &pack_id,
        &source_node_id,
        &target_node_id,
    ))
}

#[tauri::command]
fn learning_edge_disconnect(state: State<'_, AppState>, id: String) -> Result<(), String> {
    command_result(state.database.disconnect_learning_edge(&id))
}

#[tauri::command]
fn learning_auto_layout(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<LearningPack, String> {
    command_result(state.database.auto_layout_learning(&task_id))
}

#[tauri::command]
fn learning_node_set_status(
    state: State<'_, AppState>,
    id: String,
    status: String,
) -> Result<LearningNode, String> {
    command_result(state.database.set_learning_node_status(&id, &status))
}

#[tauri::command]
fn recommendation_get_settings(
    state: State<'_, AppState>,
    has_api_key: bool,
) -> Result<RecommendationSettings, String> {
    command_result((|| {
        let mut settings: RecommendationSettings = state
            .database
            .setting("recommendationSettings", RecommendationSettings::default())?;
        settings.has_api_key = has_api_key;
        Ok(settings)
    })())
}

#[tauri::command]
fn recommendation_update_settings(
    state: State<'_, AppState>,
    input: UpdateRecommendationSettingsInput,
    has_api_key: bool,
) -> Result<RecommendationSettings, String> {
    command_result((|| {
        let current: RecommendationSettings = state
            .database
            .setting("recommendationSettings", RecommendationSettings::default())?;
        let mut next = recommendation::merge_settings(current, &input, has_api_key)?;
        next.has_api_key = false;
        state
            .database
            .set_setting("recommendationSettings", &next)?;
        next.has_api_key = has_api_key;
        Ok(next)
    })())
}

#[tauri::command]
async fn recommendation_test_connection(
    state: State<'_, AppState>,
    input: Option<UpdateRecommendationSettingsInput>,
    api_key: Option<String>,
) -> Result<OperationResult, String> {
    let current: RecommendationSettings = command_result(
        state
            .database
            .setting("recommendationSettings", RecommendationSettings::default()),
    )?;
    let settings = if let Some(input) = input.as_ref() {
        command_result(recommendation::merge_settings(
            current,
            input,
            api_key.as_ref().is_some_and(|value| !value.is_empty()),
        ))?
    } else {
        current
    };
    command_result(recommendation::test_connection(&settings, api_key.as_deref()).await)
}

#[tauri::command]
fn sync_configure(
    state: State<'_, AppState>,
    input: ConfigureSyncInput,
) -> Result<SyncSettings, String> {
    command_result((|| {
        sync::validate_configuration(&input)?;
        let current = state.database.get_sync_settings()?;
        let settings = sync::to_settings(&input, current.device_id);
        state.database.set_sync_settings(&settings)?;
        let mut sync_state = state.database.get_sync_state()?;
        sync_state.status = "idle".into();
        sync_state.last_error = None;
        state.database.set_sync_state(&sync_state)?;
        Ok(settings)
    })())
}

#[tauri::command]
async fn sync_test(input: ConfigureSyncInput) -> Result<OperationResult, String> {
    command_result(sync::test_webdav(&input).await)
}

#[tauri::command]
async fn sync_run(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
    passphrase: String,
) -> Result<SyncState, String> {
    let settings = command_result(state.database.get_sync_settings())?;
    let database = state.database.clone();
    let running = command_result(database.get_sync_state())?;
    let _ = app.emit(
        "sync-state-changed",
        SyncState {
            status: "syncing".into(),
            ..running
        },
    );
    match sync::run_sync(database.clone(), &settings, &password, &passphrase).await {
        Ok(next) => {
            let _ = app.emit("sync-state-changed", &next);
            Ok(next)
        }
        Err(error) => {
            let mut next = database.get_sync_state().unwrap_or_default();
            if next.status == "syncing" {
                next.status = "error".into();
                next.last_error = Some(error.to_string());
                let _ = database.set_sync_state(&next);
            }
            let _ = app.emit("sync-state-changed", &next);
            Err(error.to_string())
        }
    }
}

#[tauri::command]
fn sync_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    command_result((|| {
        let current = state.database.get_sync_settings()?;
        state.database.set_sync_settings(&SyncSettings {
            enabled: false,
            server_url: String::new(),
            username: String::new(),
            remote_path: "Nudge/nudge-v2.enc".into(),
            remember_passphrase: false,
            has_credentials: false,
            device_id: current.device_id,
            device_name: current.device_name,
        })?;
        state.database.set_sync_state(&SyncState::default())?;
        Ok(())
    })())
}

#[tauri::command]
fn sync_get_settings(
    state: State<'_, AppState>,
    has_credentials: bool,
) -> Result<SyncSettings, String> {
    command_result((|| {
        let mut settings = state.database.get_sync_settings()?;
        settings.has_credentials = has_credentials;
        Ok(settings)
    })())
}

#[tauri::command]
fn sync_get_state(state: State<'_, AppState>) -> Result<SyncState, String> {
    command_result(state.database.get_sync_state())
}

#[tauri::command]
fn sync_list_conflicts(state: State<'_, AppState>) -> Result<Vec<SyncConflict>, String> {
    command_result(state.database.list_conflicts())
}

#[tauri::command]
fn sync_resolve_conflict(
    state: State<'_, AppState>,
    id: String,
    choice: String,
) -> Result<(), String> {
    command_result(state.database.resolve_conflict(&id, &choice))
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

fn app_paths(app: &AppHandle) -> anyhow::Result<(PathBuf, Option<PathBuf>, Vec<PathBuf>)> {
    let app_data = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data)?;
    let database_path = app_data.join("nudge.db");
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
            if let Ok(reminders) = database.due_reminders() {
                for (id, title, notes) in reminders {
                    let _ = app_handle
                        .notification()
                        .builder()
                        .title(&title)
                        .body(if notes.is_empty() {
                            "这是你之前设置的任务提醒。"
                        } else {
                            &notes
                        })
                        .show();
                    let _ = database.mark_reminder_notified(&id);
                }
            }
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
            let _ = database.create_database_backup(false);
            let focus = Arc::new(FocusService::new(database.clone()).context("恢复专注计时状态")?);
            setup_background_services(app.handle(), focus.clone(), database.clone());
            #[cfg(desktop)]
            let settings = database.get_settings()?;
            app.manage(AppState {
                database,
                focus,
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
            tasks_list,
            tasks_create,
            tasks_update,
            tasks_complete,
            tasks_delete,
            tasks_restore,
            tasks_reorder,
            lists_list,
            lists_create,
            lists_update,
            lists_delete,
            tags_list,
            focus_get_state,
            focus_get_stats,
            focus_start,
            focus_pause,
            focus_resume,
            focus_stop,
            focus_skip,
            settings_get,
            settings_update,
            backup_export,
            backup_import,
            learning_get,
            learning_ensure,
            learning_generate,
            learning_cancel,
            learning_resource_create,
            learning_resource_update,
            learning_resource_delete,
            learning_resource_reorder,
            learning_resource_pin,
            learning_node_upsert,
            learning_node_delete,
            learning_edge_connect,
            learning_edge_disconnect,
            learning_auto_layout,
            learning_node_set_status,
            recommendation_get_settings,
            recommendation_update_settings,
            recommendation_test_connection,
            sync_configure,
            sync_test,
            sync_run,
            sync_disconnect,
            sync_get_settings,
            sync_get_state,
            sync_list_conflicts,
            sync_resolve_conflict,
            desktop_toggle_mini_window,
            desktop_show_main,
            desktop_open_external,
            desktop_minimize,
            desktop_toggle_maximize,
            desktop_close,
            desktop_platform,
            notifications_prepare
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
