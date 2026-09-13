use crate::*;

#[tauri::command]
pub(crate) fn sync_configure(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ConfigureSyncInput,
) -> Result<SyncSettings, String> {
    let result = command_result((|| {
        sync::validate_configuration(&input)?;
        state.secrets.set(WEBDAV_PASSWORD, &input.password, true)?;
        state.secrets.set(
            SYNC_PASSPHRASE,
            &input.passphrase,
            input.remember_passphrase,
        )?;
        let current = state.database.get_sync_settings()?;
        let settings = sync::to_settings(&input, current.device_id);
        state.database.set_sync_settings(&settings)?;
        let mut sync_state = state.database.get_sync_state()?;
        sync_state.status = "idle".into();
        sync_state.last_error = None;
        state.database.set_sync_state(&sync_state)?;
        Ok(settings)
    })());
    if result.is_ok() {
        emit_data_changed(&app, &["sync"], "local");
    }
    result
}

#[tauri::command]
pub(crate) async fn sync_test(
    state: State<'_, AppState>,
    input: Option<ConfigureSyncInput>,
) -> Result<OperationResult, String> {
    if let Some(input) = input {
        return command_result(sync::test_webdav(&input).await);
    }
    let settings = command_result(state.database.get_sync_settings())?;
    let password = command_result(state.secrets.get(WEBDAV_PASSWORD))?
        .ok_or_else(|| "WebDAV 密码未保存，请重新配置同步".to_string())?;
    let passphrase = command_result(state.secrets.get(SYNC_PASSPHRASE))?
        .ok_or_else(|| "请输入同步口令后再测试".to_string())?;
    let input = ConfigureSyncInput {
        server_url: settings.server_url,
        username: settings.username,
        password: password.to_string(),
        passphrase: passphrase.to_string(),
        remote_path: settings.remote_path,
        remember_passphrase: settings.remember_passphrase,
        device_name: settings.device_name,
    };
    command_result(sync::test_webdav(&input).await)
}

#[tauri::command]
pub(crate) async fn sync_run(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SyncState, String> {
    let result = async {
        let password = command_result(state.secrets.get(WEBDAV_PASSWORD))?
            .ok_or_else(|| "WebDAV 密码未保存，请重新配置同步".to_string())?;
        let passphrase = command_result(state.secrets.get(SYNC_PASSPHRASE))?
            .ok_or_else(|| "请输入同步口令后再同步".to_string())?;
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
    .await;
    if result.is_ok() {
        emit_data_changed(
            &app,
            &["tasks", "tags", "lists", "settings", "focus", "learning"],
            "sync",
        );
    }
    result
}

#[tauri::command]
pub(crate) fn sync_disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let result = command_result((|| {
        state.secrets.delete(WEBDAV_PASSWORD)?;
        state.secrets.delete(SYNC_PASSPHRASE)?;
        let current = state.database.get_sync_settings()?;
        state.database.set_sync_settings(&SyncSettings {
            enabled: false,
            server_url: String::new(),
            username: String::new(),
            remote_path: "Nudge/nudge-v2.enc".into(),
            remember_passphrase: false,
            sync_v3_confirmed: false,
            has_credentials: false,
            device_id: current.device_id,
            device_name: current.device_name,
        })?;
        state.database.set_sync_state(&SyncState::default())?;
        Ok(())
    })());
    if result.is_ok() {
        emit_data_changed(&app, &["sync"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn sync_get_settings(state: State<'_, AppState>) -> Result<SyncSettings, String> {
    command_result((|| {
        let mut settings = state.database.get_sync_settings()?;
        settings.has_credentials = state.secrets.has(WEBDAV_PASSWORD);
        Ok(settings)
    })())
}

#[tauri::command]
pub(crate) fn sync_confirm_upgrade(state: State<'_, AppState>) -> Result<SyncSettings, String> {
    command_result((|| {
        let mut settings = state.database.get_sync_settings()?;
        settings.sync_v3_confirmed = true;
        state.database.set_sync_settings(&settings)?;
        Ok(settings)
    })())
}

#[tauri::command]
pub(crate) fn secrets_status(state: State<'_, AppState>) -> Result<SecretStoreStatus, String> {
    let migration = state
        .database
        .setting("secretMigration", "not-needed".to_string())
        .unwrap_or_else(|_| "unknown".into());
    Ok(state.secrets.status(&migration))
}

#[tauri::command]
pub(crate) fn secrets_import_legacy(
    app: AppHandle,
    state: State<'_, AppState>,
    input: LegacySecretsInput,
) -> Result<SecretStoreStatus, String> {
    command_result((|| {
        if let Some(value) = input
            .recommendation_api_key
            .filter(|value| !value.is_empty())
        {
            state.secrets.set(API_KEY, &value, true)?;
        }
        if let Some(value) = input.webdav_password.filter(|value| !value.is_empty()) {
            state.secrets.set(WEBDAV_PASSWORD, &value, true)?;
        }
        if let Some(value) = input.sync_passphrase.filter(|value| !value.is_empty()) {
            let remember = state.database.get_sync_settings()?.remember_passphrase;
            state.secrets.set(SYNC_PASSPHRASE, &value, remember)?;
        }
        let vault = data_directory(&app)?.join("nudge-vault.hold");
        if vault.exists() {
            fs::remove_file(&vault).context("新密钥验证成功，但旧密钥库未能删除")?;
        }
        state
            .database
            .set_setting("secretMigration", &"completed")?;
        Ok(state.secrets.status("completed"))
    })())
}

#[tauri::command]
pub(crate) fn sync_get_state(state: State<'_, AppState>) -> Result<SyncState, String> {
    command_result(state.database.get_sync_state())
}

#[tauri::command]
pub(crate) fn sync_list_conflicts(state: State<'_, AppState>) -> Result<Vec<SyncConflict>, String> {
    command_result(state.database.list_conflicts())
}

#[tauri::command]
pub(crate) fn sync_resolve_conflict(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    choice: String,
) -> Result<(), String> {
    let result = command_result(state.database.resolve_conflict(&id, &choice));
    if result.is_ok() {
        emit_data_changed(
            &app,
            &["tasks", "tags", "lists", "settings", "focus", "learning"],
            "local",
        );
    }
    result
}
