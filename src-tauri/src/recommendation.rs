use anyhow::{Context, Result, anyhow, bail};
use reqwest::{Client, header};
use serde::Deserialize;
use serde_json::{Value, json};
use url::Url;

use crate::models::{
    CreateLearningResourceInput, OperationResult, RecommendationSettings, Task,
    UpdateRecommendationSettingsInput, UpsertLearningNodeInput,
};

#[derive(Debug, Clone)]
pub enum GeneratedSection {
    Resources(Vec<CreateLearningResourceInput>),
    Videos(Vec<CreateLearningResourceInput>),
    Roadmap(Vec<UpsertLearningNodeInput>),
}

#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct OllamaResponse {
    message: OpenAiMessage,
}

pub fn merge_settings(
    current: RecommendationSettings,
    input: &UpdateRecommendationSettingsInput,
    has_api_key: bool,
) -> Result<RecommendationSettings> {
    let provider = input.provider.clone().unwrap_or(current.provider);
    if !matches!(
        provider.as_str(),
        "offline" | "openai-compatible" | "ollama"
    ) {
        bail!("推荐服务类型无效");
    }
    let endpoint = input.endpoint.clone().unwrap_or(current.endpoint);
    let model = input.model.clone().unwrap_or(current.model);
    if model.trim().len() > 120 {
        bail!("模型名称过长");
    }
    if provider != "offline" {
        validate_endpoint(&provider, &endpoint)?;
    }
    Ok(RecommendationSettings {
        provider,
        endpoint: endpoint.trim_end_matches('/').to_string(),
        model: model.trim().to_string(),
        network_enabled: input.network_enabled.unwrap_or(current.network_enabled),
        send_notes: input.send_notes.unwrap_or(current.send_notes),
        has_api_key,
    })
}

pub async fn test_connection(
    settings: &RecommendationSettings,
    api_key: Option<&str>,
) -> Result<OperationResult> {
    if settings.provider == "offline" {
        return Ok(OperationResult {
            ok: true,
            message: "当前使用离线模板，不需要网络连接。".into(),
        });
    }
    if !settings.network_enabled {
        bail!("请先允许联网推荐");
    }
    validate_endpoint(&settings.provider, &settings.endpoint)?;
    validate_resolved_endpoint(&settings.provider, &settings.endpoint).await?;
    let client = secure_client()?;
    let response = if settings.provider == "ollama" {
        client
            .get(format!(
                "{}/api/tags",
                settings.endpoint.trim_end_matches('/')
            ))
            .send()
            .await?
    } else {
        let key = api_key
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow!("请填写 API 密钥"))?;
        client
            .get(format!(
                "{}/models",
                settings.endpoint.trim_end_matches('/')
            ))
            .bearer_auth(key)
            .send()
            .await?
    };
    if !response.status().is_success() {
        bail!("服务返回 {}，请检查地址、模型与密钥", response.status());
    }
    Ok(OperationResult {
        ok: true,
        message: "连接成功，可以生成学习包。".into(),
    })
}

