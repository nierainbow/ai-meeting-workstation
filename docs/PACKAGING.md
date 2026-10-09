# 独立 .app 打包方案

> 目标：把 AI Meeting Mate 打成 `AI Meeting Mate.app`，拖到 Applications 双击即用。
> 用户不需要装 Node、Python、pip、模型——全部内置或首次启动引导。

## 1. 分层

```
AI Meeting Mate.app
└── Contents/
    ├── MacOS/
    │   └── AI Meeting Mate          # Electron 主进程（Node 20 SEA 也可）
    ├── Resources/
    │   ├── app.asar                  # server + client build
    │   ├── python/                   # PyInstaller onefile 产物
    │   │   ├── transcribe_audio      # FunASR
    │   │   ├── transcribe_sherpa     # sherpa-onnx SenseVoice
    │   │   └── import_yuanbao        # 元宝链接导入
    │   ├── models/                   # 不进 git，首次启动下载或软链
    │   └── config/
    │       ├── hotwords/jiesi.txt
    │       └── proofread/jiesi.json
    └── Info.plist
```

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | Electron | 已有 React SPA，最快落地；自动更新、菜单栏、通知都现成 |
| Node server | Electron 主进程内嵌 | 不需要单独 SEA，Electron 自带 Node |
| Python sidecar | PyInstaller --onefile | 把 sherpa-onnx/funasr 依赖全打进去 |
| 模型管理 | 首次启动引导 | SenseVoice 239MB 可软链 Type4Me；Qwen3-ASR 4GB 按需下载 |

## 3. Python sidecar 打包

```bash
# 每个 sidecar 单独打
pyinstaller --onefile --name transcribe_sherpa scripts/transcribe_sherpa.py
pyinstaller --onefile --name import_yuanbao scripts/import_yuanbao.py

# FunASR 那个较大（含 torch），单独打，可能要 --collect-all funasr
pyinstaller --onefile --name transcribe_audio \
    --collect-all funasr scripts/transcribe_audio.py
```

产物在 `dist/`，复制到 `app/Resources/python/`。

## 4. Electron 壳

```bash
npm install --save-dev electron electron-builder
```

`electron-builder.yml` 关键配置：
```yaml
appId: com.jiesi.meeting-mate
productName: AI Meeting Mate
mac:
  category: public.app-category.productivity
  target: dmg
extraResources:
  - from: dist/python
    to: python
  - from: config
    to: config
```

主进程启动时：
1. 启动 Node server（spawn `Resources/app.asar/server/index.js`）
2. 加载 `http://localhost:PORT` 到 BrowserWindow
3. 首次启动检测模型目录，缺失则弹窗引导

## 5. 模型管理策略

| 模型 | 大小 | 策略 |
|---|---|---|
| SenseVoice int8 | 239MB | 首次启动检测 `~/Library/Application Support/Type4Me/models/`，存在则软链；否则弹窗下载 |
| silero_vad | 2MB | 打进安装包 |
| Qwen3-ASR | 4GB | **不进安装包**，设置页"高级"里点按钮按需下载 |
| FunASR paraformer | ~1GB | 不进安装包，FunASR 首次运行自动下载 |

## 6. 数据目录（用户态，不进 .app）

```
~/Library/Application Support/AI Meeting Mate/
├── data/
│   ├── app.db
│   ├── discussions/{id}/
│   ├── customers/
│   └── speakers/
└── config/ （首次启动从 Resources 复制到这里，用户可改）
```

## 7. 构建命令

```bash
# 1. 前端构建
npm run build

# 2. Python sidecar
pyinstaller --onefile scripts/transcribe_sherpa.py
pyinstaller --onefile scripts/import_yuanbao.py

# 3. Electron 打包
npx electron-builder --mac
```

产物：`dist/AI Meeting Mate-1.0.0.dmg`
