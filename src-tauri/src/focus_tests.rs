use super::*;

fn fixture() -> (Arc<Database>, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("nudge-focus-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let db = Arc::new(Database::open(root.join("nudge.db"), None, vec![]).unwrap());
    (db, root)
}

#[test]
fn duplicate_start_and_stop_do_not_reset_or_duplicate_history() {
    let (db, root) = fixture();
    let service = FocusService::new(db.clone()).unwrap();
    let now = Utc::now();
    let first = service.start_at("stopwatch", None, false, now).unwrap();
    let second = service
        .start_at("stopwatch", None, false, now + Duration::seconds(20))
        .unwrap();
    assert_eq!(first.started_at, second.started_at);
    service.stop_at(now + Duration::seconds(90)).unwrap();
    service.stop_at(now + Duration::seconds(100)).unwrap();
    let stats = db.get_focus_stats().unwrap();
    assert_eq!(stats.sessions.len(), 1);
    assert_eq!(stats.total_seconds, 90);
    drop(service);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn switch_preserves_previous_session_and_requires_confirmation() {
    let (db, root) = fixture();
    let service = FocusService::new(db.clone()).unwrap();
    let now = Utc::now();
    service.start_at("stopwatch", None, false, now).unwrap();
    assert!(
        service
            .start_at("pomodoro", None, false, now + Duration::seconds(40))
            .is_err()
    );
    service
        .start_at("pomodoro", None, true, now + Duration::seconds(60))
        .unwrap();
    assert_eq!(db.get_focus_stats().unwrap().total_seconds, 60);
    assert_eq!(service.get_state().mode, "pomodoro");
    drop(service);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn pause_resume_and_restart_exclude_paused_time() {
    let (db, root) = fixture();
    let service = FocusService::new(db.clone()).unwrap();
    let now = Utc::now();
    service.start_at("stopwatch", None, false, now).unwrap();
    service.pause_at(now + Duration::seconds(60)).unwrap();
    drop(service);
    let restarted = FocusService::new(db.clone()).unwrap();
    restarted.resume_at(now + Duration::seconds(600)).unwrap();
    restarted.stop_at(now + Duration::seconds(630)).unwrap();
    assert_eq!(db.get_focus_stats().unwrap().total_seconds, 90);
    drop(restarted);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn waking_after_pomodoro_deadline_saves_only_one_full_round() {
    let (db, root) = fixture();
    let service = FocusService::new(db.clone()).unwrap();
    let now = Utc::now();
    service.start_at("pomodoro", None, false, now).unwrap();
    assert!(service.tick_at(now + Duration::hours(2)).unwrap().is_some());
    assert!(service.tick_at(now + Duration::hours(2)).unwrap().is_none());
    let stats = db.get_focus_stats().unwrap();
    assert_eq!(stats.sessions.len(), 1);
    assert_eq!(
        stats.total_seconds,
        db.get_settings().unwrap().pomodoro_focus_minutes * 60
    );
    drop(service);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_history_write_keeps_running_state_and_can_be_retried() {
    let (db, root) = fixture();
    let service = FocusService::new(db.clone()).unwrap();
    let now = Utc::now();
    service.start_at("stopwatch", None, false, now).unwrap();
    let connection = rusqlite::Connection::open(root.join("nudge.db")).unwrap();
    connection.execute_batch("CREATE TRIGGER fail_session BEFORE INSERT ON focus_sessions BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
    assert!(service.stop_at(now + Duration::seconds(40)).is_err());
    assert_eq!(service.get_state().status, "running");
    assert_eq!(db.get_focus_state().unwrap().status, "running");
    connection
        .execute_batch("DROP TRIGGER fail_session")
        .unwrap();
    service.stop_at(now + Duration::seconds(45)).unwrap();
    assert_eq!(db.get_focus_stats().unwrap().total_seconds, 45);
    drop(connection);
    drop(service);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn restoring_backup_replaces_live_timer_before_the_next_tick() {
    let (db, root) = fixture();
    let service = FocusService::new(db.clone()).unwrap();
    let now = Utc::now();
    service.start_at("stopwatch", None, false, now).unwrap();
    service.pause_at(now + Duration::seconds(42)).unwrap();
    let backup = db.export_json().unwrap();
    service.stop_at(now + Duration::seconds(50)).unwrap();
    service.start_at("pomodoro", None, false, now).unwrap();
    service.import_backup(backup, "replace").unwrap();
    assert_eq!(service.get_state().status, "paused");
    assert_eq!(service.get_state().accumulated_seconds, 42);
    assert!(service.tick_at(now + Duration::hours(2)).unwrap().is_none());
    assert_eq!(db.get_focus_state().unwrap().accumulated_seconds, 42);
    service.stop_at(now + Duration::hours(2)).unwrap();
    service.stop_at(now + Duration::hours(2)).unwrap();
    assert_eq!(db.get_focus_stats().unwrap().sessions.len(), 1);
    assert_eq!(db.get_focus_stats().unwrap().total_seconds, 42);
    drop(service);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