pub async fn generate_section(
    task: &Task,
    section: &str,
    settings: &RecommendationSettings,
    api_key: Option<&str>,
    include_notes: bool,
) -> Result<GeneratedSection> {
    if settings.provider == "offline" {
        bail!("离线模板已经即时生成，无需调用推荐服务");
    }
    if !settings.network_enabled {
        bail!("联网推荐尚未启用");
    }
    validate_endpoint(&settings.provider, &settings.endpoint)?;
    validate_resolved_endpoint(&settings.provider, &settings.endpoint).await?;
    if !matches!(section, "resources" | "videos" | "roadmap") {
        bail!("学习包分栏无效");
    }

    let notes = if include_notes && settings.send_notes {
        task.notes.as_str()
    } else {
        "（未发送备注）"
    };
    let schema = match section {
        "resources" => {
            r#"{"items":[{"kind":"document|tool","title":"...","summary":"...","url":"https://...","platform":"...","language":"zh-CN|en"}]}"#
        }
        "videos" => {
            r#"{"items":[{"kind":"video","title":"...","summary":"...","url":"https://www.youtube.com/... 或 https://www.bilibili.com/...","platform":"YouTube|哔哩哔哩","language":"zh-CN|en"}]}"#
        }
        _ => {
            r#"{"items":[{"kind":"goal|concept|practice|project|review|custom","title":"...","description":"...","estimatedMinutes":30}]}"#
        }
    };
    let instruction = match section {
        "resources" => {
            "推荐高可信的官方文档、参考资料和可立即练习的工具，中文优先，必要时保留高质量英文官方资料，最多 12 条。"
        }
        "videos" => "推荐 YouTube 或哔哩哔哩的课程与实战视频，避免营销、搬运和标题党，最多 8 条。",
        _ => {
            "设计一条从目标澄清到复盘输出的可执行学习路线，步骤之间按依赖顺序排列，最多 16 个节点。"
        }
    };
    let prompt = format!(
        "你是学习规划助手。任务标题：{}\n标签：{}\n学习目标/备注：{}\n{}\n只输出严格 JSON，不要 Markdown。结构必须是：{}",
        task.title,
        task.tags
            .iter()
            .map(|tag| tag.name.as_str())
            .collect::<Vec<_>>()
            .join("、"),
        notes,
        instruction,
        schema
    );

    let body = request_completion(settings, api_key, &prompt).await?;
    let generated = parse_generated_section(section, &body, &task.title)?;
    if let GeneratedSection::Videos(resources) = generated {
        return Ok(GeneratedSection::Videos(
            verify_video_resources(resources, &task.title).await,
        ));
    }
    Ok(generated)
}

async fn request_completion(
    settings: &RecommendationSettings,
    api_key: Option<&str>,
    prompt: &str,
) -> Result<String> {
    let client = secure_client()?;
    let response = if settings.provider == "ollama" {
        client
            .post(format!(
                "{}/api/chat",
                settings.endpoint.trim_end_matches('/')
            ))
            .json(&json!({
                "model": settings.model,
                "stream": false,
                "format": "json",
                "messages": [{"role": "user", "content": prompt}],
                "options": {"temperature": 0.25}
            }))
            .send()
            .await?
    } else {
        let key = api_key
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow!("请填写 API 密钥"))?;
        client
            .post(format!("{}/chat/completions", settings.endpoint.trim_end_matches('/')))
            .bearer_auth(key)
            .json(&json!({
                "model": settings.model,
                "temperature": 0.25,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": "输出安全、简洁、可验证的学习规划 JSON。不要输出 HTML。"},
                    {"role": "user", "content": prompt}
                ]
            }))
            .send()
            .await?
    };

    let status = response.status();
    let content_length = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if content_length.is_some_and(|length| length > 1_000_000) {
        bail!("推荐服务响应过大，已停止处理");
    }
    let bytes = response.bytes().await?;
    if bytes.len() > 1_000_000 {
        bail!("推荐服务响应过大，已停止处理");
    }
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&bytes);
        bail!("推荐服务返回 {status}：{}", sanitize_text(&detail, 180));
    }
    if settings.provider == "ollama" {
        let response: OllamaResponse =
            serde_json::from_slice(&bytes).context("Ollama 返回格式无效")?;
        Ok(response.message.content)
    } else {
        let response: OpenAiResponse =
            serde_json::from_slice(&bytes).context("AI 服务返回格式无效")?;
        response
            .choices
            .into_iter()
            .next()
            .map(|choice| choice.message.content)
            .ok_or_else(|| anyhow!("AI 服务没有返回内容"))
    }
}

