use anyhow::Result;

use crate::database::Database;

pub fn deliver_pending(database: &Database, notify: impl Fn(&str, &str) -> bool) -> Result<usize> {
    let mut sent = 0;
    for (id, title, notes) in database.due_reminders()? {
        let body = if notes.is_empty() {
            "这是你之前设置的任务提醒。"
        } else {
            &notes
        };
        if notify(&title, body) {
            database.mark_reminder_notified(&id)?;
            sent += 1;
        } else {
            log::warn!("Task reminder could not be delivered; it remains pending");
        }
    }
    Ok(sent)
}
