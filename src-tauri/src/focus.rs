use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use parking_lot::Mutex;
use uuid::Uuid;

use crate::{
    database::Database,
    models::{FocusSession, FocusState},
};

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

    pub fn elapsed_seconds(state: &FocusState, at: DateTime<Utc>) -> i64 {
        if state.status != "running" {
            return state.accumulated_seconds;
        }
        let Some(started_at) = state
            .started_at
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc))
        else {
            return state.accumulated_seconds;
        };
        state.accumulated_seconds + (at - started_at).num_seconds().max(0)
    }

    pub fn start(&self, mode: &str, task_id: Option<String>) -> Result<FocusState> {
        if !matches!(mode, "pomodoro" | "stopwatch") {
            anyhow::bail!("专注模式无效");
        }
        if self.state.lock().status != "idle" {
            self.finish_current(false, true, None)?;
        }
        if let Some(id) = task_id.as_deref() {
            self.database.get_task(id)?;
        }
        let settings = self.database.get_settings()?;
        let state = FocusState {
            status: "running".into(),
            mode: mode.into(),
            phase: "focus".into(),
            task_id,
            started_at: Some(Utc::now().to_rfc3339()),
            accumulated_seconds: 0,
            duration_seconds: (mode == "pomodoro").then_some(settings.pomodoro_focus_minutes * 60),
        };
        *self.state.lock() = state;
        self.persist()
    }

    pub fn pause(&self) -> Result<FocusState> {
        let mut state = self.state.lock();
        if state.status == "running" {
            state.accumulated_seconds = Self::elapsed_seconds(&state, Utc::now());
            state.status = "paused".into();
            state.started_at = None;
        }
        let snapshot = state.clone();
        drop(state);
        self.database.set_focus_state(&snapshot)?;
        Ok(snapshot)
    }

    pub fn resume(&self) -> Result<FocusState> {
        let mut state = self.state.lock();
        if state.status == "paused" {
            state.status = "running".into();
            state.started_at = Some(Utc::now().to_rfc3339());
        }
        let snapshot = state.clone();
        drop(state);
        self.database.set_focus_state(&snapshot)?;
        Ok(snapshot)
    }

    pub fn stop(&self) -> Result<FocusState> {
        self.finish_current(true, true, None)?;
        Ok(self.get_state())
    }

    pub fn skip(&self) -> Result<FocusState> {
        let current = self.get_state();
        if current.status == "idle" {
            return Ok(current);
        }
        if current.mode == "stopwatch" {
            return self.stop();
        }
        if current.phase == "focus" {
            self.finish_current(true, false, None)?;
            self.start_break()?;
        } else {
            *self.state.lock() = FocusState::default();
            self.persist()?;
        }
        Ok(self.get_state())
    }

    pub fn tick(&self) -> Result<Option<(FocusState, &'static str, &'static str)>> {
        let current = self.get_state();
        let Some(duration) = current.duration_seconds else {
            return Ok(None);
        };
        if current.status != "running" || Self::elapsed_seconds(&current, Utc::now()) < duration {
            return Ok(None);
        }
        if current.phase == "focus" {
            self.finish_current(true, false, Some(duration))?;
            self.start_break()?;
            Ok(Some((
                self.get_state(),
                "这一轮专注完成",
                "先松一口气，休息计时已经开始。",
            )))
        } else {
            *self.state.lock() = FocusState::default();
            self.persist()?;
            Ok(Some((
                self.get_state(),
                "休息结束",
                "准备好时，开始下一轮专注。",
            )))
        }
    }

    fn start_break(&self) -> Result<()> {
        let settings = self.database.get_settings()?;
        *self.state.lock() = FocusState {
            status: "running".into(),
            mode: "pomodoro".into(),
            phase: "break".into(),
            task_id: None,
            started_at: Some(Utc::now().to_rfc3339()),
            accumulated_seconds: 0,
            duration_seconds: Some(settings.pomodoro_break_minutes * 60),
        };
        self.persist().map(|_| ())
    }

    fn finish_current(
        &self,
        save_session: bool,
        reset: bool,
        forced_duration: Option<i64>,
    ) -> Result<()> {
        let current = self.get_state();
        let elapsed =
            forced_duration.unwrap_or_else(|| Self::elapsed_seconds(&current, Utc::now()));
        if save_session && current.phase == "focus" && elapsed >= 1 {
            let ended_at = Utc::now();
            let started_at = ended_at - Duration::seconds(elapsed);
            let note = current
                .task_id
                .as_deref()
                .and_then(|id| self.database.get_task(id).ok())
                .map(|task| task.title)
                .unwrap_or_else(|| {
                    if current.task_id.is_some() {
                        "任务专注".into()
                    } else {
                        "自由专注".into()
                    }
                });
            self.database.add_focus_session(FocusSession {
                id: Uuid::new_v4().to_string(),
                task_id: current.task_id.clone(),
                mode: current.mode.clone(),
                started_at: started_at.to_rfc3339(),
                ended_at: ended_at.to_rfc3339(),
                duration_seconds: elapsed,
                note,
                source: "nudge".into(),
                source_key: None,
            })?;
        }
        if reset {
            *self.state.lock() = FocusState::default();
            self.persist()?;
        }
        Ok(())
    }

    fn persist(&self) -> Result<FocusState> {
        let state = self.get_state();
        self.database.set_focus_state(&state)?;
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_uses_timestamp_instead_of_interval_ticks() {
        let now = Utc::now();
        let state = FocusState {
            status: "running".into(),
            mode: "stopwatch".into(),
            phase: "focus".into(),
            task_id: None,
            started_at: Some((now - Duration::seconds(91)).to_rfc3339()),
            accumulated_seconds: 9,
            duration_seconds: None,
        };
        assert_eq!(FocusService::elapsed_seconds(&state, now), 100);
    }
}