fn parse_generated_section(section: &str, raw: &str, task_title: &str) -> Result<GeneratedSection> {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let value: Value = serde_json::from_str(cleaned).context("AI 输出不是有效 JSON")?;
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("AI 输出缺少 items 数组"))?;
    match section {
        "resources" | "videos" => {
            let limit = if section == "videos" { 12 } else { 20 };
            let mut resources = vec![];
            for item in items.iter().take(limit) {
                let kind =
                    item.get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or(if section == "videos" {
                            "video"
                        } else {
                            "document"
                        });
                if section == "videos" && kind != "video" {
                    continue;
                }
                if section == "resources" && !matches!(kind, "document" | "tool") {
                    continue;
                }
                let title = sanitize_text(
                    item.get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    160,
                );
                if title.is_empty() {
                    continue;
                }
                let platform = sanitize_text(
                    item.get("platform")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    40,
                );
                let mut url = item
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                if !is_safe_resource_url(&url) {
                    url = fallback_search_url(section, &title, task_title, &platform);
                }
                if section == "videos" && !is_supported_video_url(&url) {
                    url = fallback_search_url(section, &title, task_title, &platform);
                }
                resources.push(CreateLearningResourceInput {
                    kind: kind.into(),
                    title,
                    summary: sanitize_text(
                        item.get("summary")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        600,
                    ),
                    url,
                    platform,
                    language: sanitize_text(
                        item.get("language")
                            .and_then(Value::as_str)
                            .unwrap_or("zh-CN"),
                        20,
                    ),
                    thumbnail_url: None,
                    verified: false,
                });
            }
            if resources.is_empty() {
                bail!("AI 没有返回可用的推荐内容");
            }
            if section == "videos" {
                Ok(GeneratedSection::Videos(resources))
            } else {
                Ok(GeneratedSection::Resources(resources))
            }
        }
        "roadmap" => {
            let mut nodes = vec![];
            for (index, item) in items.iter().take(20).enumerate() {
                let title = sanitize_text(
                    item.get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    120,
                );
                if title.is_empty() {
                    continue;
                }
                nodes.push(UpsertLearningNodeInput {
                    id: None,
                    kind: Some(
                        match item.get("kind").and_then(Value::as_str).unwrap_or("custom") {
                            "goal" | "concept" | "practice" | "project" | "review" | "custom" => {
                                item.get("kind").and_then(Value::as_str).unwrap_or("custom")
                            }
                            _ => "custom",
                        }
                        .into(),
                    ),
                    title,
                    description: sanitize_text(
                        item.get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                        1000,
                    ),
                    estimated_minutes: item
                        .get("estimatedMinutes")
                        .and_then(Value::as_i64)
                        .filter(|value| (1..=100_000).contains(value)),
                    status: Some("pending".into()),
                    x: Some(24.0),
                    y: Some(32.0 + index as f64 * 128.0),
                    position: Some((index + 1) as i64 * 1000),
                    pinned: Some(false),
                });
            }
            if nodes.is_empty() {
                bail!("AI 没有返回可用的学习路线");
            }
            Ok(GeneratedSection::Roadmap(nodes))
        }
        _ => bail!("学习包分栏无效"),
    }
}

fn secure_client() -> Result<Client> {
    Ok(Client::builder()
        .connect_timeout(std::time::Duration::from_secs(12))
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 {
                return attempt.error("推荐服务重定向次数过多");
            }
            let Some(previous) = attempt.previous().last() else {
                return attempt.follow();
            };
            let next = attempt.url();
            let same_origin = previous.scheme() == next.scheme()
                && previous.host_str() == next.host_str()
                && previous.port_or_known_default() == next.port_or_known_default();
            let local_http = next.scheme() == "http"
                && next
                    .host_str()
                    .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1"));
            if same_origin && (next.scheme() == "https" || local_http) {
                attempt.follow()
            } else {
                attempt.error("推荐服务拒绝跨域或降级重定向")
            }
        }))
        .user_agent("Nudge/2.1 learning-planner")
        .build()?)
}

#[derive(Debug, Deserialize)]
struct YouTubeOEmbed {
    title: String,
    thumbnail_url: String,
}

