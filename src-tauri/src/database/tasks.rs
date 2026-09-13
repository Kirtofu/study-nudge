use super::*;

impl Database {
    pub fn list_lists(&self) -> Result<Vec<TaskList>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, name, color, position, created_at, updated_at FROM lists WHERE tombstone = 0 ORDER BY position, name",
        )?;
        Ok(statement
            .query_map([], |row| {
                Ok(TaskList {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    position: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn create_list(&self, name: String) -> Result<TaskList> {
        let name = clean_text(&name, 80);
        if name.is_empty() {
            bail!("清单名称不能为空");
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now_iso();
        let connection = self.connection.lock();
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM lists WHERE tombstone = 0",
            [],
            |row| row.get(0),
        )?;
        let colors = [ACCENT, SUCCESS, INFO, WARNING, MAUVE];
        connection.execute(
            r#"INSERT INTO lists (id, name, color, position, is_system, created_at, updated_at, revision, device_id, hlc, tombstone)
               VALUES (?, ?, ?, ?, 0, ?, ?, 1, ?, ?, 0)"#,
            params![id, name, colors[count as usize % colors.len()], count, timestamp, timestamp, self.device_id, self.hlc()],
        )?;
        self.queue_change(&connection, "lists", &id)?;
        drop(connection);
        self.get_list(&id)
    }

    pub fn update_list(
        &self,
        id: &str,
        name: Option<String>,
        color: Option<String>,
    ) -> Result<TaskList> {
        let current = self.get_list(id)?;
        let name = name
            .map(|value| clean_text(&value, 80))
            .unwrap_or(current.name);
        if name.is_empty() {
            bail!("清单名称不能为空");
        }
        let color = color.unwrap_or(current.color);
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE lists SET name = ?, color = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![name, color, now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "lists", id)?;
        drop(connection);
        self.get_list(id)
    }

    pub fn delete_list(&self, id: &str) -> Result<()> {
        if id == "inbox" {
            bail!("收集箱不能删除");
        }
        self.get_list(id)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let timestamp = now_iso();
        let hlc = self.hlc();
        transaction.execute(
            "UPDATE tasks SET list_id = 'inbox', updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE list_id = ?",
            params![timestamp, self.device_id, hlc, id],
        )?;
        transaction.execute(
            "UPDATE lists SET tombstone = 1, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![timestamp, self.device_id, hlc, id],
        )?;
        self.queue_change(&transaction, "lists", id)?;
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn get_list(&self, id: &str) -> Result<TaskList> {
        self.connection
            .lock()
            .query_row(
                "SELECT id, name, color, position, created_at, updated_at FROM lists WHERE id = ? AND tombstone = 0",
                [id],
                |row| {
                    Ok(TaskList {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        color: row.get(2)?,
                        position: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!("找不到该清单"))
    }

    pub fn list_tags(&self) -> Result<Vec<Tag>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, name, color FROM tags WHERE tombstone = 0 ORDER BY name COLLATE NOCASE",
        )?;
        Ok(statement
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>> {
        self.list_tasks_internal(false)
    }

    pub(super) fn list_tasks_internal(&self, include_deleted: bool) -> Result<Vec<Task>> {
        let connection = self.connection.lock();
        let filter = if include_deleted {
            "tombstone = 0"
        } else {
            "tombstone = 0 AND status != 'deleted'"
        };
        let mut statement = connection.prepare(&format!(
            r#"SELECT id, list_id, parent_id, title, notes, status, scheduled_for, due_at,
                      reminder_at, priority, estimate_minutes, position, completed_at, deleted_at,
                      created_at, updated_at FROM tasks WHERE {filter} ORDER BY position, created_at, id"#
        ))?;
        let mut tasks = statement
            .query_map([], |row| self.map_task_row(row))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut tag_statement = connection.prepare(
            r#"SELECT tt.task_id, t.id, t.name, t.color FROM task_tags tt
               JOIN tags t ON t.id = tt.tag_id
               WHERE tt.tombstone = 0 AND t.tombstone = 0 ORDER BY t.name"#,
        )?;
        let tag_rows = tag_statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Tag {
                        id: row.get(1)?,
                        name: row.get(2)?,
                        color: row.get(3)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let known_ids = connection
            .prepare("SELECT id FROM tasks")?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        drop(tag_statement);
        drop(statement);
        drop(connection);

        let mut tags_by_task: HashMap<String, Vec<Tag>> = HashMap::new();
        for (task_id, tag) in tag_rows {
            tags_by_task.entry(task_id).or_default().push(tag);
        }
        for task in &mut tasks {
            task.tags = tags_by_task.remove(&task.id).unwrap_or_default();
        }

        let ids = tasks
            .iter()
            .map(|task| task.id.clone())
            .collect::<HashSet<_>>();
        let mut by_parent: HashMap<Option<String>, Vec<Task>> = HashMap::new();
        for mut task in tasks {
            if task
                .parent_id
                .as_ref()
                .is_some_and(|parent| !ids.contains(parent))
            {
                if task
                    .parent_id
                    .as_ref()
                    .is_some_and(|parent| known_ids.contains(parent))
                {
                    continue;
                }
                task.parent_id = None;
            }
            by_parent
                .entry(task.parent_id.clone())
                .or_default()
                .push(task);
        }

        fn attach(
            parent: Option<String>,
            by_parent: &mut HashMap<Option<String>, Vec<Task>>,
        ) -> Vec<Task> {
            let mut items = by_parent.remove(&parent).unwrap_or_default();
            for item in &mut items {
                item.subtasks = attach(Some(item.id.clone()), by_parent);
            }
            items
        }
        Ok(attach(None, &mut by_parent))
    }

    pub(super) fn map_task_row(&self, row: &Row<'_>) -> rusqlite::Result<Task> {
        Ok(Task {
            id: row.get(0)?,
            list_id: row.get(1)?,
            parent_id: row.get(2)?,
            title: row.get(3)?,
            notes: row.get(4)?,
            status: row.get(5)?,
            scheduled_for: row.get(6)?,
            due_at: row.get(7)?,
            reminder_at: row.get(8)?,
            priority: row.get(9)?,
            estimate_minutes: row.get(10)?,
            position: row.get(11)?,
            completed_at: row.get(12)?,
            deleted_at: row.get(13)?,
            created_at: row.get(14)?,
            updated_at: row.get(15)?,
            tags: vec![],
            subtasks: vec![],
        })
    }

    pub fn get_task(&self, id: &str) -> Result<Task> {
        fn find<'a>(tasks: &'a [Task], id: &str) -> Option<&'a Task> {
            for task in tasks {
                if task.id == id {
                    return Some(task);
                }
                if let Some(found) = find(&task.subtasks, id) {
                    return Some(found);
                }
            }
            None
        }
        let tasks = self.list_tasks_internal(true)?;
        find(&tasks, id)
            .cloned()
            .ok_or_else(|| anyhow!("找不到该任务"))
    }

    pub fn create_task(&self, input: CreateTaskInput) -> Result<Task> {
        let title = clean_text(&input.title, 240);
        if title.is_empty() {
            bail!("请输入任务标题");
        }
        let notes = input
            .notes
            .map(|value| clean_notes(&value))
            .unwrap_or_default();
        let list_id = input.list_id.unwrap_or_else(|| "inbox".into());
        self.get_list(&list_id)?;
        let priority = input.priority.unwrap_or_else(|| "none".into());
        validate_priority(&priority)?;
        if input
            .estimate_minutes
            .is_some_and(|value| !(1..=100_000).contains(&value))
        {
            bail!("预计时长无效");
        }
        if let Some(parent) = input.parent_id.as_ref() {
            self.get_task(parent)?;
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now_iso();
        let mut guard = self.connection.lock();
        let connection = guard.transaction()?;
        let max_position: f64 = connection.query_row(
            "SELECT COALESCE(MAX(position), 0) FROM tasks WHERE parent_id IS ?",
            [input.parent_id.as_deref()],
            |row| row.get(0),
        )?;
        connection.execute(
            r#"INSERT INTO tasks (
                 id, list_id, parent_id, title, notes, status, scheduled_for, due_at, reminder_at,
                 priority, estimate_minutes, position, created_at, updated_at, revision, device_id, hlc, tombstone
               ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)"#,
            params![id, list_id, input.parent_id, title, notes, input.scheduled_for, input.due_at,
                    input.reminder_at, priority, input.estimate_minutes, max_position + 1000.0,
                    timestamp, timestamp, self.device_id, self.hlc()],
        )?;
        self.replace_task_tags_locked(&connection, &id, &input.tag_names)?;
        self.queue_change(&connection, "tasks", &id)?;
        connection.commit()?;
        drop(guard);
        self.get_task(&id)
    }

    pub fn update_task(&self, id: &str, input: UpdateTaskInput) -> Result<Task> {
        self.get_task(id)?;
        let mut fields: Vec<String> = vec![];
        let mut values: Vec<SqlValue> = vec![];
        if let Some(title) = input.title {
            let title = clean_text(&title, 240);
            if title.is_empty() {
                bail!("任务标题不能为空");
            }
            fields.push("title = ?".into());
            values.push(title.into());
        }
        if let Some(notes) = input.notes {
            fields.push("notes = ?".into());
            values.push(clean_notes(&notes).into());
        }
        if let Some(list_id) = input.list_id {
            self.get_list(&list_id)?;
            fields.push("list_id = ?".into());
            values.push(list_id.into());
        }
        for (column, value) in [
            ("parent_id", input.parent_id),
            ("scheduled_for", input.scheduled_for),
            ("due_at", input.due_at),
            ("reminder_at", input.reminder_at),
        ] {
            if let Some(value) = value {
                fields.push(format!("{column} = ?"));
                values.push(value.map(SqlValue::Text).unwrap_or(SqlValue::Null));
                if column == "reminder_at" {
                    fields.push("notified_at = NULL".into());
                }
            }
        }
        if let Some(priority) = input.priority {
            validate_priority(&priority)?;
            fields.push("priority = ?".into());
            values.push(priority.into());
        }
        if let Some(estimate) = input.estimate_minutes {
            if estimate.is_some_and(|value| !(1..=100_000).contains(&value)) {
                bail!("预计时长无效");
            }
            fields.push("estimate_minutes = ?".into());
            values.push(estimate.map(SqlValue::Integer).unwrap_or(SqlValue::Null));
        }
        if let Some(status) = input.status {
            validate_task_status(&status)?;
            fields.push("status = ?".into());
            values.push(status.into());
        }

        let mut guard = self.connection.lock();
        let connection = guard.transaction()?;
        if !fields.is_empty() {
            fields.extend([
                "updated_at = ?".into(),
                "revision = revision + 1".into(),
                "device_id = ?".into(),
                "hlc = ?".into(),
            ]);
            values.push(now_iso().into());
            values.push(self.device_id.clone().into());
            values.push(self.hlc().into());
            values.push(id.to_string().into());
            connection.execute(
                &format!("UPDATE tasks SET {} WHERE id = ?", fields.join(", ")),
                rusqlite::params_from_iter(values),
            )?;
        }
        if let Some(names) = input.tag_names {
            self.replace_task_tags_locked(&connection, id, &names)?;
        }
        self.queue_change(&connection, "tasks", id)?;
        connection.commit()?;
        drop(guard);
        self.get_task(id)
    }

    pub fn complete_task(&self, id: &str, completed: bool) -> Result<Task> {
        self.get_task(id)?;
        let timestamp = now_iso();
        let mut guard = self.connection.lock();
        let connection = guard.transaction()?;
        connection.execute(
            "UPDATE tasks SET status = ?, completed_at = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![if completed { "completed" } else { "open" }, if completed { Some(timestamp.clone()) } else { None }, timestamp, self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "tasks", id)?;
        connection.commit()?;
        drop(guard);
        self.get_task(id)
    }

    pub fn delete_task(&self, id: &str) -> Result<Vec<String>> {
        self.get_task(id)?;
        let timestamp = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let mut guard = self.connection.lock();
        let connection = guard.transaction()?;
        let ids = {
            let mut statement = connection.prepare(
                "WITH RECURSIVE subtree(id) AS (
                    SELECT id FROM tasks WHERE id = ? AND tombstone = 0 AND status != 'deleted'
                    UNION SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
                    WHERE t.tombstone = 0 AND t.status != 'deleted'
                 ) SELECT id FROM subtree",
            )?;
            statement
                .query_map([id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for task_id in &ids {
            connection.execute(
                "UPDATE tasks SET status = 'deleted', deleted_at = ?, tombstone = 1, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
                params![timestamp, timestamp, self.device_id, self.hlc(), task_id],
            )?;
            self.queue_change(&connection, "tasks", task_id)?;
        }
        connection.commit()?;
        Ok(ids)
    }

    pub fn restore_task(&self, id: &str) -> Result<Task> {
        let mut guard = self.connection.lock();
        let connection = guard.transaction()?;
        let deleted_at: Option<Option<String>> = connection
            .query_row("SELECT deleted_at FROM tasks WHERE id = ?", [id], |row| {
                row.get(0)
            })
            .optional()?;
        let Some(deleted_at) = deleted_at else {
            bail!("找不到该任务");
        };
        let ids = {
            let mut statement = connection.prepare(
                "WITH RECURSIVE subtree(id) AS (
                    SELECT id FROM tasks WHERE id = ?
                    UNION SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
                    WHERE t.deleted_at = ? AND t.status = 'deleted'
                 ) SELECT id FROM subtree",
            )?;
            statement
                .query_map(params![id, deleted_at], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for task_id in ids {
            connection.execute(
                "UPDATE tasks SET status = CASE WHEN completed_at IS NULL THEN 'open' ELSE 'completed' END, deleted_at = NULL, tombstone = 0, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
                params![now_iso(), self.device_id, self.hlc(), task_id],
            )?;
            self.queue_change(&connection, "tasks", &task_id)?;
        }
        connection.commit()?;
        drop(guard);
        self.get_task(id)
    }

    pub fn reorder_tasks(&self, ids: &[String]) -> Result<Vec<TaskOrderPatch>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let selected = ids.iter().cloned().collect::<HashSet<_>>();
        if selected.len() != ids.len() {
            bail!("排序包含重复任务");
        }
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let parent: Option<String> = transaction.query_row(
            "SELECT parent_id FROM tasks WHERE id = ? AND tombstone = 0 AND status != 'deleted'",
            [&ids[0]],
            |row| row.get(0),
        )?;
        let siblings = {
            let mut statement = transaction.prepare(
                "SELECT id, position FROM tasks WHERE parent_id IS ? AND tombstone = 0 AND status != 'deleted' ORDER BY position, created_at, id"
            )?;
            statement
                .query_map([parent], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        if siblings
            .iter()
            .filter(|(id, _)| selected.contains(id))
            .count()
            != ids.len()
        {
            bail!("只能排序同一层级中存在的任务");
        }
        // Exchange only the selected slots. Hidden siblings retain their relative
        // order even when legacy data contains duplicate position values.
        let previous: HashMap<_, _> = siblings.iter().cloned().collect();
        let mut replacements = ids.iter();
        let ordered = siblings
            .iter()
            .map(|(id, _)| {
                if selected.contains(id) {
                    replacements.next().expect("validated slot count").clone()
                } else {
                    id.clone()
                }
            })
            .collect::<Vec<_>>();
        let mut patches = vec![];
        let timestamp = now_iso();
        let hlc = self.hlc();
        for (index, id) in ordered.into_iter().enumerate() {
            let position = ((index + 1) * 1000) as f64;
            if previous[&id] == position {
                continue;
            }
            transaction.execute(
                "UPDATE tasks SET position = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
                params![position, timestamp, self.device_id, hlc, id],
            )?;
            self.queue_change(&transaction, "tasks", &id)?;
            patches.push(TaskOrderPatch { id, position });
        }
        transaction.commit()?;
        Ok(patches)
    }

    pub(super) fn replace_task_tags_locked(
        &self,
        connection: &Connection,
        task_id: &str,
        names: &[String],
    ) -> Result<()> {
        let colors = [ACCENT, SUCCESS, INFO, WARNING, MAUVE];
        let clean_names = names
            .iter()
            .map(|name| clean_text(name, 40))
            .filter(|name| !name.is_empty())
            .collect::<HashSet<_>>()
            .into_iter()
            .take(8)
            .collect::<Vec<_>>();
        let mut desired = HashSet::new();
        for (index, name) in clean_names.iter().enumerate() {
            let existing = connection
                .query_row(
                    "SELECT id, tombstone FROM tags WHERE name = ? COLLATE NOCASE",
                    [name],
                    |row| Ok((row.get::<_, String>(0)?, bool_from_i64(row.get(1)?))),
                )
                .optional()?;
            let (tag_id, tag_changed) = match existing {
                Some((id, false)) => (id, false),
                Some((id, true)) => {
                    connection.execute(
                        "UPDATE tags SET tombstone = 0, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
                        params![self.device_id, self.hlc(), id],
                    )?;
                    (id, true)
                }
                None => {
                    let id = Uuid::new_v4().to_string();
                    connection.execute(
                        r#"INSERT INTO tags (id, name, color, created_at, revision, device_id, hlc, tombstone)
                           VALUES (?, ?, ?, ?, 1, ?, ?, 0)"#,
                        params![id, name, colors[index % colors.len()], now_iso(), self.device_id, self.hlc()],
                    )?;
                    (id, true)
                }
            };
            if tag_changed {
                self.queue_change(connection, "tags", &tag_id)?;
            }
            desired.insert(tag_id);
        }

        let existing_links = {
            let mut statement =
                connection.prepare("SELECT tag_id, tombstone FROM task_tags WHERE task_id = ?")?;
            statement
                .query_map([task_id], |row| {
                    Ok((row.get::<_, String>(0)?, bool_from_i64(row.get(1)?)))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (tag_id, tombstone) in &existing_links {
            let should_exist = desired.contains(tag_id);
            if should_exist == !*tombstone {
                continue;
            }
            connection.execute(
                r#"UPDATE task_tags SET tombstone = ?, updated_at = ?, revision = revision + 1,
                   device_id = ?, hlc = ? WHERE task_id = ? AND tag_id = ?"#,
                params![
                    (!should_exist) as i64,
                    now_iso(),
                    self.device_id,
                    self.hlc(),
                    task_id,
                    tag_id
                ],
            )?;
            self.queue_task_tag_change(connection, task_id, tag_id)?;
        }
        let known = existing_links
            .into_iter()
            .map(|(tag_id, _)| tag_id)
            .collect::<HashSet<_>>();
        for tag_id in desired.difference(&known) {
            connection.execute(
                r#"INSERT INTO task_tags
                   (task_id, tag_id, updated_at, revision, device_id, hlc, version_vector, tombstone)
                   VALUES (?, ?, ?, 1, ?, ?, '{}', 0)"#,
                params![task_id, tag_id, now_iso(), self.device_id, self.hlc()],
            )?;
            self.queue_task_tag_change(connection, task_id, tag_id)?;
        }
        Ok(())
    }

    pub(super) fn queue_task_tag_change(
        &self,
        connection: &Connection,
        task_id: &str,
        tag_id: &str,
    ) -> Result<()> {
        let raw: String = connection.query_row(
            "SELECT version_vector FROM task_tags WHERE task_id = ? AND tag_id = ?",
            params![task_id, tag_id],
            |row| row.get(0),
        )?;
        let mut vector = serde_json::from_str::<HashMap<String, u64>>(&raw).unwrap_or_default();
        *vector.entry(self.device_id.clone()).or_default() += 1;
        connection.execute(
            "UPDATE task_tags SET version_vector = ? WHERE task_id = ? AND tag_id = ?",
            params![serde_json::to_string(&vector)?, task_id, tag_id],
        )?;
        self.queue_change_only(connection, "task_tags", &format!("{task_id}:{tag_id}"))
    }

    pub fn due_reminders(&self) -> Result<Vec<(String, String, String)>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            r#"SELECT id, title, notes FROM tasks WHERE status = 'open' AND tombstone = 0
               AND reminder_at IS NOT NULL AND reminder_at <= ? AND notified_at IS NULL"#,
        )?;
        Ok(statement
            .query_map([now_iso()], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn mark_reminder_notified(&self, id: &str) -> Result<()> {
        self.connection.lock().execute(
            "UPDATE tasks SET notified_at = ? WHERE id = ?",
            params![now_iso(), id],
        )?;
        Ok(())
    }
}
