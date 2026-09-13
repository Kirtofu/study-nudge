use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataChangedEvent<'a> {
    pub domains: &'a [&'a str],
    pub source: &'a str,
}

pub fn emit_data_changed(app: &AppHandle, domains: &[&str], source: &str) {
    let _ = app.emit("app-data-changed", DataChangedEvent { domains, source });
}