async fn verify_video_resources(
    resources: Vec<CreateLearningResourceInput>,
    task_title: &str,
) -> Vec<CreateLearningResourceInput> {
    let client = match metadata_client() {
        Ok(client) => client,
        Err(_) => {
            return resources
                .into_iter()
                .map(|resource| degrade_video_resource(resource, task_title))
                .collect();
        }
    };
    let mut verified = Vec::with_capacity(resources.len());
    for mut resource in resources {
        if is_video_search_url(&resource.url) {
            verified.push(resource);
            continue;
        }
        let metadata = if is_youtube_video_url(&resource.url) {
            fetch_youtube_metadata(&client, &resource.url).await
        } else if is_bilibili_video_url(&resource.url) {
            fetch_bilibili_metadata(&client, &resource.url).await
        } else {
            None
        };
        if let Some((title, thumbnail_url)) = metadata {
            resource.title = sanitize_text(&title, 160);
            resource.thumbnail_url = Some(thumbnail_url);
            resource.verified = true;
            verified.push(resource);
        } else {
            verified.push(degrade_video_resource(resource, task_title));
        }
    }
    verified
}

fn degrade_video_resource(
    mut resource: CreateLearningResourceInput,
    task_title: &str,
) -> CreateLearningResourceInput {
    resource.url = fallback_search_url("videos", &resource.title, task_title, &resource.platform);
    resource.thumbnail_url = None;
    resource.verified = false;
    resource
}

fn metadata_client() -> Result<Client> {
    Ok(Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Nudge/2.1 video-metadata")
        .build()?)
}

async fn fetch_youtube_metadata(client: &Client, video_url: &str) -> Option<(String, String)> {
    let mut endpoint = Url::parse("https://www.youtube.com/oembed").ok()?;
    endpoint
        .query_pairs_mut()
        .append_pair("url", video_url)
        .append_pair("format", "json");
    let response = client.get(endpoint).send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > 128 * 1024)
    {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    if bytes.len() > 128 * 1024 {
        return None;
    }
    let metadata: YouTubeOEmbed = serde_json::from_slice(&bytes).ok()?;
    if metadata.title.trim().is_empty() || !is_safe_resource_url(&metadata.thumbnail_url) {
        return None;
    }
    Some((metadata.title, metadata.thumbnail_url))
}

async fn fetch_bilibili_metadata(client: &Client, video_url: &str) -> Option<(String, String)> {
    let response = client.get(video_url).send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > 512 * 1024)
    {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    if bytes.len() > 512 * 1024 {
        return None;
    }
    let html = String::from_utf8_lossy(&bytes);
    let title = extract_open_graph(&html, "og:title")?;
    let mut thumbnail = extract_open_graph(&html, "og:image")?;
    if thumbnail.starts_with("//") {
        thumbnail = format!("https:{thumbnail}");
    }
    if !is_safe_resource_url(&thumbnail) {
        return None;
    }
    Some((decode_html_entities(&title), thumbnail))
}

fn extract_open_graph(html: &str, property: &str) -> Option<String> {
    let escaped = regex::escape(property);
    let patterns = [
        format!(
            r#"(?is)<meta[^>]+property=[\"']{escaped}[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>"#
        ),
        format!(
            r#"(?is)<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+property=[\"']{escaped}[\"'][^>]*>"#
        ),
    ];
    patterns.into_iter().find_map(|pattern| {
        regex::Regex::new(&pattern)
            .ok()?
            .captures(html)
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str().trim().to_string())
    })
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn is_video_search_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.host_str() == Some("search.bilibili.com")
            || (url
                .host_str()
                .is_some_and(|host| host.ends_with("youtube.com"))
                && url.path() == "/results")
    })
}

fn is_youtube_video_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        matches!(url.host_str(), Some("youtu.be"))
            || (url
                .host_str()
                .is_some_and(|host| host.ends_with("youtube.com"))
                && (url.path() == "/watch" || url.path().starts_with("/shorts/")))
    })
}

fn is_bilibili_video_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.host_str()
            .is_some_and(|host| host == "bilibili.com" || host == "www.bilibili.com")
            && url.path().starts_with("/video/")
    })
}

