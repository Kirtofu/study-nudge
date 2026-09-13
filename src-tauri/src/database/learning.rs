use super::*;

impl Database {
    pub fn get_learning_pack(&self, task_id: &str) -> Result<Option<LearningPack>> {
        let connection = self.connection.lock();
        let pack_row = connection
            .query_row(
                r#"SELECT id, task_id, status, provider, model, generation_id, completed_sections,
                          failed_sections, created_at, updated_at FROM learning_packs
                   WHERE task_id = ? AND tombstone = 0"#,
                [task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            id,
            task_id,
            status,
            provider,
            model,
            generation_id,
            completed,
            failed,
            created_at,
            updated_at,
        )) = pack_row
        else {
            return Ok(None);
        };

        let mut resource_statement = connection.prepare(
            r#"SELECT id, pack_id, task_id, kind, title, summary, url, platform, language,
                      thumbnail_url, pinned, verified, source, position, created_at, updated_at
               FROM learning_resources WHERE pack_id = ? AND tombstone = 0
               ORDER BY kind, pinned DESC, position, created_at"#,
        )?;
        let resources = resource_statement
            .query_map([&id], |row| {
                Ok(LearningResource {
                    id: row.get(0)?,
                    pack_id: row.get(1)?,
                    task_id: row.get(2)?,
                    kind: row.get(3)?,
                    title: row.get(4)?,
                    summary: row.get(5)?,
                    url: row.get(6)?,
                    platform: row.get(7)?,
                    language: row.get(8)?,
                    thumbnail_url: row.get(9)?,
                    pinned: bool_from_i64(row.get(10)?),
                    verified: bool_from_i64(row.get(11)?),
                    source: row.get(12)?,
                    position: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut node_statement = connection.prepare(
            r#"SELECT id, pack_id, task_id, kind, title, description, estimated_minutes, status,
                      x, y, position, pinned, created_at, updated_at FROM learning_nodes
               WHERE pack_id = ? AND tombstone = 0 ORDER BY position, created_at"#,
        )?;
        let nodes = node_statement
            .query_map([&id], |row| {
                Ok(LearningNode {
                    id: row.get(0)?,
                    pack_id: row.get(1)?,
                    task_id: row.get(2)?,
                    kind: row.get(3)?,
                    title: row.get(4)?,
                    description: row.get(5)?,
                    estimated_minutes: row.get(6)?,
                    status: row.get(7)?,
                    x: row.get(8)?,
                    y: row.get(9)?,
                    position: row.get(10)?,
                    pinned: bool_from_i64(row.get(11)?),
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut edge_statement = connection.prepare(
            r#"SELECT id, pack_id, source_node_id, target_node_id, relation, created_at
               FROM learning_edges WHERE pack_id = ? AND tombstone = 0 ORDER BY created_at"#,
        )?;
        let edges = edge_statement
            .query_map([&id], |row| {
                Ok(LearningEdge {
                    id: row.get(0)?,
                    pack_id: row.get(1)?,
                    source_node_id: row.get(2)?,
                    target_node_id: row.get(3)?,
                    relation: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Some(LearningPack {
            id,
            task_id,
            status,
            provider,
            model,
            generation_id,
            completed_sections: parse_json(&completed, vec![]),
            failed_sections: parse_json(&failed, vec![]),
            created_at,
            updated_at,
            resources,
            nodes,
            edges,
        }))
    }

    pub fn ensure_learning_pack(&self, task_id: &str) -> Result<LearningPack> {
        let task = self.get_task(task_id)?;
        if let Some(pack) = self.get_learning_pack(task_id)? {
            return Ok(pack);
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now_iso();
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute(
            r#"INSERT INTO learning_packs (
                 id, task_id, status, provider, completed_sections, failed_sections, created_at, updated_at,
                 revision, device_id, hlc, tombstone
               ) VALUES (?, ?, 'ready', 'offline', '["resources","videos","roadmap"]', '[]', ?, ?, 1, ?, ?, 0)"#,
            params![id, task_id, timestamp, timestamp, self.device_id, self.hlc()],
        )?;
        self.insert_offline_template(&transaction, &id, &task)?;
        self.queue_change(&transaction, "learning_packs", &id)?;
        transaction.commit()?;
        drop(connection);
        self.get_learning_pack(task_id)?
            .ok_or_else(|| anyhow!("学习包没有创建成功"))
    }

    pub(super) fn insert_offline_template(
        &self,
        transaction: &Transaction<'_>,
        pack_id: &str,
        task: &Task,
    ) -> Result<()> {
        let timestamp = now_iso();
        let query = &task.title;
        let resources = [
            (
                "document",
                format!("查找“{query}”官方文档"),
                "优先阅读维护者发布的入门、概念与 API 文档。".to_string(),
                search_url(
                    "https://www.google.com/search?q=",
                    &format!("{query} 官方 文档"),
                ),
                "Web",
            ),
            (
                "tool",
                format!("寻找“{query}”练习工具"),
                "从可立即动手的沙盒、题库或示例仓库开始。".to_string(),
                search_url(
                    "https://github.com/search?q=",
                    &format!("{query} tutorial examples"),
                ),
                "GitHub",
            ),
            (
                "video",
                format!("YouTube：{query}"),
                "搜索高质量完整课程；打开后可按时长和发布时间筛选。".to_string(),
                search_url("https://www.youtube.com/results?search_query=", query),
                "YouTube",
            ),
            (
                "video",
                format!("B站：{query}"),
                "优先选择有章节、配套资料和完整项目的系列视频。".to_string(),
                search_url("https://search.bilibili.com/all?keyword=", query),
                "哔哩哔哩",
            ),
        ];
        for (index, (kind, title, summary, url, platform)) in resources.into_iter().enumerate() {
            let resource_id = Uuid::new_v4().to_string();
            transaction.execute(
                r#"INSERT INTO learning_resources (
                     id, pack_id, task_id, kind, title, summary, url, platform, language, pinned,
                     verified, source, position, created_at, updated_at, revision, device_id, hlc, tombstone
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'zh-CN', 0, 0, 'local-template', ?, ?, ?, 1, ?, ?, 0)"#,
                params![resource_id, pack_id, task.id, kind, title, summary, url, platform,
                        (index + 1) as i64 * 1000, timestamp, timestamp, self.device_id, self.hlc()],
            )?;
            self.queue_change(transaction, "learning_resources", &resource_id)?;
        }

        let stages = [
            (
                "goal",
                "明确目标",
                format!("定义完成“{}”后要能独立做到什么。", task.title),
                20_i64,
            ),
            (
                "concept",
                "基础概念",
                "梳理核心术语、基本原理与常见误区。".into(),
                60,
            ),
            (
                "practice",
                "跟练",
                "跟随一个小而完整的示例，边做边记录问题。".into(),
                90,
            ),
            (
                "project",
                "独立实践",
                "脱离教程完成一个能验证目标的小作品。".into(),
                120,
            ),
            (
                "review",
                "复盘输出",
                "用笔记、讲解或清单总结收获与下一步。".into(),
                30,
            ),
        ];
        let mut previous: Option<String> = None;
        for (index, (kind, title, description, minutes)) in stages.into_iter().enumerate() {
            let node_id = Uuid::new_v4().to_string();
            transaction.execute(
                r#"INSERT INTO learning_nodes (
                     id, pack_id, task_id, kind, title, description, estimated_minutes, status,
                     x, y, position, pinned, created_at, updated_at, revision, device_id, hlc, tombstone
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?, 1, ?, ?, 0)"#,
                params![node_id, pack_id, task.id, kind, title, description, minutes,
                        24.0 + index as f64 * 32.0, 32.0 + index as f64 * 128.0,
                        (index + 1) as i64 * 1000, timestamp, timestamp, self.device_id, self.hlc()],
            )?;
            self.queue_change(transaction, "learning_nodes", &node_id)?;
            if let Some(source) = previous {
                let edge_id = Uuid::new_v4().to_string();
                transaction.execute(
                    r#"INSERT INTO learning_edges (
                         id, pack_id, source_node_id, target_node_id, relation, created_at,
                         revision, device_id, hlc, tombstone
                       ) VALUES (?, ?, ?, ?, 'depends-on', ?, 1, ?, ?, 0)"#,
                    params![
                        edge_id,
                        pack_id,
                        source,
                        node_id,
                        timestamp,
                        self.device_id,
                        self.hlc()
                    ],
                )?;
                self.queue_change(transaction, "learning_edges", &edge_id)?;
            }
            previous = Some(node_id);
        }
        Ok(())
    }

    pub fn set_learning_generation_state(
        &self,
        task_id: &str,
        update: LearningGenerationStateUpdate<'_>,
    ) -> Result<LearningPack> {
        let pack = self.ensure_learning_pack(task_id)?;
        let connection = self.connection.lock();
        connection.execute(
            r#"UPDATE learning_packs SET status = ?, provider = ?, model = ?, generation_id = ?,
               completed_sections = ?, failed_sections = ?, updated_at = ?, revision = revision + 1,
               device_id = ?, hlc = ? WHERE id = ?"#,
            params![
                update.status,
                update.provider,
                update.model,
                update.generation_id,
                serde_json::to_string(update.completed_sections)?,
                serde_json::to_string(update.failed_sections)?,
                now_iso(),
                self.device_id,
                self.hlc(),
                pack.id
            ],
        )?;
        self.queue_change(&connection, "learning_packs", &pack.id)?;
        drop(connection);
        self.get_learning_pack(task_id)?
            .ok_or_else(|| anyhow!("学习包不存在"))
    }

    pub fn replace_generated_section(
        &self,
        task_id: &str,
        section: &str,
        resources: &[CreateLearningResourceInput],
        nodes: &[UpsertLearningNodeInput],
    ) -> Result<()> {
        let pack = self.ensure_learning_pack(task_id)?;
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        let timestamp = now_iso();
        if section == "resources" || section == "videos" {
            let kind_filter = if section == "videos" {
                "video"
            } else {
                "document"
            };
            transaction.execute(
                r#"UPDATE learning_resources SET tombstone = 1, updated_at = ?, revision = revision + 1,
                   device_id = ?, hlc = ? WHERE pack_id = ? AND pinned = 0 AND source = 'ai' AND
                   ((? = 'video' AND kind = 'video') OR (? != 'video' AND kind != 'video'))"#,
                params![timestamp, self.device_id, self.hlc(), pack.id, kind_filter, kind_filter],
            )?;
            for (index, resource) in resources.iter().enumerate() {
                validate_resource_kind(&resource.kind)?;
                validate_https_url(&resource.url)?;
                let id = Uuid::new_v4().to_string();
                transaction.execute(
                    r#"INSERT INTO learning_resources (
                         id, pack_id, task_id, kind, title, summary, url, platform, language, thumbnail_url, pinned,
                         verified, source, position, created_at, updated_at, revision, device_id, hlc, tombstone
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ai', ?, ?, ?, 1, ?, ?, 0)"#,
                    params![id, pack.id, task_id, resource.kind, clean_text(&resource.title, 160),
                            clean_text(&resource.summary, 600), resource.url, clean_text(&resource.platform, 40),
                            clean_text(&resource.language, 20), resource.thumbnail_url,
                            resource.verified as i64, (index + 1) as i64 * 1000,
                            timestamp, timestamp, self.device_id, self.hlc()],
                )?;
                self.queue_change(&transaction, "learning_resources", &id)?;
            }
        } else if section == "roadmap" {
            transaction.execute(
                "UPDATE learning_edges SET tombstone = 1, revision = revision + 1, device_id = ?, hlc = ? WHERE pack_id = ?",
                params![self.device_id, self.hlc(), pack.id],
            )?;
            transaction.execute(
                "UPDATE learning_nodes SET tombstone = 1, revision = revision + 1, device_id = ?, hlc = ? WHERE pack_id = ? AND pinned = 0",
                params![self.device_id, self.hlc(), pack.id],
            )?;
            let mut previous: Option<String> = None;
            for (index, node) in nodes.iter().take(50).enumerate() {
                let id = Uuid::new_v4().to_string();
                let title = clean_text(&node.title, 120);
                if title.is_empty() {
                    continue;
                }
                let status = node.status.as_deref().unwrap_or("pending");
                validate_node_status(status)?;
                transaction.execute(
                    r#"INSERT INTO learning_nodes (
                         id, pack_id, task_id, kind, title, description, estimated_minutes, status,
                         x, y, position, pinned, created_at, updated_at, revision, device_id, hlc, tombstone
                       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, 0)"#,
                    params![id, pack.id, task_id, node.kind.as_deref().unwrap_or("custom"), title,
                            clean_text(&node.description, 1000), node.estimated_minutes, status,
                            node.x.unwrap_or(24.0), node.y.unwrap_or(32.0 + index as f64 * 128.0),
                            (index + 1) as i64 * 1000, timestamp, timestamp, self.device_id, self.hlc()],
                )?;
                self.queue_change(&transaction, "learning_nodes", &id)?;
                if let Some(source) = previous {
                    let edge_id = Uuid::new_v4().to_string();
                    transaction.execute(
                        r#"INSERT INTO learning_edges (id, pack_id, source_node_id, target_node_id, relation,
                           created_at, revision, device_id, hlc, tombstone) VALUES (?, ?, ?, ?, 'depends-on', ?, 1, ?, ?, 0)"#,
                        params![edge_id, pack.id, source, id, timestamp, self.device_id, self.hlc()],
                    )?;
                    self.queue_change(&transaction, "learning_edges", &edge_id)?;
                }
                previous = Some(id);
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn create_learning_resource(
        &self,
        task_id: &str,
        input: CreateLearningResourceInput,
    ) -> Result<LearningResource> {
        validate_resource_kind(&input.kind)?;
        validate_https_url(&input.url)?;
        let title = clean_text(&input.title, 160);
        if title.is_empty() {
            bail!("资源标题不能为空");
        }
        let pack = self.ensure_learning_pack(task_id)?;
        let connection = self.connection.lock();
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM learning_resources WHERE pack_id = ? AND kind = ? AND tombstone = 0",
            params![pack.id, input.kind],
            |row| row.get(0),
        )?;
        let limit = if input.kind == "video" { 12 } else { 20 };
        if count >= limit {
            bail!("这一栏已达到建议上限，请先整理现有内容");
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now_iso();
        connection.execute(
            r#"INSERT INTO learning_resources (
                 id, pack_id, task_id, kind, title, summary, url, platform, language, pinned, verified,
                 source, position, created_at, updated_at, revision, device_id, hlc, tombstone
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'user', ?, ?, ?, 1, ?, ?, 0)"#,
            params![id, pack.id, task_id, input.kind, title, clean_text(&input.summary, 600), input.url,
                    clean_text(&input.platform, 40), clean_text(&input.language, 20), (count + 1) * 1000,
                    timestamp, timestamp, self.device_id, self.hlc()],
        )?;
        self.queue_change(&connection, "learning_resources", &id)?;
        drop(connection);
        self.get_learning_resource(&id)
    }

    pub(super) fn get_learning_resource(&self, id: &str) -> Result<LearningResource> {
        self.connection
            .lock()
            .query_row(
                r#"SELECT id, pack_id, task_id, kind, title, summary, url, platform, language,
                          thumbnail_url, pinned, verified, source, position, created_at, updated_at
                   FROM learning_resources WHERE id = ? AND tombstone = 0"#,
                [id],
                |row| {
                    Ok(LearningResource {
                        id: row.get(0)?,
                        pack_id: row.get(1)?,
                        task_id: row.get(2)?,
                        kind: row.get(3)?,
                        title: row.get(4)?,
                        summary: row.get(5)?,
                        url: row.get(6)?,
                        platform: row.get(7)?,
                        language: row.get(8)?,
                        thumbnail_url: row.get(9)?,
                        pinned: bool_from_i64(row.get(10)?),
                        verified: bool_from_i64(row.get(11)?),
                        source: row.get(12)?,
                        position: row.get(13)?,
                        created_at: row.get(14)?,
                        updated_at: row.get(15)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!("找不到该学习资源"))
    }

    pub fn update_learning_resource(
        &self,
        id: &str,
        input: UpdateLearningResourceInput,
    ) -> Result<LearningResource> {
        let current = self.get_learning_resource(id)?;
        let kind = input.kind.unwrap_or(current.kind);
        validate_resource_kind(&kind)?;
        let title = input
            .title
            .map(|value| clean_text(&value, 160))
            .unwrap_or(current.title);
        if title.is_empty() {
            bail!("资源标题不能为空");
        }
        let url = input.url.unwrap_or(current.url);
        validate_https_url(&url)?;
        let thumbnail = input.thumbnail_url.unwrap_or(current.thumbnail_url);
        if let Some(url) = thumbnail.as_deref() {
            validate_https_url(url)?;
        }
        let connection = self.connection.lock();
        connection.execute(
            r#"UPDATE learning_resources SET kind = ?, title = ?, summary = ?, url = ?, platform = ?,
               language = ?, thumbnail_url = ?, verified = ?, updated_at = ?, revision = revision + 1,
               device_id = ?, hlc = ? WHERE id = ?"#,
            params![kind, title, input.summary.map(|value| clean_text(&value, 600)).unwrap_or(current.summary),
                    url, input.platform.map(|value| clean_text(&value, 40)).unwrap_or(current.platform),
                    input.language.map(|value| clean_text(&value, 20)).unwrap_or(current.language), thumbnail,
                    input.verified.unwrap_or(current.verified) as i64, now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "learning_resources", id)?;
        drop(connection);
        self.get_learning_resource(id)
    }

    pub fn delete_learning_resource(&self, id: &str) -> Result<()> {
        self.get_learning_resource(id)?;
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE learning_resources SET tombstone = 1, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "learning_resources", id)?;
        Ok(())
    }

    pub fn reorder_learning_resources(&self, pack_id: &str, ids: &[String]) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        for (index, id) in ids.iter().enumerate() {
            transaction.execute(
                "UPDATE learning_resources SET position = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ? AND pack_id = ?",
                params![((index + 1) * 1000) as i64, now_iso(), self.device_id, self.hlc(), id, pack_id],
            )?;
            self.queue_change(&transaction, "learning_resources", id)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn pin_learning_resource(&self, id: &str, pinned: bool) -> Result<LearningResource> {
        self.get_learning_resource(id)?;
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE learning_resources SET pinned = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![pinned as i64, now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "learning_resources", id)?;
        drop(connection);
        self.get_learning_resource(id)
    }

    pub fn upsert_learning_node(
        &self,
        task_id: &str,
        input: UpsertLearningNodeInput,
    ) -> Result<LearningNode> {
        let title = clean_text(&input.title, 120);
        if title.is_empty() {
            bail!("路线节点标题不能为空");
        }
        let pack = self.ensure_learning_pack(task_id)?;
        if let Some(id) = input.id.as_deref() {
            let current = self
                .find_learning_node(id, true)?
                .ok_or_else(|| anyhow!("找不到路线节点"))?;
            if current.task_id != task_id || current.pack_id != pack.id {
                bail!("路线节点不属于当前任务");
            }
            let status = input.status.unwrap_or(current.status);
            validate_node_status(&status)?;
            let connection = self.connection.lock();
            connection.execute(
                r#"UPDATE learning_nodes SET kind = ?, title = ?, description = ?, estimated_minutes = ?,
                   status = ?, x = ?, y = ?, position = ?, pinned = ?, updated_at = ?, revision = revision + 1,
                   device_id = ?, hlc = ?, tombstone = 0 WHERE id = ? AND task_id = ?"#,
                params![input.kind.unwrap_or(current.kind), title,
                        if input.description.is_empty() { current.description } else { clean_text(&input.description, 1000) },
                        input.estimated_minutes.or(current.estimated_minutes), status, input.x.unwrap_or(current.x),
                        input.y.unwrap_or(current.y), input.position.unwrap_or(current.position),
                        input.pinned.unwrap_or(current.pinned) as i64, now_iso(), self.device_id, self.hlc(), id, task_id],
            )?;
            self.queue_change(&connection, "learning_nodes", id)?;
            drop(connection);
            return self.get_learning_node(id);
        }
        let connection = self.connection.lock();
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM learning_nodes WHERE pack_id = ? AND tombstone = 0",
            [&pack.id],
            |row| row.get(0),
        )?;
        if count >= 50 {
            bail!("路线图最多支持 50 个节点");
        }
        let id = Uuid::new_v4().to_string();
        let status = input.status.unwrap_or_else(|| "pending".into());
        validate_node_status(&status)?;
        let timestamp = now_iso();
        connection.execute(
            r#"INSERT INTO learning_nodes (
                 id, pack_id, task_id, kind, title, description, estimated_minutes, status, x, y,
                 position, pinned, created_at, updated_at, revision, device_id, hlc, tombstone
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0)"#,
            params![
                id,
                pack.id,
                task_id,
                input.kind.unwrap_or_else(|| "custom".into()),
                title,
                clean_text(&input.description, 1000),
                input.estimated_minutes,
                status,
                input.x.unwrap_or(24.0),
                input.y.unwrap_or(32.0 + count as f64 * 128.0),
                input.position.unwrap_or((count + 1) * 1000),
                input.pinned.unwrap_or(false) as i64,
                timestamp,
                timestamp,
                self.device_id,
                self.hlc()
            ],
        )?;
        self.queue_change(&connection, "learning_nodes", &id)?;
        drop(connection);
        self.get_learning_node(&id)
    }

    pub(super) fn get_learning_node(&self, id: &str) -> Result<LearningNode> {
        self.find_learning_node(id, false)?
            .ok_or_else(|| anyhow!("找不到路线节点"))
    }

    pub(super) fn find_learning_node(
        &self,
        id: &str,
        include_deleted: bool,
    ) -> Result<Option<LearningNode>> {
        let query = if include_deleted {
            r#"SELECT id, pack_id, task_id, kind, title, description, estimated_minutes, status,
                      x, y, position, pinned, created_at, updated_at FROM learning_nodes WHERE id = ?"#
        } else {
            r#"SELECT id, pack_id, task_id, kind, title, description, estimated_minutes, status,
                      x, y, position, pinned, created_at, updated_at FROM learning_nodes
               WHERE id = ? AND tombstone = 0"#
        };
        Ok(self
            .connection
            .lock()
            .query_row(query, [id], |row| {
                Ok(LearningNode {
                    id: row.get(0)?,
                    pack_id: row.get(1)?,
                    task_id: row.get(2)?,
                    kind: row.get(3)?,
                    title: row.get(4)?,
                    description: row.get(5)?,
                    estimated_minutes: row.get(6)?,
                    status: row.get(7)?,
                    x: row.get(8)?,
                    y: row.get(9)?,
                    position: row.get(10)?,
                    pinned: bool_from_i64(row.get(11)?),
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            })
            .optional()?)
    }

    pub fn delete_learning_node(&self, id: &str) -> Result<()> {
        self.get_learning_node(id)?;
        let connection = self.connection.lock();
        let related_edges = {
            let mut statement = connection.prepare(
                "SELECT id FROM learning_edges WHERE (source_node_id = ? OR target_node_id = ?) AND tombstone = 0",
            )?;
            statement
                .query_map(params![id, id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        connection.execute(
            "UPDATE learning_nodes SET tombstone = 1, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![now_iso(), self.device_id, self.hlc(), id],
        )?;
        connection.execute(
            "UPDATE learning_edges SET tombstone = 1, revision = revision + 1, device_id = ?, hlc = ? WHERE source_node_id = ? OR target_node_id = ?",
            params![self.device_id, self.hlc(), id, id],
        )?;
        self.queue_change(&connection, "learning_nodes", id)?;
        for edge_id in related_edges {
            self.queue_change(&connection, "learning_edges", &edge_id)?;
        }
        Ok(())
    }

    pub fn connect_learning_nodes(
        &self,
        pack_id: &str,
        source: &str,
        target: &str,
    ) -> Result<LearningEdge> {
        if source == target {
            bail!("节点不能依赖自己");
        }
        let source_node = self.get_learning_node(source)?;
        let target_node = self.get_learning_node(target)?;
        if source_node.pack_id != pack_id || target_node.pack_id != pack_id {
            bail!("只能连接同一个学习包中的节点");
        }
        let existing = self.connection.lock().query_row(
            "SELECT id, created_at, tombstone FROM learning_edges WHERE pack_id = ? AND source_node_id = ? AND target_node_id = ?",
            params![pack_id, source, target],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, bool_from_i64(row.get(2)?))),
        ).optional()?;
        if let Some((id, created_at, false)) = existing.as_ref() {
            return Ok(LearningEdge {
                id: id.clone(),
                pack_id: pack_id.into(),
                source_node_id: source.into(),
                target_node_id: target.into(),
                relation: "depends-on".into(),
                created_at: created_at.clone(),
            });
        }
        if self.would_create_cycle(pack_id, source, target)? {
            bail!("这条连接会形成循环依赖");
        }
        if let Some((id, created_at, true)) = existing {
            let connection = self.connection.lock();
            connection.execute(
                "UPDATE learning_edges SET tombstone = 0, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
                params![self.device_id, self.hlc(), id],
            )?;
            self.queue_change(&connection, "learning_edges", &id)?;
            return Ok(LearningEdge {
                id,
                pack_id: pack_id.into(),
                source_node_id: source.into(),
                target_node_id: target.into(),
                relation: "depends-on".into(),
                created_at,
            });
        }
        let id = Uuid::new_v4().to_string();
        let timestamp = now_iso();
        let connection = self.connection.lock();
        connection.execute(
            r#"INSERT INTO learning_edges (
                 id, pack_id, source_node_id, target_node_id, relation, created_at,
                 revision, device_id, hlc, tombstone
               ) VALUES (?, ?, ?, ?, 'depends-on', ?, 1, ?, ?, 0)"#,
            params![
                id,
                pack_id,
                source,
                target,
                timestamp,
                self.device_id,
                self.hlc()
            ],
        )?;
        self.queue_change(&connection, "learning_edges", &id)?;
        Ok(LearningEdge {
            id,
            pack_id: pack_id.into(),
            source_node_id: source.into(),
            target_node_id: target.into(),
            relation: "depends-on".into(),
            created_at: timestamp,
        })
    }

    pub(super) fn would_create_cycle(
        &self,
        pack_id: &str,
        source: &str,
        target: &str,
    ) -> Result<bool> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT source_node_id, target_node_id FROM learning_edges WHERE pack_id = ? AND tombstone = 0",
        )?;
        let edges = statement
            .query_map([pack_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
        for (from, to) in edges {
            adjacency.entry(from).or_default().push(to);
        }
        adjacency
            .entry(source.into())
            .or_default()
            .push(target.into());
        let mut stack = vec![target.to_string()];
        let mut visited = HashSet::new();
        while let Some(node) = stack.pop() {
            if node == source {
                return Ok(true);
            }
            if visited.insert(node.clone())
                && let Some(next) = adjacency.get(&node)
            {
                stack.extend(next.iter().cloned());
            }
        }
        Ok(false)
    }

    pub fn disconnect_learning_edge(&self, id: &str) -> Result<()> {
        let connection = self.connection.lock();
        let changed = connection.execute(
            "UPDATE learning_edges SET tombstone = 1, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ? AND tombstone = 0",
            params![self.device_id, self.hlc(), id],
        )?;
        if changed == 0 {
            bail!("找不到路线连接");
        }
        self.queue_change(&connection, "learning_edges", id)?;
        Ok(())
    }

    pub fn set_learning_node_status(&self, id: &str, status: &str) -> Result<LearningNode> {
        validate_node_status(status)?;
        self.get_learning_node(id)?;
        let connection = self.connection.lock();
        connection.execute(
            "UPDATE learning_nodes SET status = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
            params![status, now_iso(), self.device_id, self.hlc(), id],
        )?;
        self.queue_change(&connection, "learning_nodes", id)?;
        drop(connection);
        self.get_learning_node(id)
    }

    pub fn auto_layout_learning(&self, task_id: &str) -> Result<LearningPack> {
        let pack = self.ensure_learning_pack(task_id)?;
        let mut indegree = pack
            .nodes
            .iter()
            .map(|node| (node.id.clone(), 0_usize))
            .collect::<HashMap<_, _>>();
        let mut outgoing: HashMap<String, Vec<String>> = HashMap::new();
        for edge in &pack.edges {
            *indegree.entry(edge.target_node_id.clone()).or_default() += 1;
            outgoing
                .entry(edge.source_node_id.clone())
                .or_default()
                .push(edge.target_node_id.clone());
        }
        let mut queue = indegree
            .iter()
            .filter(|(_, degree)| **degree == 0)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        queue.sort();
        let mut layer = HashMap::<String, usize>::new();
        while let Some(node) = queue.pop() {
            let current_layer = layer.get(&node).copied().unwrap_or_default();
            for target in outgoing.get(&node).into_iter().flatten() {
                layer
                    .entry(target.clone())
                    .and_modify(|value| *value = (*value).max(current_layer + 1))
                    .or_insert(current_layer + 1);
                if let Some(degree) = indegree.get_mut(target) {
                    *degree -= 1;
                    if *degree == 0 {
                        queue.push(target.clone());
                    }
                }
            }
        }
        let mut counts = HashMap::<usize, usize>::new();
        let connection = self.connection.lock();
        for node in &pack.nodes {
            let level = layer.get(&node.id).copied().unwrap_or_default();
            let slot = counts.entry(level).or_default();
            connection.execute(
                "UPDATE learning_nodes SET x = ?, y = ?, updated_at = ?, revision = revision + 1, device_id = ?, hlc = ? WHERE id = ?",
                params![32.0 + *slot as f64 * 248.0, 32.0 + level as f64 * 132.0, now_iso(), self.device_id, self.hlc(), node.id],
            )?;
            *slot += 1;
            self.queue_change(&connection, "learning_nodes", &node.id)?;
        }
        drop(connection);
        self.get_learning_pack(task_id)?
            .ok_or_else(|| anyhow!("学习包不存在"))
    }
}
