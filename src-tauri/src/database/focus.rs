use super::*;

impl Database {
    pub fn get_focus_state(&self) -> Result<FocusState> {
        self.setting("focusState", FocusState::default())
    }

    pub fn commit_focus_transition(
        &self,
        state: &FocusState,
        session: Option<&FocusSession>,
    ) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        if let Some(session) = session {
            transaction.execute(
                "INSERT INTO focus_sessions (id, task_id, mode, started_at, ended_at, duration_seconds, note, source, source_key, revision, device_id, hlc, tombstone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)",
                params![session.id, session.task_id, session.mode, session.started_at, session.ended_at, session.duration_seconds, session.note, session.source, session.source_key, self.device_id, self.hlc()],
            )?;
            self.queue_change(&transaction, "focus_sessions", &session.id)?;
        }
        transaction.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('focusState', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![serde_json::to_string(state)?, now_iso()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn add_focus_session(&self, mut session: FocusSession) -> Result<FocusSession> {
        if session.id.is_empty() {
            session.id = Uuid::new_v4().to_string();
        }
        session.duration_seconds = session.duration_seconds.max(0);
        let connection = self.connection.lock();
        connection.execute(
            r#"INSERT OR IGNORE INTO focus_sessions (
                 id, task_id, mode, started_at, ended_at, duration_seconds, note, source, source_key,
                 revision, device_id, hlc, tombstone
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)"#,
            params![session.id, session.task_id, session.mode, session.started_at, session.ended_at,
                    session.duration_seconds, session.note, session.source, session.source_key,
                    self.device_id, self.hlc()],
        )?;
        let stored = connection
            .query_row(
                "SELECT id, task_id, mode, started_at, ended_at, duration_seconds, note, source, source_key FROM focus_sessions WHERE id = ? OR (? IS NOT NULL AND source_key = ?)",
                params![session.id, session.source_key, session.source_key],
                Self::map_focus_row,
            )
            .optional()?
            .ok_or_else(|| anyhow!("专注记录没有保存成功"))?;
        self.queue_change(&connection, "focus_sessions", &stored.id)?;
        Ok(stored)
    }

    pub(super) fn map_focus_row(row: &Row<'_>) -> rusqlite::Result<FocusSession> {
        Ok(FocusSession {
            id: row.get(0)?,
            task_id: row.get(1)?,
            mode: row.get(2)?,
            started_at: row.get(3)?,
            ended_at: row.get(4)?,
            duration_seconds: row.get(5)?,
            note: row.get(6)?,
            source: row.get(7)?,
            source_key: row.get(8)?,
        })
    }

    pub fn get_focus_stats(&self) -> Result<FocusStats> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT id, task_id, mode, started_at, ended_at, duration_seconds, note, source, source_key FROM focus_sessions WHERE tombstone = 0 ORDER BY started_at DESC",
        )?;
        let sessions = statement
            .query_map([], Self::map_focus_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        drop(connection);

        let mut totals = HashMap::<String, i64>::new();
        let mut total_seconds = 0;
        for session in &sessions {
            if let Ok(started) = DateTime::parse_from_rfc3339(&session.started_at) {
                let key = local_date_key(started.with_timezone(&Local));
                *totals.entry(key).or_default() += session.duration_seconds;
            }
            total_seconds += session.duration_seconds;
        }
        let today = local_date_key(Local::now());
        let today_seconds = totals.get(&today).copied().unwrap_or_default();
        let mut cursor = Local::now().date_naive();
        if !totals.contains_key(&today) {
            cursor = cursor.pred_opt().unwrap_or(cursor);
        }
        let mut streak_days = 0;
        loop {
            let key = format!(
                "{:04}-{:02}-{:02}",
                cursor.year(),
                cursor.month(),
                cursor.day()
            );
            if !totals.contains_key(&key) {
                break;
            }
            streak_days += 1;
            cursor = cursor.pred_opt().unwrap_or(cursor);
        }
        let settings = self.get_settings()?;
        Ok(FocusStats {
            today_seconds,
            total_seconds,
            streak_days,
            daily_goal_minutes: settings.daily_goal_minutes,
            long_term_goal_hours: settings.long_term_goal_hours,
            long_term_goal_label: settings.long_term_goal_label,
            sessions: sessions.into_iter().take(60).collect(),
        })
    }

    pub fn get_focus_history(&self, query: FocusHistoryQuery) -> Result<FocusHistoryPage> {
        let limit = query.limit.unwrap_or(40).clamp(1, 100);
        let offset = query
            .cursor
            .as_deref()
            .unwrap_or("0")
            .parse::<i64>()
            .unwrap_or(0)
            .max(0);
        let cutoff = match query.range.as_deref().unwrap_or("7d") {
            "7d" => Some(Utc::now() - chrono::Duration::days(7)),
            "30d" => Some(Utc::now() - chrono::Duration::days(30)),
            "all" => None,
            _ => bail!("专注历史范围无效"),
        }
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        let connection = self.connection.lock();
        let total: i64 = connection.query_row(
            "SELECT COUNT(*) FROM focus_sessions WHERE tombstone = 0 AND (?1 IS NULL OR started_at >= ?1)",
            [cutoff.as_deref()],
            |row| row.get(0),
        )?;
        let mut statement = connection.prepare(
            r#"SELECT id, task_id, mode, started_at, ended_at, duration_seconds, note, source, source_key
               FROM focus_sessions WHERE tombstone = 0 AND (?1 IS NULL OR started_at >= ?1)
               ORDER BY started_at DESC LIMIT ?2 OFFSET ?3"#,
        )?;
        let items = statement
            .query_map(params![cutoff, limit, offset], Self::map_focus_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let next_offset = offset + items.len() as i64;
        Ok(FocusHistoryPage {
            items,
            next_cursor: (next_offset < total).then(|| next_offset.to_string()),
            total,
        })
    }

    pub(super) fn import_legacy_sessions(&self, paths: &[PathBuf]) -> Result<()> {
        for path in paths {
            if !path.exists() {
                continue;
            }
            let Ok(raw) = fs::read_to_string(path) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let entries = value.as_array().cloned().unwrap_or_else(|| vec![value]);
            for entry in entries {
                let Some(object) = entry.as_object() else {
                    continue;
                };
                let Some(date) = object.get("date").and_then(Value::as_str) else {
                    continue;
                };
                let hours = object.get("hours").and_then(Value::as_f64).unwrap_or(0.0);
                if hours <= 0.0 {
                    continue;
                }
                let time = object
                    .get("time")
                    .and_then(Value::as_str)
                    .unwrap_or("12:00");
                let note = object
                    .get("note")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let key_source = format!("{date}|{time}|{hours}|{note}");
                let source_key = hex::encode(Sha256::digest(key_source.as_bytes()));
                let Ok(naive) = chrono::NaiveDateTime::parse_from_str(
                    &format!("{date} {time}:00"),
                    "%Y-%m-%d %H:%M:%S",
                ) else {
                    continue;
                };
                let Some(started) = Local.from_local_datetime(&naive).single() else {
                    continue;
                };
                let duration_seconds = (hours * 3600.0).round() as i64;
                let ended = started + chrono::Duration::seconds(duration_seconds);
                let _ = self.add_focus_session(FocusSession {
                    id: Uuid::new_v4().to_string(),
                    task_id: None,
                    mode: "legacy".into(),
                    started_at: started.to_rfc3339(),
                    ended_at: ended.to_rfc3339(),
                    duration_seconds,
                    note: note.into(),
                    source: "study-nudge".into(),
                    source_key: Some(source_key),
                });
            }
        }
        Ok(())
    }
}
