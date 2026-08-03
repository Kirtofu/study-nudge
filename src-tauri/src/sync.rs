use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, OsRng, rand_core::RngCore},
};
use chrono::Utc;
use reqwest::{Client, Method, StatusCode, header};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;
use zeroize::Zeroizing;

use crate::{
    database::Database,
    models::{ConfigureSyncInput, OperationResult, SyncSettings, SyncState},
};

const MAX_SYNC_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedEnvelope {
    version: u8,
    algorithm: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

pub fn validate_configuration(input: &ConfigureSyncInput) -> Result<()> {
    if input.username.trim().is_empty() || input.password.is_empty() {
        bail!("请填写 WebDAV 用户名和密码");
    }
    if input.passphrase.chars().count() < 8 {
        bail!("同步口令至少需要 8 个字符");
    }
    let parsed = Url::parse(&input.server_url).context("WebDAV 地址格式无效")?;
    let local = parsed
        .host_str()
        .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1"));
    if parsed.scheme() != "https" && !(local && parsed.scheme() == "http") {
        bail!("WebDAV 必须使用 HTTPS；本机 localhost 调试可使用 HTTP");
    }
    if parsed.username() != "" || parsed.password().is_some() {
        bail!("请不要把 WebDAV 用户名或密码写进地址");
    }
    if input.remote_path.trim().is_empty() || input.remote_path.contains("..") {
        bail!("远端同步路径无效");
    }
    Ok(())
}

pub fn to_settings(input: &ConfigureSyncInput, device_id: String) -> SyncSettings {
    SyncSettings {
        enabled: true,
        server_url: input.server_url.trim_end_matches('/').to_string(),
        username: input.username.trim().to_string(),
        remote_path: input.remote_path.trim_start_matches('/').to_string(),
        remember_passphrase: input.remember_passphrase,
        sync_v3_confirmed: true,
        has_credentials: true,
        device_id,
        device_name: if input.device_name.trim().is_empty() {
            hostname::get()
                .ok()
                .and_then(|value| value.into_string().ok())
                .unwrap_or_else(|| "Nudge 设备".into())
        } else {
            input.device_name.trim().chars().take(80).collect()
        },
    }
}

pub async fn test_webdav(input: &ConfigureSyncInput) -> Result<OperationResult> {
    validate_configuration(input)?;
    let client = webdav_client()?;
    let response = client
        .request(Method::OPTIONS, input.server_url.trim_end_matches('/'))
        .basic_auth(&input.username, Some(&input.password))
        .send()
        .await?;
    if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN {
        bail!("WebDAV 凭据无效或没有访问权限");
    }
    if !response.status().is_success() && response.status() != StatusCode::METHOD_NOT_ALLOWED {
        bail!("WebDAV 服务返回 {}", response.status());
    }
    Ok(OperationResult {
        ok: true,
        message: "WebDAV 连接成功。首次同步会创建加密快照。".into(),
    })
}

pub async fn run_sync(
    database: Arc<Database>,
    settings: &SyncSettings,
    password: &str,
    passphrase: &str,
) -> Result<SyncState> {
    if !settings.enabled {
        bail!("同步尚未配置");
    }
    let config = ConfigureSyncInput {
        server_url: settings.server_url.clone(),
        username: settings.username.clone(),
        password: password.into(),
        passphrase: passphrase.into(),
        remote_path: settings.remote_path.clone(),
        remember_passphrase: settings.remember_passphrase,
        device_name: settings.device_name.clone(),
    };
    validate_configuration(&config)?;
    let client = webdav_client()?;
    let remote_url = remote_url(settings)?;

    let mut state = database.get_sync_state()?;
    state.status = "syncing".into();
    state.last_error = None;
    database.set_sync_state(&state)?;

    for attempt in 0..3 {
        let response = client
            .get(remote_url.clone())
            .basic_auth(&settings.username, Some(password))
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                state.status = if error.is_connect() || error.is_timeout() {
                    "offline".into()
                } else {
                    "error".into()
                };
                state.last_error = Some(error.to_string());
                database.set_sync_state(&state)?;
                return Err(error.into());
            }
        };

        let (etag, condition) = if response.status() == StatusCode::NOT_FOUND {
            (None, header::IF_NONE_MATCH)
        } else if response.status().is_success() {
            let etag = response
                .headers()
                .get(header::ETAG)
                .and_then(|value| value.to_str().ok())
                .map(ToOwned::to_owned);
            let bytes = read_limited(response).await?;
            let remote_payload = decrypt_snapshot(&bytes, passphrase)?;
            database.merge_sync_snapshot(&remote_payload)?;
            (etag, header::IF_MATCH)
        } else if response.status() == StatusCode::UNAUTHORIZED
            || response.status() == StatusCode::FORBIDDEN
        {
            bail!("WebDAV 凭据无效或没有访问权限");
        } else {
            bail!("下载远端快照失败：{}", response.status());
        };

        let merged = database.export_sync_snapshot()?;
        let encrypted = encrypt_snapshot(&merged, passphrase)?;
        let mut request = client
            .put(remote_url.clone())
            .basic_auth(&settings.username, Some(password))
            .header(header::CONTENT_TYPE, "application/vnd.nudge.encrypted+json")
            .body(encrypted);
        request = if let Some(etag) = etag.as_deref() {
            request.header(condition.clone(), etag)
        } else {
            request.header(condition.clone(), "*")
        };
        let upload = request.send().await?;
        if upload.status() == StatusCode::PRECONDITION_FAILED {
            if attempt < 2 {
                continue;
            }
            bail!("远端数据持续变化，请稍后重试同步");
        }
        if !upload.status().is_success() {
            if upload.status() == StatusCode::CONFLICT {
                bail!("远端目录不存在，请先在 WebDAV 中创建对应文件夹");
            }
            bail!("上传加密快照失败：{}", upload.status());
        }

        database.clear_sync_queue()?;
        state.status = if database.list_conflicts()?.is_empty() {
            "idle".into()
        } else {
            "conflict".into()
        };
        state.last_synced_at = Some(Utc::now().to_rfc3339());
        state.last_error = None;
        state.pending_changes = 0;
        state.conflict_count = database.list_conflicts()?.len() as i64;
        state.remote_etag = upload
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        database.set_sync_state(&state)?;
        return Ok(state);
    }
    Err(anyhow!("同步重试次数已用尽"))
}

