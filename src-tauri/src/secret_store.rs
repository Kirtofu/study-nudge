use std::collections::HashMap;

use anyhow::{Context, Result, anyhow};
use keyring_core::{Entry, Error as KeyringError, set_default_store};
use parking_lot::Mutex;
use zeroize::Zeroizing;

use crate::models::SecretStoreStatus;

pub const API_KEY: &str = "recommendation-api-key";
pub const WEBDAV_PASSWORD: &str = "webdav-password";
pub const SYNC_PASSPHRASE: &str = "sync-passphrase";

const SERVICE: &str = "io.github.kirtofu.nudge";

pub struct SecretStore {
    available: bool,
    backend: String,
    detail: Option<String>,
    session: Mutex<HashMap<String, Zeroizing<String>>>,
}

impl SecretStore {
    pub fn isolated() -> Self {
        Self {
            available: false,
            backend: "isolated-test-session".into(),
            detail: None,
            session: Mutex::new(HashMap::new()),
        }
    }
    pub fn new() -> Self {
        match install_native_store() {
            Ok(()) => Self {
                available: true,
                backend: native_store_name().into(),
                detail: None,
                session: Mutex::new(HashMap::new()),
            },
            Err(error) => Self {
                available: false,
                backend: "session-only".into(),
                detail: Some(format!("系统密钥库不可用：{error}")),
                session: Mutex::new(HashMap::new()),
            },
        }
    }

    pub fn status(&self, migration: &str) -> SecretStoreStatus {
        SecretStoreStatus {
            available: self.available,
            backend: self.backend.clone(),
            migration: migration.into(),
            detail: self.detail.clone(),
        }
    }

    fn entry(&self, key: &str) -> Result<Entry> {
        if !self.available {
            return Err(anyhow!("系统密钥库不可用，本次会话结束后不会保存秘密"));
        }
        Entry::new(SERVICE, key).context("无法访问系统密钥库")
    }

    pub fn get(&self, key: &str) -> Result<Option<Zeroizing<String>>> {
        if let Some(value) = self.session.lock().get(key) {
            return Ok(Some(Zeroizing::new(value.to_string())));
        }
        if !self.available {
            return Ok(None);
        }
        match self.entry(key)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(anyhow!("读取系统密钥库失败：{error}")),
        }
    }

    pub fn set(&self, key: &str, value: &str, persistent: bool) -> Result<()> {
        if value.is_empty() {
            return self.delete(key);
        }
        if !persistent || self.backend == "isolated-test-session" {
            self.session
                .lock()
                .insert(key.into(), Zeroizing::new(value.into()));
            return Ok(());
        }
        let entry = self.entry(key)?;
        entry.set_password(value).context("写入系统密钥库失败")?;
        let verified = entry.get_password().context("验证系统密钥库写入失败")?;
        if verified != value {
            return Err(anyhow!("系统密钥库回读验证失败"));
        }
        self.session.lock().remove(key);
        Ok(())
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        self.session.lock().remove(key);
        if !self.available {
            return Ok(());
        }
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(anyhow!("清理系统密钥库失败：{error}")),
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.get(key).ok().flatten().is_some()
    }
}

fn native_store_name() -> &'static str {
    #[cfg(target_os = "windows")]
    return "Windows Credential Manager";
    #[cfg(target_os = "linux")]
    return "Linux Secret Service";
    #[cfg(target_os = "macos")]
    return "macOS Keychain";
    #[cfg(target_os = "ios")]
    return "iOS Keychain";
    #[cfg(target_os = "android")]
    return "Android Keystore";
    #[allow(unreachable_code)]
    "session-only"
}

fn install_native_store() -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        set_default_store(windows_native_keyring_store::Store::new()?);
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        set_default_store(zbus_secret_service_keyring_store::Store::new()?);
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        set_default_store(apple_native_keyring_store::keychain::Store::new()?);
        return Ok(());
    }
    #[cfg(target_os = "ios")]
    {
        set_default_store(apple_native_keyring_store::protected::Store::new()?);
        return Ok(());
    }
    #[cfg(target_os = "android")]
    {
        set_default_store(android_native_keyring_store::Store::new()?);
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(anyhow!("当前平台没有受支持的系统密钥库"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_store_keeps_session_secret_only() {
        let store = SecretStore {
            available: false,
            backend: "session-only".into(),
            detail: None,
            session: Mutex::new(HashMap::new()),
        };
        store.set("test", "value", false).unwrap();
        let secret = store.get("test").unwrap();
        assert_eq!(secret.as_ref().map(|value| value.as_str()), Some("value"));
        assert!(store.set("persistent", "value", true).is_err());
    }
}
