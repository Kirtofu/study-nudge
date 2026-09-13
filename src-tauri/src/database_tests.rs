use super::*;
use crate::reminders;

fn temporary(name: &str) -> (Database, PathBuf) {
    let root = std::env::temp_dir().join(format!("nudge-regression-{name}-{}", Uuid::new_v4()));
    (
        Database::open(root.join("nudge.db"), None, vec![]).unwrap(),
        root,
    )
}
fn add(database: &Database, title: &str, parent: Option<&str>) -> Task {
    database
        .create_task(
            serde_json::from_value(json!({ "title": title, "parentId": parent, "tagNames": [] }))
                .unwrap(),
        )
        .unwrap()
}
fn update(database: &Database, id: &str, input: Value) -> Task {
    database
        .update_task(id, serde_json::from_value(input).unwrap())
        .unwrap()
}

#[test]
fn scoped_order_survives_edit_and_restart() {
    let (database, root) = temporary("order");
    let a = add(&database, "a", None);
    let hidden = add(&database, "hidden", None);
    let b = add(&database, "b", None);
    let later = add(&database, "later", None);
    let patches = database
        .reorder_tasks(&[b.id.clone(), a.id.clone()])
        .unwrap();
    assert_eq!(patches.len(), 2);
    update(&database, &b.id, json!({"notes": "edited after drag"}));
    let expected = vec![b.id, hidden.id, a.id, later.id];
    assert_eq!(
        database
            .list_tasks()
            .unwrap()
            .iter()
            .map(|t| t.id.clone())
            .collect::<Vec<_>>(),
        expected
    );
    drop(database);
    let reopened = Database::open(root.join("nudge.db"), None, vec![]).unwrap();
    assert_eq!(
        reopened
            .list_tasks()
            .unwrap()
            .iter()
            .map(|t| t.id.clone())
            .collect::<Vec<_>>(),
        expected
    );
    drop(reopened);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn explicit_null_clears_dates_but_omitted_fields_and_multiline_notes_survive() {
    let (database, root) = temporary("dates");
    let task = add(&database, "dates", None);
    update(
        &database,
        &task.id,
        json!({"scheduledFor":"2026-09-12", "dueAt":"2026-09-13T12:00:00Z", "reminderAt":"2026-09-13T11:00:00Z", "estimateMinutes":25}),
    );
    let notes = "第一行\n\n- Vec<T>\n- 下一步";
    let saved = update(
        &database,
        &task.id,
        json!({"notes": notes, "scheduledFor":null,"reminderAt":null,"estimateMinutes":null}),
    );
    assert!(saved.scheduled_for.is_none());
    assert!(saved.reminder_at.is_none());
    assert!(saved.estimate_minutes.is_none());
    assert_eq!(saved.due_at.as_deref(), Some("2026-09-13T12:00:00Z"));
    assert_eq!(saved.notes, notes);
    drop(database);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn deleting_a_tree_and_undoing_preserves_completed_children_and_earlier_deletions() {
    let (database, root) = temporary("subtree");
    let parent = add(&database, "parent", None);
    let completed = add(&database, "completed child", Some(&parent.id));
    let removed_before = add(&database, "previously deleted", Some(&parent.id));
    let grandchild = add(&database, "grandchild", Some(&completed.id));
    database.complete_task(&completed.id, true).unwrap();
    database.delete_task(&removed_before.id).unwrap();
    let removed = database.delete_task(&parent.id).unwrap();
    assert_eq!(removed.len(), 3);
    assert!(database.list_tasks().unwrap().is_empty());
    drop(database);
    let database = Database::open(root.join("nudge.db"), None, vec![]).unwrap();
    assert!(database.list_tasks().unwrap().is_empty());
    let restored = database.restore_task(&parent.id).unwrap();
    assert_eq!(restored.subtasks.len(), 1);
    assert_eq!(restored.subtasks[0].status, "completed");
    assert_eq!(restored.subtasks[0].subtasks[0].id, grandchild.id);
    drop(database);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_task_writes_leave_neither_partial_creation_nor_partial_deletion() {
    let (database, root) = temporary("rollback");
    let parent = add(&database, "parent", None);
    add(&database, "child", Some(&parent.id));
    database.connection.lock().execute_batch("CREATE TRIGGER fail_queue BEFORE INSERT ON sync_queue BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
    let input =
        serde_json::from_value(json!({"title":"must not remain", "tagNames":["new tag"]})).unwrap();
    assert!(database.create_task(input).is_err());
    assert!(database.delete_task(&parent.id).is_err());
    let remaining = database.list_tasks().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].subtasks.len(), 1);
    assert!(database.list_tags().unwrap().is_empty());
    drop(database);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn notification_failure_remains_pending_and_success_is_sent_once() {
    let (database, root) = temporary("reminders");
    let task = add(&database, "reminder", None);
    update(
        &database,
        &task.id,
        json!({"reminderAt":"2020-01-01T00:00:00Z"}),
    );
    assert_eq!(
        reminders::deliver_pending(&database, |_, _| false).unwrap(),
        0
    );
    assert_eq!(database.due_reminders().unwrap().len(), 1);
    assert_eq!(
        reminders::deliver_pending(&database, |_, _| true).unwrap(),
        1
    );
    assert_eq!(
        reminders::deliver_pending(&database, |_, _| panic!("already delivered")).unwrap(),
        0
    );
    drop(database);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn legacy_database_is_copied_and_v3_schema_and_backup_are_compatible() {
    let (source, root) = temporary("migration");
    let task = add(&source, "old data", None);
    source.ensure_learning_pack(&task.id).unwrap();
    let backup = source.export_json().unwrap();
    source.checkpoint().unwrap();
    drop(source);
    let old = Connection::open(root.join("nudge.db")).unwrap();
    for table in [
        "tasks",
        "lists",
        "tags",
        "task_tags",
        "focus_sessions",
        "learning_packs",
        "learning_resources",
        "learning_nodes",
        "learning_edges",
        "settings",
    ] {
        old.execute_batch(&format!("ALTER TABLE {table} DROP COLUMN version_vector;"))
            .unwrap();
    }
    old.pragma_update(None, "user_version", 2).unwrap();
    drop(old);
    let copied = Database::open(
        root.join("new/nudge.db"),
        Some(root.join("nudge.db")),
        vec![],
    )
    .unwrap();
    assert_eq!(copied.get_task(&task.id).unwrap().title, "old data");
    assert!(copied.get_learning_pack(&task.id).unwrap().is_some());
    copied.import_json(backup, "replace").unwrap();
    assert_eq!(copied.export_sync_snapshot().unwrap()["schemaVersion"], 3);
    drop(copied);
    let _ = fs::remove_dir_all(root);
}
