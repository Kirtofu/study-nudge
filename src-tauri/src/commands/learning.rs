use crate::*;

#[tauri::command]
pub(crate) fn learning_get(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<Option<LearningPack>, String> {
    command_result(state.database.get_learning_pack(&task_id))
}

#[tauri::command]
pub(crate) fn learning_ensure(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<LearningPack, String> {
    let result = command_result(state.database.ensure_learning_pack(&task_id));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) async fn learning_generate(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    sections: Option<Vec<String>>,
    include_notes: Option<bool>,
) -> Result<LearningPack, String> {
    let result = async {
        let database = state.database.clone();
        let task = command_result(database.get_task(&task_id))?;
        let mut settings: RecommendationSettings = command_result(
            database.setting("recommendationSettings", RecommendationSettings::default()),
        )?;
        let api_key = command_result(state.secrets.get(API_KEY))?;
        settings.has_api_key = api_key.is_some();
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
            let api_key = api_key.as_ref().map(|value| value.to_string());
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
    .await;
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_cancel(state: State<'_, AppState>, task_id: String) {
    if let Some(cancellation) = state.canceled_learning.lock().get(&task_id) {
        cancellation.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub(crate) fn learning_resource_create(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    input: CreateLearningResourceInput,
) -> Result<LearningResource, String> {
    let result = command_result(state.database.create_learning_resource(&task_id, input));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_resource_update(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    input: UpdateLearningResourceInput,
) -> Result<LearningResource, String> {
    let result = command_result(state.database.update_learning_resource(&id, input));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_resource_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let result = command_result(state.database.delete_learning_resource(&id));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_resource_reorder(
    app: AppHandle,
    state: State<'_, AppState>,
    pack_id: String,
    ids: Vec<String>,
) -> Result<(), String> {
    let result = command_result(state.database.reorder_learning_resources(&pack_id, &ids));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_resource_pin(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<LearningResource, String> {
    let result = command_result(state.database.pin_learning_resource(&id, pinned));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_node_upsert(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    input: UpsertLearningNodeInput,
) -> Result<LearningNode, String> {
    let result = command_result(state.database.upsert_learning_node(&task_id, input));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_node_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let result = command_result(state.database.delete_learning_node(&id));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_edge_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    pack_id: String,
    source_node_id: String,
    target_node_id: String,
) -> Result<LearningEdge, String> {
    let result = command_result(state.database.connect_learning_nodes(
        &pack_id,
        &source_node_id,
        &target_node_id,
    ));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_edge_disconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let result = command_result(state.database.disconnect_learning_edge(&id));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_auto_layout(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<LearningPack, String> {
    let result = command_result(state.database.auto_layout_learning(&task_id));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn learning_node_set_status(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    status: String,
) -> Result<LearningNode, String> {
    let result = command_result(state.database.set_learning_node_status(&id, &status));
    if result.is_ok() {
        emit_data_changed(&app, &["learning"], "local");
    }
    result
}

#[tauri::command]
pub(crate) fn recommendation_get_settings(
    state: State<'_, AppState>,
) -> Result<RecommendationSettings, String> {
    command_result((|| {
        let mut settings: RecommendationSettings = state
            .database
            .setting("recommendationSettings", RecommendationSettings::default())?;
        settings.has_api_key = state.secrets.has(API_KEY);
        Ok(settings)
    })())
}

#[tauri::command]
pub(crate) fn recommendation_update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut input: UpdateRecommendationSettingsInput,
) -> Result<RecommendationSettings, String> {
    let result = command_result((|| {
        if input.clear_api_key.unwrap_or(false) {
            state.secrets.delete(API_KEY)?;
        }
        if let Some(api_key) = input.api_key.take() {
            let api_key = api_key.trim();
            if !api_key.is_empty() {
                state.secrets.set(API_KEY, api_key, true)?;
            }
        }
        input.clear_api_key = None;
        let has_api_key = state.secrets.has(API_KEY);
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
    })());
    if result.is_ok() {
        emit_data_changed(&app, &["recommendation"], "local");
    }
    result
}

#[tauri::command]
pub(crate) async fn recommendation_test_connection(
    state: State<'_, AppState>,
    mut input: Option<UpdateRecommendationSettingsInput>,
) -> Result<OperationResult, String> {
    let supplied_key = input
        .as_mut()
        .and_then(|value| value.api_key.take())
        .filter(|value| !value.trim().is_empty())
        .map(Zeroizing::new);
    let stored_key = command_result(state.secrets.get(API_KEY))?;
    let api_key = supplied_key.as_ref().or(stored_key.as_ref());
    let current: RecommendationSettings = command_result(
        state
            .database
            .setting("recommendationSettings", RecommendationSettings::default()),
    )?;
    let settings = if let Some(input) = input.as_ref() {
        command_result(recommendation::merge_settings(
            current,
            input,
            api_key.is_some(),
        ))?
    } else {
        current
    };
    command_result(
        recommendation::test_connection(&settings, api_key.map(|value| value.as_str())).await,
    )
}
