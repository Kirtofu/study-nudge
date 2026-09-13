use crate::*;

#[tauri::command]
pub(crate) fn tasks_list(state: State<'_, AppState>) -> Result<Vec<Task>, String> {
    command_result(state.database.list_tasks())
}

#[tauri::command]
pub(crate) fn tasks_create(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateTaskInput,
) -> Result<TaskMutationResult, String> {
    let result = command_result(
        state
            .database
            .create_task(input)
            .map(|task| task_mutation(Some(task), vec![])),
    );
    if result.is_ok() {
        emit_data_changed(&app, &["tasks", "tags"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn tasks_update(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    input: UpdateTaskInput,
) -> Result<TaskMutationResult, String> {
    let result = command_result(
        state
            .database
            .update_task(&id, input)
            .map(|task| task_mutation(Some(task), vec![])),
    );
    if result.is_ok() {
        emit_data_changed(&app, &["tasks", "tags"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn tasks_complete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    completed: bool,
) -> Result<TaskMutationResult, String> {
    let result = command_result(
        state
            .database
            .complete_task(&id, completed)
            .map(|task| task_mutation(Some(task), vec![])),
    );
    if result.is_ok() {
        emit_data_changed(&app, &["tasks", "tags"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn tasks_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<TaskMutationResult, String> {
    let result = command_result(
        state
            .database
            .delete_task(&id)
            .map(|removed| task_mutation(None, removed)),
    );
    if result.is_ok() {
        emit_data_changed(&app, &["tasks", "tags"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn tasks_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<TaskMutationResult, String> {
    let result = command_result(
        state
            .database
            .restore_task(&id)
            .map(|task| task_mutation(Some(task), vec![])),
    );
    if result.is_ok() {
        emit_data_changed(&app, &["tasks", "tags"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn tasks_reorder(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Vec<TaskOrderPatch>, String> {
    let result = command_result(state.database.reorder_tasks(&ids));
    if result.is_ok() {
        emit_data_changed(&app, &["tasks", "tags"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn lists_list(state: State<'_, AppState>) -> Result<Vec<TaskList>, String> {
    command_result(state.database.list_lists())
}

#[tauri::command]
pub(crate) fn lists_create(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<TaskList, String> {
    let result = command_result(state.database.create_list(name));
    if result.is_ok() {
        emit_data_changed(&app, &["tasks", "lists"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn lists_update(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
) -> Result<TaskList, String> {
    let result = command_result(state.database.update_list(&id, name, color));
    if result.is_ok() {
        emit_data_changed(&app, &["tasks", "lists"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn lists_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let result = command_result(state.database.delete_list(&id));
    if result.is_ok() {
        emit_data_changed(&app, &["tasks", "lists"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn tags_list(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    command_result(state.database.list_tags())
}
