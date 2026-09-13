use crate::*;

#[tauri::command]
pub(crate) fn focus_get_state(state: State<'_, AppState>) -> FocusState {
    state.focus.get_state()
}

#[tauri::command]
pub(crate) fn focus_get_stats(state: State<'_, AppState>) -> Result<FocusStats, String> {
    command_result(state.database.get_focus_stats())
}

#[tauri::command]
pub(crate) fn focus_history(
    state: State<'_, AppState>,
    query: FocusHistoryQuery,
) -> Result<FocusHistoryPage, String> {
    command_result(state.database.get_focus_history(query))
}

#[tauri::command]
pub(crate) fn focus_start(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
    task_id: Option<String>,
    replace_active: Option<bool>,
) -> Result<FocusState, String> {
    let result = (|| {
        let next = command_result(state.focus.start(
            &mode,
            task_id,
            replace_active.unwrap_or(false),
        ))?;
        let _ = app.emit("focus-changed", &next);
        Ok(next)
    })();
    if result.is_ok() {
        emit_data_changed(&app, &["focus"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn focus_pause(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<FocusState, String> {
    let result = (|| {
        let next = command_result(state.focus.pause())?;
        let _ = app.emit("focus-changed", &next);
        Ok(next)
    })();
    if result.is_ok() {
        emit_data_changed(&app, &["focus"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn focus_resume(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<FocusState, String> {
    let result = (|| {
        let next = command_result(state.focus.resume())?;
        let _ = app.emit("focus-changed", &next);
        Ok(next)
    })();
    if result.is_ok() {
        emit_data_changed(&app, &["focus"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn focus_stop(app: AppHandle, state: State<'_, AppState>) -> Result<FocusState, String> {
    let result = (|| {
        let next = command_result(state.focus.stop())?;
        let _ = app.emit("focus-changed", &next);
        Ok(next)
    })();
    if result.is_ok() {
        emit_data_changed(&app, &["focus"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn focus_skip(app: AppHandle, state: State<'_, AppState>) -> Result<FocusState, String> {
    let result = (|| {
        let next = command_result(state.focus.skip())?;
        let _ = app.emit("focus-changed", &next);
        Ok(next)
    })();
    if result.is_ok() {
        emit_data_changed(&app, &["focus"], "local");
    }
    result
}
