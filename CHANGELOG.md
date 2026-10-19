# Changelog

本文件由 `scripts/generate-changelog.mjs` 从 git 历史自动生成，请勿手改；发布时重跑 `npm run changelog` 即可。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。
发布流程见 [RELEASE.md](RELEASE.md)。

## [0.9.1] - 2026-10-20

### ✨ 新功能
- **client：** 首启模型安装向导（@nierainbow，[`148f7cc`](https://github.com/nierainbow/ai-meeting-workstation/commit/148f7cc)）
- **models：** ModelScope 模型下载器与首启向导接口（@nierainbow，[`51632b4`](https://github.com/nierainbow/ai-meeting-workstation/commit/51632b4)）

### 🐛 Bug 修复
- **models：** 取消与断网时先冲盘已收字节，保证续传有起点（@nierainbow，[`d690908`](https://github.com/nierainbow/ai-meeting-workstation/commit/d690908)）

## [0.9.0] - 2026-10-19

### ✨ 新功能
- **desktop：** Tauri 壳内嵌 Node sidecar，产出可双击启动的 .app（@nierainbow，[`baedc1e`](https://github.com/nierainbow/ai-meeting-workstation/commit/baedc1e)）
- **settings：** API Key 迁入系统钥匙串，磁盘只留引用（@nierainbow，[`fe72a77`](https://github.com/nierainbow/ai-meeting-workstation/commit/fe72a77)）
- **brain：** 接入火山方舟 Ark Coding Plan 作为默认大脑（@nierainbow，[`2aef8be`](https://github.com/nierainbow/ai-meeting-workstation/commit/2aef8be)）
- **asr：** 新增 Type4Me 实时档（type4me-live）（@nierainbow，[`5e2e824`](https://github.com/nierainbow/ai-meeting-workstation/commit/5e2e824)）
- **asr：** 新增 Type4Me 本地文件档转写（@nierainbow，[`1d8162f`](https://github.com/nierainbow/ai-meeting-workstation/commit/1d8162f)）

### ♻️ 重构
- **client：** 拆分 App.tsx 为视图与共享模块（@nierainbow，[`d6d9834`](https://github.com/nierainbow/ai-meeting-workstation/commit/d6d9834)）

### 👷 CI
- 允许手动触发，便于在非 main 分支上验证流水线（@nierainbow，[`5d6f5b1`](https://github.com/nierainbow/ai-meeting-workstation/commit/5d6f5b1)）

### 🔧 其他维护
- 忽略本地 .venv 与 requirements.local.txt（@nierainbow，[`87dd3a4`](https://github.com/nierainbow/ai-meeting-workstation/commit/87dd3a4)）

### 📌 其他变更（非 conventional commit）
- Codex 测试清理改为手动重试，兼容 Windows（@renjieAI123，[`cf2ee33`](https://github.com/nierainbow/ai-meeting-workstation/commit/cf2ee33)）
