use super::*;

impl Database {
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
            "schemaVersion": 3,
            "exportedAt": now_iso(),
            "data": Value::Object(data)
        }))
    }

    pub(super) fn export_table_locked(
        &self,
        connection: &Connection,
        table: &str,
    ) -> Result<Vec<Value>> {
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
        if !(1..=3).contains(&version) {
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

    pub(super) fn table_columns(connection: &Connection, table: &str) -> Result<HashSet<String>> {
        let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
        Ok(statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<HashSet<_>>>()?)
    }

    pub(super) fn insert_json_row(
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

    pub(super) fn json_to_sql(value: &Value) -> SqlValue {
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
}
