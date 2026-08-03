use std::{fs, path::PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridClock {
    physical_ms: i64,
    logical: u64,
    device_id: String,
    #[serde(skip)]
    path: PathBuf,
}

impl HybridClock {
    pub fn load(path: PathBuf, device_id: String) -> Self {
        let loaded = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Self>(&bytes).ok());
        let mut clock = loaded.unwrap_or_else(|| Self {
            physical_ms: 0,
            logical: 0,
            device_id: device_id.clone(),
            path: path.clone(),
        });
        clock.device_id = device_id;
        clock.path = path;
        clock
    }

    pub fn tick(&mut self) -> String {
        let now = Utc::now().timestamp_millis().max(0);
        if now > self.physical_ms {
            self.physical_ms = now;
            self.logical = 0;
        } else {
            self.logical = self.logical.saturating_add(1);
        }
        self.persist();
        self.stamp()
    }

    pub fn observe(&mut self, stamp: &str) {
        let Some((remote_ms, remote_logical, _)) = parse_stamp(stamp) else {
            return;
        };
        let now = Utc::now().timestamp_millis().max(0);
        let local_ms = self.physical_ms;
        let next_ms = now.max(local_ms).max(remote_ms);
        self.logical = if next_ms == local_ms && next_ms == remote_ms {
            self.logical.max(remote_logical).saturating_add(1)
        } else if next_ms == local_ms {
            self.logical.saturating_add(1)
        } else if next_ms == remote_ms {
            remote_logical.saturating_add(1)
        } else {
            0
        };
        self.physical_ms = next_ms;
        self.persist();
    }

    fn stamp(&self) -> String {
        format!(
            "{:013}-{:010}-{}",
            self.physical_ms, self.logical, self.device_id
        )
    }

    fn persist(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let temporary = self.path.with_extension("tmp");
        if let Ok(bytes) = serde_json::to_vec(self)
            && fs::write(&temporary, bytes).is_ok()
        {
            let _ = fs::rename(temporary, &self.path);
        }
    }
}

pub fn parse_stamp(stamp: &str) -> Option<(i64, u64, &str)> {
    let mut parts = stamp.splitn(3, '-');
    let physical = parts.next()?.parse().ok()?;
    let logical = parts.next()?.parse().ok()?;
    let device = parts.next()?;
    (!device.is_empty()).then_some((physical, logical, device))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn clock_is_monotonic_and_absorbs_remote_time() {
        let path = std::env::temp_dir().join(format!("nudge-hlc-{}.json", Uuid::new_v4()));
        let mut clock = HybridClock::load(path.clone(), "local".into());
        let first = clock.tick();
        let second = clock.tick();
        assert!(second > first);
        clock.observe("9999999999999-0000000042-remote");
        let next = clock.tick();
        assert!(next.as_str() > "9999999999999-0000000042-remote");
        let restored = HybridClock::load(path.clone(), "local".into());
        assert!(restored.physical_ms >= 9_999_999_999_999);
        let _ = fs::remove_file(path);
    }
}
