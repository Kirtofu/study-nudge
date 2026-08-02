# Nudge v2.0.0-beta.1

这是 Nudge 首个跨平台学习包测试版。任务保存仍然完全本地优先，学习资源、视频入口与可编辑路线图会直接附着在任务下方；AI 推荐和 WebDAV 加密同步都需要用户主动配置。

## 主要变化

- Electron 迁移到 Tauri 2 + React + TypeScript + Rust + SQLite。
- 新增“资料与工具 / 精选视频 / 学习路线”三栏学习包。
- 路线图支持节点拖拽、依赖连线、自动布局、完成状态、撤销与列表视图。
- 可选 OpenAI-compatible、Ollama 推荐；密钥仅保存在 Stronghold。
- 可选通用 WebDAV / Nextcloud 端到端加密同步。
- 新增 Windows、macOS、Linux、Android 和 iOS Simulator 构建。
- Windows v1 数据库、v1 JSON 和旧 `data.json` 可幂等迁移，原文件不会被修改。

## Beta 说明

- Android 提供 ARM64 调试 APK，安装时会显示测试包提示。
- iOS 仅提供 Apple Silicon 模拟器 `.app.zip`，不包含签名 IPA。
- 桌面包尚未签名；请从本仓库 Release 下载并核对 `SHA256SUMS.txt`。
- v1.0.0 Release 和仓库中的原 Git LFS 软件包保持不变。
