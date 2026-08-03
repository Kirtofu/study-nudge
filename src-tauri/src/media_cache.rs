use std::{
    fs,
    io::Cursor,
    net::IpAddr,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{GenericImageView, ImageEncoder, codecs::jpeg::JpegEncoder, imageops::FilterType};
use reqwest::{Client, Response};
use sha2::{Digest, Sha256};
use url::Url;

const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

pub async fn thumbnail_data_url(cache_dir: &Path, source: &str) -> Result<String> {
    let source_url = validate_thumbnail_url(source).await?;
    fs::create_dir_all(cache_dir).context("创建缩略图缓存目录失败")?;
    let cache_path = cache_path(cache_dir, source);
    if let Ok(bytes) = fs::read(&cache_path) {
        return Ok(as_data_url(&bytes));
    }

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(18))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Nudge/2.1 thumbnail-cache")
        .build()?;
    let response = fetch_with_safe_redirects(&client, source_url).await?;
    if !response.status().is_success() {
        bail!("缩略图服务器返回了 {}", response.status());
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_SOURCE_BYTES)
    {
        bail!("缩略图文件过大");
    }
    let bytes = response.bytes().await.context("读取缩略图失败")?;
    if bytes.len() > MAX_SOURCE_BYTES {
        bail!("缩略图文件过大");
    }
    let image = image::load_from_memory(&bytes).context("缩略图不是受支持的图片格式")?;
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 || width > 10_000 || height > 10_000 {
        bail!("缩略图尺寸无效");
    }
    let resized = image.resize(640, 360, FilterType::Lanczos3).to_rgb8();
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(Cursor::new(&mut output), 82)
        .write_image(
            resized.as_raw(),
            resized.width(),
            resized.height(),
            image::ExtendedColorType::Rgb8,
        )
        .context("压缩缩略图失败")?;
    fs::write(&cache_path, &output).context("写入缩略图缓存失败")?;
    Ok(as_data_url(&output))
}

fn cache_path(cache_dir: &Path, source: &str) -> PathBuf {
    let digest = Sha256::digest(source.as_bytes());
    cache_dir.join(format!("{}.jpg", hex::encode(digest)))
}

fn as_data_url(bytes: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes))
}

async fn fetch_with_safe_redirects(client: &Client, mut url: Url) -> Result<Response> {
    let origin = origin_key(&url)?;
    for redirect_count in 0..=MAX_REDIRECTS {
        validate_resolved_host(&url).await?;
        let response = client
            .get(url.clone())
            .send()
            .await
            .context("获取缩略图失败")?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        if redirect_count == MAX_REDIRECTS {
            bail!("缩略图重定向次数过多");
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| anyhow!("缩略图重定向地址无效"))?;
        let next = url.join(location).context("缩略图重定向地址无效")?;
        if origin_key(&next)? != origin {
            bail!("缩略图不能跨域重定向");
        }
        url = next;
    }
    unreachable!()
}

async fn validate_thumbnail_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).context("缩略图地址无效")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        bail!("缩略图必须使用 HTTPS");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("缩略图地址缺少主机名"))?;
    let allowed = host == "i.ytimg.com"
        || host.ends_with(".ytimg.com")
        || host == "hdslb.com"
        || host.ends_with(".hdslb.com");
    if !allowed {
        bail!("缩略图来源不受信任");
    }
    validate_resolved_host(&url).await?;
    Ok(url)
}

async fn validate_resolved_host(url: &Url) -> Result<()> {
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("缩略图地址缺少主机名"))?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .context("无法解析缩略图地址")?;
    for address in addresses {
        if is_private_address(address.ip()) {
            bail!("缩略图地址解析到了私网或本机地址");
        }
    }
    Ok(())
}

fn is_private_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => {
            value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_broadcast()
                || value.is_unspecified()
        }
        IpAddr::V6(value) => {
            value.is_loopback()
                || value.is_unspecified()
                || value.is_unique_local()
                || value.is_unicast_link_local()
        }
    }
}

fn origin_key(url: &Url) -> Result<(String, String, u16)> {
    Ok((
        url.scheme().to_string(),
        url.host_str()
            .ok_or_else(|| anyhow!("地址缺少主机名"))?
            .to_string(),
        url.port_or_known_default().unwrap_or(443),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_untrusted_thumbnail_hosts_before_network_access() {
        assert!(
            validate_thumbnail_url("https://example.com/image.jpg")
                .await
                .is_err()
        );
        assert!(
            validate_thumbnail_url("http://i.ytimg.com/image.jpg")
                .await
                .is_err()
        );
    }
}