pub fn encrypt_snapshot(payload: &Value, passphrase: &str) -> Result<Vec<u8>> {
    if passphrase.chars().count() < 8 {
        bail!("同步口令至少需要 8 个字符");
    }
    let mut salt = [0_u8; 16];
    let mut nonce = [0_u8; 24];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let key = derive_key(passphrase, &salt)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(&key[..]).map_err(|_| anyhow!("无法初始化同步加密"))?;
    let plaintext = Zeroizing::new(serde_json::to_vec(payload)?);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| anyhow!("同步数据加密失败"))?;
    Ok(serde_json::to_vec(&EncryptedEnvelope {
        version: 2,
        algorithm: "argon2id+xchacha20poly1305".into(),
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    })?)
}

pub fn decrypt_snapshot(encrypted: &[u8], passphrase: &str) -> Result<Value> {
    if encrypted.len() > MAX_SYNC_BYTES {
        bail!("远端同步文件过大");
    }
    let envelope: EncryptedEnvelope =
        serde_json::from_slice(encrypted).context("远端同步文件格式无效")?;
    if !matches!(envelope.version, 1 | 2) || envelope.algorithm != "argon2id+xchacha20poly1305" {
        bail!("远端同步加密版本不受支持");
    }
    let salt = BASE64.decode(envelope.salt).context("同步盐值损坏")?;
    let nonce = BASE64.decode(envelope.nonce).context("同步随机数损坏")?;
    let ciphertext = BASE64.decode(envelope.ciphertext).context("同步密文损坏")?;
    if nonce.len() != 24 || salt.len() < 16 {
        bail!("远端同步加密参数无效");
    }
    let key = derive_key(passphrase, &salt)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(&key[..]).map_err(|_| anyhow!("无法初始化同步解密"))?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| anyhow!("同步口令错误，或远端密文已经损坏"))?,
    );
    serde_json::from_slice(&plaintext).context("解密后的同步数据格式无效")
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(64 * 1024, 3, 1, Some(32)).map_err(|_| anyhow!("Argon2 参数无效"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0_u8; 32]);
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|_| anyhow!("无法派生同步密钥"))?;
    Ok(key)
}

fn webdav_client() -> Result<Client> {
    Ok(Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 {
                return attempt.error("WebDAV 重定向次数过多");
            }
            let Some(previous) = attempt.previous().last() else {
                return attempt.follow();
            };
            let next = attempt.url();
            let same_origin = previous.scheme() == next.scheme()
                && previous.host_str() == next.host_str()
                && previous.port_or_known_default() == next.port_or_known_default();
            if same_origin && (next.scheme() == "https" || next.host_str() == Some("localhost")) {
                attempt.follow()
            } else {
                attempt.error("WebDAV 拒绝跨域或降级重定向")
            }
        }))
        .user_agent("Nudge/2.1 encrypted-webdav")
        .build()?)
}

fn remote_url(settings: &SyncSettings) -> Result<Url> {
    let mut base = Url::parse(&settings.server_url)?;
    if !base.path().ends_with('/') {
        base.set_path(&format!("{}/", base.path()));
    }
    base.join(settings.remote_path.trim_start_matches('/'))
        .context("远端同步路径无效")
}

async fn read_limited(response: reqwest::Response) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_SYNC_BYTES)
    {
        bail!("远端同步文件过大");
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_SYNC_BYTES {
        bail!("远端同步文件过大");
    }
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encrypted_snapshot_round_trip_and_wrong_passphrase() {
        let payload = json!({"schemaVersion": 3, "data": {"tasks": [{"id": "one"}]}});
        let encrypted = encrypt_snapshot(&payload, "correct horse battery staple").unwrap();
        assert!(!String::from_utf8_lossy(&encrypted).contains("one"));
        assert_eq!(
            decrypt_snapshot(&encrypted, "correct horse battery staple").unwrap(),
            payload
        );
        assert!(decrypt_snapshot(&encrypted, "wrong passphrase").is_err());
    }

    #[test]
    fn rejects_insecure_remote_except_localhost() {
        let mut input = ConfigureSyncInput {
            server_url: "http://example.com/dav".into(),
            username: "u".into(),
            password: "p".into(),
            passphrase: "12345678".into(),
            remote_path: "Nudge/data.enc".into(),
            remember_passphrase: false,
            device_name: String::new(),
        };
        assert!(validate_configuration(&input).is_err());
        input.server_url = "http://localhost:8080/dav".into();
        assert!(validate_configuration(&input).is_ok());
    }
}