fn validate_endpoint(provider: &str, endpoint: &str) -> Result<()> {
    let parsed = Url::parse(endpoint).context("服务地址格式无效")?;
    match provider {
        "ollama" => {
            let local = parsed
                .host_str()
                .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1"));
            if !local || !matches!(parsed.scheme(), "http" | "https") {
                bail!("Ollama 只允许使用本机 localhost 地址");
            }
        }
        "openai-compatible" => {
            if parsed.scheme() != "https" {
                bail!("OpenAI-compatible 服务必须使用 HTTPS");
            }
            if parsed.username() != "" || parsed.password().is_some() {
                bail!("服务地址不能包含用户名或密码");
            }
            if parsed.host_str().is_some_and(is_private_host_literal) {
                bail!("自定义 AI 服务不能指向私网地址");
            }
        }
        _ => bail!("推荐服务类型无效"),
    }
    Ok(())
}

fn is_private_host_literal(host: &str) -> bool {
    if matches!(host, "localhost" | "::1") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|address| match address {
            std::net::IpAddr::V4(value) => {
                value.is_private()
                    || value.is_loopback()
                    || value.is_link_local()
                    || value.is_broadcast()
                    || value.is_unspecified()
            }
            std::net::IpAddr::V6(value) => {
                value.is_loopback()
                    || value.is_unspecified()
                    || value.is_unique_local()
                    || value.is_unicast_link_local()
            }
        })
        .unwrap_or(false)
}

async fn validate_resolved_endpoint(provider: &str, endpoint: &str) -> Result<()> {
    if provider == "ollama" {
        return Ok(());
    }
    let parsed = Url::parse(endpoint).context("服务地址格式无效")?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("服务地址缺少主机名"))?;
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .context("无法解析推荐服务地址")?;
    for address in addresses {
        if is_private_host_literal(&address.ip().to_string()) {
            bail!("推荐服务解析到了私网或本机地址");
        }
    }
    Ok(())
}

fn is_safe_resource_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url
                .host_str()
                .is_some_and(|host| !is_private_host_literal(host))
    })
}

fn is_supported_video_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        url.host_str().is_some_and(|host| {
            host == "youtu.be"
                || host.ends_with("youtube.com")
                || host == "b23.tv"
                || host.ends_with("bilibili.com")
        })
    })
}

fn fallback_search_url(section: &str, title: &str, task_title: &str, platform: &str) -> String {
    let query = format!("{task_title} {title}");
    let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
    if section == "videos" && platform.to_lowercase().contains("youtube") {
        format!("https://www.youtube.com/results?search_query={encoded}")
    } else if section == "videos" {
        format!("https://search.bilibili.com/all?keyword={encoded}")
    } else {
        format!("https://www.google.com/search?q={encoded}")
    }
}

fn sanitize_text(value: &str, max: usize) -> String {
    let without_tags = regex::Regex::new(r"(?is)<[^>]*>")
        .expect("valid sanitizing regex")
        .replace_all(value, " ");
    without_tags
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_custom_endpoint_but_allows_local_ollama() {
        assert!(validate_endpoint("openai-compatible", "http://127.0.0.1:8080/v1").is_err());
        assert!(validate_endpoint("openai-compatible", "https://api.example.com/v1").is_ok());
        assert!(validate_endpoint("ollama", "http://localhost:11434").is_ok());
        assert!(validate_endpoint("ollama", "http://192.168.1.10:11434").is_err());
    }

    #[test]
    fn unsafe_video_link_falls_back_to_search() {
        let raw = r#"{"items":[{"kind":"video","title":"入门课","summary":"ok","url":"javascript:alert(1)","platform":"B站","language":"zh-CN"}]}"#;
        let GeneratedSection::Videos(items) =
            parse_generated_section("videos", raw, "Rust").unwrap()
        else {
            panic!("expected videos");
        };
        assert!(items[0].url.starts_with("https://search.bilibili.com/"));
    }

    #[test]
    fn extracts_and_sanitizes_bilibili_open_graph_metadata() {
        let html = r#"<html><head><meta property="og:title" content="Rust &amp; Tauri 入门"><meta content="https://i0.hdslb.com/demo.jpg" property="og:image"></head></html>"#;
        assert_eq!(
            decode_html_entities(&extract_open_graph(html, "og:title").unwrap()),
            "Rust & Tauri 入门"
        );
        assert_eq!(
            extract_open_graph(html, "og:image").unwrap(),
            "https://i0.hdslb.com/demo.jpg"
        );
    }
}
