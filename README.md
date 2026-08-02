# Nudge

Nudge 是一个本地优先的待办、专注和学习规划应用。它支持 Windows、macOS、Linux、Android 和 iOS，数据保存在本机，不需要账号。

![桌面学习包](./docs/screenshots/v2-desktop-learning-pack.png)

## 当前版本

`v2.0.0-beta.1` 是跨平台测试版。桌面包尚未签名，Android 为调试 APK，iOS 仅提供 Apple Silicon 模拟器包。正式使用前请备份数据，并从 [GitHub Releases](https://github.com/Kirtofu/study-nudge/releases) 下载文件。

## 下载

| 平台 | 架构 | 文件 |
| --- | --- | --- |
| Windows 10/11 | x64 | [安装版](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-windows-x64-setup.exe) · [便携版](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-windows-x64-portable.zip) |
| Ubuntu 22.04+ | x64 | [AppImage](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-linux-x64.AppImage) · [deb](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-linux-x64.deb) |
| Ubuntu 22.04+ | ARM64 | [AppImage](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-linux-arm64.AppImage) · [deb](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-linux-arm64.deb) |
| macOS 12+ | Intel | [DMG](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-macos-x64.dmg) · [app.zip](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-macos-x64.app.zip) |
| macOS 12+ | Apple Silicon | [DMG](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-macos-arm64.dmg) · [app.zip](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-macos-arm64.app.zip) |
| Android 10+ | ARM64 | [调试 APK](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-android-arm64-debug.apk) |
| iOS 16+ | Apple Silicon Simulator | [模拟器 app.zip](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/Nudge-2.0.0-beta.1-ios-simulator-arm64.app.zip) |

[SHA-256 校验文件](https://github.com/Kirtofu/study-nudge/releases/download/v2.0.0-beta.1/SHA256SUMS.txt)

## 功能

- 待办：收集箱、今天、计划、已完成、自定义清单、标签、优先级、日期、提醒、备注和子任务。
- 强交互：行内添加、拖拽排序、快捷操作、完成撤销、键盘操作和减少动画模式。
- 专注：番茄钟、自由计时、任务关联、目标统计、历史记录以及休眠/重启后的时间恢复。
- 学习包：为任务整理资料与工具、精选视频和可编辑学习路线。
- 路线图：拖动节点、连接依赖、自动布局、状态推进、撤销和列表视图回退。
- 桌面能力：系统托盘、原生通知、全局快捷键、开机启动和置顶专注窗口。
- 可选服务：OpenAI-compatible/Ollama 推荐、WebDAV/Nextcloud 端到端加密同步。

## 学习包

输入任务后可选择“规划并添加”。任务会先保存到本地，再打开学习包；没有 AI 或网络时会立即使用本地模板。

<table>
  <tr>
    <td><img src="./docs/screenshots/v2-mobile-tabs.png" alt="手机学习包标签页"></td>
    <td><img src="./docs/screenshots/v2-roadmap-editor.png" alt="学习路线编辑器"></td>
    <td><img src="./docs/screenshots/v2-sync-settings.png" alt="同步设置"></td>
  </tr>
</table>

视频只通过系统浏览器或平台 App 打开。远程推荐仅接受安全链接；无法验证的地址会降级为搜索入口。

## 隐私与数据

- 默认离线运行。AI、联网推荐和同步都必须由用户主动开启。
- AI 密钥、WebDAV 凭据和同步口令保存在系统安全存储，不写入数据库、备份或同步内容。
- 远程生成前会显示将发送的数据；默认只发送任务标题、标签和用户主动填写的学习目标。
- SQLite 数据库和最近 7 份自动备份保存在应用数据目录。
- 支持 JSON 导出、合并导入、整库恢复和 SHA-256 校验。

### v1 数据迁移

Windows 首次启动会检测旧版 `%APPDATA%\\Nudge\\nudge.db`，复制后在副本上迁移，不修改旧数据库和备份。旧任务会保留，学习包初始化为空。旧 `data.json` 按内容哈希幂等导入；仓库中的 `study-nudge.ps1` 和 `data.json` 保持不变。

## Beta 限制

- 尚未提供 Windows Authenticode、macOS Developer ID、Android release keystore 或 iOS 真机签名。
- iOS 当前为模拟器包，不能直接安装到真机。
- 不包含账号、云端后端、实时协作、重复任务、看板、月历和自动更新。

## 本地开发

要求 Node.js 22 LTS、Rust 1.85+、npm 10+。桌面构建还需要对应平台的 Tauri 依赖。

```bash
git clone https://github.com/Kirtofu/study-nudge.git
cd study-nudge
npm ci
npm run dev
```

常用检查：

```bash
npm run typecheck
npm test -- --run
npm run build:web
npm run check:rust
```

构建命令：

```bash
npm run build:win
npx tauri build --bundles appimage,deb
npx tauri build --bundles app,dmg
npm run android:build
npm run ios:build
```

## 正式版发布条件

正式版不是只改一个版本号。需要先完成 beta 验证、数据迁移和崩溃检查，再为各平台生成可验证的签名包：Windows Authenticode、macOS Developer ID 和 notarization、Android release keystore、iOS 真机/TestFlight 签名。随后将所有清单和包版本改为 `2.0.0`，移除 Release 工作流的 `--prerelease`，创建 `v2.0.0` tag，上传签名包与 `SHA256SUMS.txt`，并在 GitHub 将 Release 标为正式版。

## 项目结构

```text
src/                  React 界面与共享类型
src-tauri/            Rust 命令、SQLite、通知、托盘、同步与安全存储
docs/screenshots/      README 截图
scripts/               跨平台构建脚本
DESIGN.md              设计系统
PRODUCT.md             产品边界
study-nudge.ps1        v1 脚本（保留）
data.json              v1 数据（保留）
```

## 许可证

MIT
