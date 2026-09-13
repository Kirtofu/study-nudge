use super::*;

impl Database {
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

    pub fn merge_sync_snapshot(&self, payload: &Value) -> Result<()> {
        let version = payload
            .get("schemaVersion")
            .and_then(Value::as_i64)
            .unwrap_or(1);
        if !(1..=3).contains(&version) {
            bail!("远端同步数据版本不受支持");
        }
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
            ("settings", "settings", "key"),
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
                if table == "settings" && !Self::portable_setting(id) {
                    continue;
                }
                let remote_hlc = remote
                    .get("hlc")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.clock.lock().observe(remote_hlc);
                let mut normalized_remote = remote.clone();
                normalized_remote.insert(
                    "version_vector".into(),
                    Value::String(serde_json::to_string(&row_version(remote))?),
                );
                let local = Self::export_row_by_id(&transaction, table, key_column, id)?;
                let Some(local_payload) = local else {
                    Self::upsert_json_row(
                        &transaction,
                        table,
                        key_column,
                        &normalized_remote,
                        &columns,
                    )?;
                    continue;
                };
                let relation = compare_vectors(
                    &row_version(&local_payload),
                    &row_version(&normalized_remote),
                );
                if relation == VectorRelation::RemoteDominates {
                    Self::upsert_json_row(
                        &transaction,
                        table,
                        key_column,
                        &normalized_remote,
                        &columns,
                    )?;
                    continue;
                }
                if relation == VectorRelation::LocalDominates || local_payload == normalized_remote
                {
                    continue;
                }
                transaction.execute(
                    "INSERT INTO sync_conflicts (id, entity_type, entity_id, local_payload, remote_payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    params![Uuid::new_v4().to_string(), table, id, Value::Object(local_payload.clone()).to_string(), Value::Object(normalized_remote.clone()).to_string(), now_iso()],
                )?;
                let local_hlc = local_payload
                    .get("hlc")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let local_device = local_payload
                    .get("device_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let remote_device = normalized_remote
                    .get("device_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if (remote_hlc, remote_device) > (local_hlc, local_device) {
                    Self::upsert_json_row(
                        &transaction,
                        table,
                        key_column,
                        &normalized_remote,
                        &columns,
                    )?;
                }
            }
        }
        if let Some(task_tags) = data.get("taskTags").and_then(Value::as_array) {
            let columns = Self::table_columns(&transaction, "task_tags")?;
            for remote in task_tags.iter().filter_map(Value::as_object) {
                let (Some(task_id), Some(tag_id)) = (
                    remote.get("task_id").and_then(Value::as_str),
                    remote.get("tag_id").and_then(Value::as_str),
                ) else {
                    continue;
                };
                let remote_hlc = remote
                    .get("hlc")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.clock.lock().observe(remote_hlc);
                let mut normalized_remote = remote.clone();
                normalized_remote.insert(
                    "version_vector".into(),
                    Value::String(serde_json::to_string(&row_version(remote))?),
                );
                let local = Self::export_task_tag(&transaction, task_id, tag_id)?;
                let replace = match local.as_ref() {
                    None => true,
                    Some(local) => {
                        let relation =
                            compare_vectors(&row_version(local), &row_version(&normalized_remote));
                        if relation == VectorRelation::Concurrent
                            || (relation == VectorRelation::Equal && local != &normalized_remote)
                        {
                            transaction.execute(
                                "INSERT INTO sync_conflicts (id, entity_type, entity_id, local_payload, remote_payload, created_at) VALUES (?, 'task_tags', ?, ?, ?, ?)",
                                params![Uuid::new_v4().to_string(), format!("{task_id}:{tag_id}"), Value::Object(local.clone()).to_string(), Value::Object(normalized_remote.clone()).to_string(), now_iso()],
                            )?;
                        }
                        relation == VectorRelation::RemoteDominates
                            || ((relation == VectorRelation::Concurrent
                                || relation == VectorRelation::Equal)
                                && remote_hlc
                                    > local.get("hlc").and_then(Value::as_str).unwrap_or_default())
                    }
                };
                if replace {
                    Self::upsert_task_tag(&transaction, &normalized_remote, &columns)?;
                }
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn export_row_by_id(
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

    pub(super) fn export_task_tag(
        connection: &Connection,
        task_id: &str,
        tag_id: &str,
    ) -> Result<Option<Map<String, Value>>> {
        let mut statement =
            connection.prepare("SELECT * FROM task_tags WHERE task_id = ? AND tag_id = ?")?;
        let columns = statement
            .column_names()
            .iter()
            .map(|name| name.to_string())
            .collect::<Vec<_>>();
        statement
            .query_row(params![task_id, tag_id], |row| {
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

    pub(super) fn upsert_task_tag(
        transaction: &Transaction<'_>,
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
            .filter(|name| !matches!(name.as_str(), "task_id" | "tag_id"))
            .map(|name| format!("{name} = excluded.{name}"))
            .collect::<Vec<_>>()
            .join(", ");
        let placeholders = (0..names.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
        transaction.execute(
            &format!(
                "INSERT INTO task_tags ({}) VALUES ({placeholders}) ON CONFLICT(task_id, tag_id) DO UPDATE SET {assignments}",
                names.join(", ")
            ),
            rusqlite::params_from_iter(values),
        )?;
        Ok(())
    }

    pub(super) fn upsert_json_row(
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
            if conflict.entity_type == "task_tags" {
                Self::upsert_task_tag(&transaction, object, &columns)?;
                let task_id = object
                    .get("task_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("标签关联冲突内容无效"))?;
                let tag_id = object
                    .get("tag_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("标签关联冲突内容无效"))?;
                self.queue_task_tag_change(&transaction, task_id, tag_id)?;
            } else {
                let key_column = if conflict.entity_type == "settings" {
                    "key"
                } else {
                    "id"
                };
                Self::upsert_json_row(
                    &transaction,
                    &conflict.entity_type,
                    key_column,
                    object,
                    &columns,
                )?;
                self.bump_version(
                    &transaction,
                    &conflict.entity_type,
                    key_column,
                    &conflict.entity_id,
                )?;
                self.queue_change_only(&transaction, &conflict.entity_type, &conflict.entity_id)?;
            }
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
        } else if choice == "local" {
            let connection = self.connection.lock();
            if conflict.entity_type == "task_tags" {
                let local = conflict
                    .local_payload
                    .as_object()
                    .ok_or_else(|| anyhow!("本机标签关联冲突内容无效"))?;
                let task_id = local
                    .get("task_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("本机标签关联冲突内容无效"))?;
                let tag_id = local
                    .get("tag_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("本机标签关联冲突内容无效"))?;
                self.queue_task_tag_change(&connection, task_id, tag_id)?;
            } else {
                let key_column = if conflict.entity_type == "settings" {
                    "key"
                } else {
                    "id"
                };
                self.bump_version(
                    &connection,
                    &conflict.entity_type,
                    key_column,
                    &conflict.entity_id,
                )?;
                self.queue_change_only(&connection, &conflict.entity_type, &conflict.entity_id)?;
            }
        } else {
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
                sync_v3_confirmed: false,
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
