# Nudge

Nudge 是一款本地优先的 Windows 桌面待办与专注工具。其设计体系命名为「赭墨纸感 UI」，视觉参考 `invite.ioll.pp.ua`，采用米白纸张底、暖白表面、赭橙强调色、霞鹜文楷与强交互反馈。

## 开发

```powershell
npm install
npm run dev
```

## 检查与构建

```powershell
npm run typecheck
npm test
npm run build
npm run build:win
```

Windows 安装包和便携版会输出到 `release/`。

## 数据

- SQLite：`%APPDATA%\Nudge\nudge.db`
- 自动备份：`%APPDATA%\Nudge\backups`
- 原有 `study-nudge.ps1` 与 `data.json` 保持不变；应用启动时会去重导入旧学习记录。
