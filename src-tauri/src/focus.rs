use crate::{
    database::Database,
    models::{FocusSession, FocusState},
};
use anyhow::{Result, bail};
use chrono::{DateTime, Duration, Utc};
use parking_lot::Mutex;
use std::sync::Arc;
use uuid::Uuid;

pub struct FocusService {
    database: Arc<Database>,
    state: Mutex<FocusState>,
}

impl FocusService {
    pub fn new(database: Arc<Database>) -> Result<Self> {
        let state = database.get_focus_state()?;
        Ok(Self {
            database,
            state: Mutex::new(state),
        })
    }
    pub fn get_state(&self) -> FocusState {
        self.state.lock().clone()
    }
    // Restore persistent and live timer state under the same transition lock.
    // Otherwise the next background tick can overwrite an imported timer.
    pub fn import_backup(&self, payload: serde_json::Value, mode: &str) -> Result<i64> {
        let mut current = self.state.lock();
        let imported = self.database.import_json(payload, mode)?;
        *current = self.database.get_focus_state()?;
        Ok(imported)
    }
    pub fn elapsed_seconds(state: &FocusState, at: DateTime<Utc>) -> i64 {
        let elapsed = if state.status == "running" {
            state
                .started_at
                .as_deref()
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .map(|started| (at - started.with_timezone(&Utc)).num_seconds().max(0))
                .unwrap_or(0)
        } else {
            0
        };
        state.accumulated_seconds + elapsed
    }
    pub fn start(
        &self,
        mode: &str,
        task_id: Option<String>,
        replace_active: bool,
    ) -> Result<FocusState> {
        self.start_at(mode, task_id, replace_active, Utc::now())
    }
    fn start_at(
        &self,
        mode: &str,
        task_id: Option<String>,
        replace_active: bool,
        at: DateTime<Utc>,
    ) -> Result<FocusState> {
        if !matches!(mode, "pomodoro" | "stopwatch") {
            bail!("专注模式无效");
        }
        if let Some(id) = task_id.as_deref() {
            self.database.get_task(id)?;
        }
        let mut current = self.state.lock();
        if current.status != "idle" {
            if current.phase == "focus" && current.mode == mode && current.task_id == task_id {
                return Ok(current.clone());
            }
            if !replace_active {
                bail!("已有专注正在进行，请先确认保存并切换");
            }
        }
        let settings = self.database.get_settings()?;
        let next = FocusState {
            status: "running".into(),
            mode: mode.into(),
            phase: "focus".into(),
            task_id,
            started_at: Some(at.to_rfc3339()),
            accumulated_seconds: 0,
            duration_seconds: (mode == "pomodoro").then_some(settings.pomodoro_focus_minutes * 60),
        };
        self.commit(&mut current, next, at, true)
    }
    pub fn pause(&self) -> Result<FocusState> {
        self.pause_at(Utc::now())
    }
    fn pause_at(&self, at: DateTime<Utc>) -> Result<FocusState> {
        let mut current = self.state.lock();
        if current.status != "running" {
            return Ok(current.clone());
        }
        let mut next = current.clone();
        next.accumulated_seconds = Self::elapsed_seconds(&current, at);
        next.status = "paused".into();
        next.started_at = None;
        self.commit(&mut current, next, at, false)
    }
    pub fn resume(&self) -> Result<FocusState> {
        self.resume_at(Utc::now())
    }
    fn resume_at(&self, at: DateTime<Utc>) -> Result<FocusState> {
        let mut current = self.state.lock();
        if current.status != "paused" {
            return Ok(current.clone());
        }
        let mut next = current.clone();
        next.status = "running".into();
        next.started_at = Some(at.to_rfc3339());
        self.commit(&mut current, next, at, false)
    }
    pub fn stop(&self) -> Result<FocusState> {
        self.stop_at(Utc::now())
    }
    fn stop_at(&self, at: DateTime<Utc>) -> Result<FocusState> {
        let mut current = self.state.lock();
        if current.status == "idle" {
            return Ok(current.clone());
        }
        self.commit(&mut current, FocusState::default(), at, true)
    }
    pub fn skip(&self) -> Result<FocusState> {
        let mut current = self.state.lock();
        if current.status == "idle" {
            return Ok(current.clone());
        }
        let at = Utc::now();
        let next = if current.mode == "pomodoro" && current.phase == "focus" {
            self.break_state(at)?
        } else {
            FocusState::default()
        };
        self.commit(&mut current, next, at, true)
    }
    pub fn tick(&self) -> Result<Option<(FocusState, &'static str, &'static str)>> {
        self.tick_at(Utc::now())
    }
    fn tick_at(
        &self,
        at: DateTime<Utc>,
    ) -> Result<Option<(FocusState, &'static str, &'static str)>> {
        let mut current = self.state.lock();
        let Some(duration) = current.duration_seconds else {
            return Ok(None);
        };
        if current.status != "running" || Self::elapsed_seconds(&current, at) < duration {
            return Ok(None);
        }
        let was_focus = current.phase == "focus";
        let next = if was_focus {
            self.break_state(at)?
        } else {
            FocusState::default()
        };
        let next = self.commit(&mut current, next, at, was_focus)?;
        Ok(Some(if was_focus {
            (next, "这一轮专注完成", "先松一口气，休息计时已经开始。")
        } else {
            (next, "休息结束", "准备好时，开始下一轮专注。")
        }))
    }
    fn break_state(&self, at: DateTime<Utc>) -> Result<FocusState> {
        Ok(FocusState {
            status: "running".into(),
            mode: "pomodoro".into(),
            phase: "break".into(),
            task_id: None,
            started_at: Some(at.to_rfc3339()),
            accumulated_seconds: 0,
            duration_seconds: Some(self.database.get_settings()?.pomodoro_break_minutes * 60),
        })
    }
    // Serialize all timer actions, including background ticks, through this lock
    // and commit history + state together before publishing the new memory state.
    fn commit(
        &self,
        current: &mut FocusState,
        next: FocusState,
        at: DateTime<Utc>,
        save: bool,
    ) -> Result<FocusState> {
        let elapsed = Self::elapsed_seconds(current, at).max(0);
        let duration = current
            .duration_seconds
            .map_or(elapsed, |limit| elapsed.min(limit));
        let session =
            if save && current.status != "idle" && current.phase == "focus" && duration > 0 {
                let note = current
                    .task_id
                    .as_deref()
                    .and_then(|id| self.database.get_task(id).ok())
                    .map(|task| task.title)
                    .unwrap_or_else(|| "自由专注".into());
                Some(FocusSession {
                    id: Uuid::new_v4().to_string(),
                    task_id: current.task_id.clone(),
                    mode: current.mode.clone(),
                    started_at: (at - Duration::seconds(duration)).to_rfc3339(),
                    ended_at: at.to_rfc3339(),
                    duration_seconds: duration,
                    note,
                    source: "nudge".into(),
                    source_key: None,
                })
            } else {
                None
            };
        self.database
            .commit_focus_transition(&next, session.as_ref())?;
        *current = next.clone();
        Ok(next)
    }
}

#[cfg(test)]
#[path = "focus_tests.rs"]
mod tests;
