use crate::*;

#[tauri::command]
pub(crate) fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    command_result(state.database.get_settings())
}

#[tauri::command]
pub(crate) fn settings_update(
    _app: AppHandle,
    state: State<'_, AppState>,
    input: UpdateAppSettingsInput,
) -> Result<AppSettings, String> {
    let result = command_result((|| {
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
    })());
    if result.is_ok() {
        emit_data_changed(&_app, &["settings", "focus"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn backup_export(
    state: State<'_, AppState>,
    path: String,
) -> Result<BackupResult, String> {
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
pub(crate) fn backup_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    mode: String,
) -> Result<BackupResult, String> {
    let result = command_result((|| {
        let metadata = fs::metadata(&path)?;
        if metadata.len() > 100 * 1024 * 1024 {
            anyhow::bail!("备份文件过大");
        }
        let payload: Value = serde_json::from_slice(&fs::read(&path)?)?;
        let imported = state.focus.import_backup(payload, &mode)?;
        Ok(BackupResult {
            canceled: false,
            path: Some(path),
            imported: Some(imported),
        })
    })());
    if result.is_ok() {
        emit_data_changed(
            &app,
            &[
                "tasks",
                "tags",
                "lists",
                "settings",
                "focus",
                "learning",
                "recommendation",
                "sync",
            ],
            "import",
        );
    }
    result
}
