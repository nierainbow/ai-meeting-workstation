# AI Meeting Mate 设计文档

> 版本：v0.2（2026-10-09）
> 上游基线：`renjieAI123/ai-meeting-workstation` @ `cf2ee33`
> 本仓库：`nierainbow/ai-meeting-workstation`（杰思内部 fork）

## 1. 产品定位

**本地化运行的 AI 会议伴侣**：在一台 Mac 上完成"录音 → 转写 → 说话人分离 → 名称校对 → 纪要生成 → 双文件交付"全流程，不依赖云端 ASR（可选），不把会议内容发到外部服务器。

### 与上游的差异

| 维度 | 上游 ai-meeting-workstation | 本 fork |
|---|---|---|
| ASR | FunASR paraformer + 火山引擎 | FunASR + **sherpa-onnx SenseVoice int8**（Type4Me 同款），预留 Qwen3-ASR 校准 |
| 纪要 | LLM 直接生成一段 | **双文件交付**（干净交付件 + 过程存档包），5 项完整性校验，6 种场景模板 |
| 名称 | 无校对 | **可配置错别词表**（config/proofread/jiesi.json，40+ 条）+ 热词（208 条） |
| 热词 | 无 | config/hotwords/jiesi.txt，喂给本地 ASR |
| Demo 客户 | "澄远科技"虚构 | 中性"示例客户"，无原作者痕迹 |
| 部署 | Node + Python sidecar | 同左，二期 PyInstaller 打 .app |

### 目标用户

杰思集团内部：销售/运营/管理层开客户会议、内部评审、项目复盘后，需要快速出一份可发人的纪要，同时留一份过程存档。

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────┐
│  Browser (React SPA, Vite)                              │
│  - 实时会议时间线                                       │
│  - 讨论列表 / 详情                                      │
│  - 设置页（ASR/LLM 配置）                              │
│  - 【新】导出纪要入口（预览 + 下载双 MD）               │
└──────────────┬──────────────────────────────────────────┘
               │ HTTP / WebSocket
┌──────────────▼──────────────────────────────────────────┐
│  Node Server (Fastify/Express, src/server/)             │
│  ├─ discussions/    讨论 CRUD（上游）                  │
│  ├─ asr/             FunASR / 火山引擎（上游）          │
│  ├─ codex/           LLM 调用（OpenAI 兼容，上游）      │
│  ├─ memory/          客户档案（上游）                   │
│  ├─ ws/              实时事件推送（上游）                │
│  ├─ demo/            演示空间（已中性化）                │
│  ├─ minutes/  【新】纪要引擎                            │
│  │   ├─ engine.ts        编排：校对→校验→待办→双 MD    │
│  │   ├─ checklist.ts      5 项完整性校验                 │
│  │   ├─ todos.ts          规则法待办提取                │
│  │   ├─ templates.ts      6 种场景模板                  │
│  │   ├─ deliverable.ts    渲染干净交付件                │
│  │   ├─ archive.ts        渲染过程存档包                │
│  │   └─ minutesRoutes.ts  GET /api/minutes/*           │
│  └─ proofread/ 【新】名称校对                            │
│      ├─ dictionary.ts    加载 config/proofread/*.json   │
│      └─ corrector.ts     扫描替换 + 存疑标注             │
└──────────────┬──────────────────────────────────────────┘
               │ spawn subprocess
┌──────────────▼──────────────────────────────────────────┐
│  Python sidecar                                         │
│  ├─ transcribe_audio.py   FunASR paraformer（上游）     │
│  └─ transcribe_sherpa.py  【新】sherpa-onnx SenseVoice   │
│      - 阶段1: SenseVoice int8 快速转写                  │
│      - 阶段2: Qwen3-ASR 校准（预留，4GB 模型）          │
└──────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────┐
│  本地资产                                                │
│  ├─ config/hotwords/jiesi.txt       208 条热词           │
│  ├─ config/proofread/jiesi.json     40+ 错别词           │
│  ├─ ~/Library/Application Support/Type4Me/models/         │
│  │   ├─ sense-voice int8.onnx (239MB)                   │
│  │   └─ silero_vad.onnx                                 │
│  └─ data/discussions/...  录音、转写、纪要              │
└──────────────────────────────────────────────────────────┘
```

## 3. 数据流（一次会议的完整生命周期）

```
1. 录音开始
   Browser ──► Node Server ──► WebSocket 推送实时 utterance

2. 文件转写（上传或实时结束）
   Node Server ──spawn──► transcribe_sherpa.py
                          ├─ silero VAD 切段
                          ├─ SenseVoice int8 逐段识别
                          └─ 输出 transcript.txt + speaker_segments.json

3. 说话人分离（上游 FunASR 带 cam++，SenseVoice 版二期接 pyannote）
   每段打 speaker_label: spk0/spk1/...

4. 纪要生成
   Browser 点"生成纪要" ──► GET /api/minutes/:id/preview?scene=review
   Node Server:
     a. 读 transcript + speaker_segments
     b. proofread/corrector 扫描错别词，替换 + 存疑列表
     c. minutes/checklist 跑 5 项完整性校验
     d. minutes/todos 规则法提取待办
     e. minutes/templates 按场景渲染双 MD
     f. 返回 JSON（preview）或 MD 文件（下载）

5. 双文件交付
   - deliverable.md  → 发给参会人（干净，无存疑标注）
   - archive.md      → 自己存档（含存疑、校验结果、原始片段）
```

## 4. ASR 策略

### 4.0 Type4Me 架构深度解析（逆向工程）

Type4Me 的 ASR 不是内嵌在主进程里，而是**独立子进程 + HTTP API**：

```
Type4Me.app (主进程, Swift)
  └── spawn qwen3-asr-server (独立 FastAPI 进程)
        --model-path /Applications/Type4Me.app/Contents/Resources/Models/Qwen3-ASR
        --port 0                    # 0 = OS 随机分配
        --hotwords-file .../hotwords.txt
```

**关键发现**：
- Qwen3-ASR server 是 PyInstaller 打包的独立二进制：`/Applications/Type4Me.app/Contents/Resources/qwen3-asr-server-dist/qwen3-asr-server`
- 它监听 `127.0.0.1:<随机端口>`，FastAPI 提供两个接口：
  - `GET /health` → `{"status":"ok","model_loaded":true}`
  - `POST /transcribe`（body = raw PCM16-LE 音频）→ `{"text":"..."}`
- `--port 0` 时 OS 随机分配端口，Type4Me 主进程通过读取子进程 stdout 发现实际端口
- 模型是标准 HuggingFace safetensors 格式（~4GB），已下载在 `Type4Me.app/Contents/Resources/Models/Qwen3-ASR/`
- SenseVoice int8 是 sherpa-onnx C++ 库，直接链接在主进程里（不是独立 server）

**我们的集成策略**：
- **不依赖 Type4Me 是否在跑**：我们自己 spawn 一个 qwen3-asr-server，用**固定端口 18791**
- **模型路径直接指向 Type4Me.app 里的模型目录**，不复制、不重复下载 4GB
- 新 sidecar：`scripts/transcribe_qwen_asr.py`
- Node server 收到 wav 后，ffmpeg 转 16kHz PCM16，POST 到 `http://127.0.0.1:18791/transcribe`

### 4.1 三档可切换

| 档位 | 引擎 | 模型 | 速度 | 准确率 | 隐私 |
|---|---|---|---|---|---|
| 快档 | sherpa-onnx SenseVoice int8 | 239MB | 1~2x 实时 | 中高 | 完全本地 |
| 准档 | Qwen3-ASR（二期） | 4GB | 0.3x 实时 | 高 | 完全本地 |
| 上游默认 | FunASR paraformer | ~1GB | 0.5x 实时 | 中 | 完全本地 |
| 云端 | 火山引擎 | — | 实时 | 高 | 上传字节 |

### 4.2 热词注入

`config/hotwords/jiesi.txt`（208 行）同时喂给：
- sherpa-onnx（用 `--hotwords-file` 参数）
- FunASR（用 hotwords 参数）

热词来源：Type4Me 日常使用中积累的杰思专有名词（人名、公司名、产品名、行业术语）。

### 4.3 两段式 ASR（吸收 Type4Me）

```
录音中：SenseVoice 流式出字（低延迟预览）
录音后：SenseVoice 全段识别 + 可选 Qwen3-ASR 校准（高准确率定稿）
```

本仓库当前实现阶段 1，阶段 2 预留 `--qwen3-asr-model` 参数。

## 5. 纪要生成策略

### 5.1 双文件交付（来自杰思 SOP v4.1）

| 文件 | 受众 | 内容 |
|---|---|---|
| `会议纪要-{标题}-{日期}.md` | 参会人 | 会议主题、参会人、关键结论、决策、待办、风险 |
| `会议存档-{标题}-{日期}.md` | 自己存档 | 上述全部 + 存疑标注、完整性校验结果、原始转写片段索引 |

### 5.2 5 项完整性校验

1. **时长校验**：录音时长 vs 转写覆盖时长，缺失 >10% 报警
2. **覆盖率校验**：所有 utterance 是否都进入纪要
3. **连续性校验**：说话人切换是否合理
4. **说话人校验**：未识别说话人占比 >30% 报警
5. **可读性校验**：句长/标点/语气词残留比例

### 5.3 6 种场景模板

| scene | 用途 |
|---|---|
| review | 经营复盘 / 项目复盘 |
| interview | 面试 |
| requirement | 需求评审 |
| 1on1 | 一对一沟通 |
| share | 培训分享 |
| general | 通用综合 |

### 5.4 待办提取（规则法兜底）

正则匹配：
- "待办|跟进|负责|action|下一步"
- 人名 + "要/需要/负责" + 动词
- 日期 + "前/之前"

二期接 LLM 做语义提取，规则法作为离线兜底。

## 6. 名称校对

`config/proofread/jiesi.json` 结构：
```json
{
  "冠然": {"correct": "王冠然", "kind": "person"},
  "华新": {"correct": "华鑫", "kind": "company"},
  "铜薄": {"correct": "铜箔", "kind": "term"}
}
```

corrector 扫描 transcript，替换命中词，把未命中的高频词列入"存疑清单"。

## 7. 声纹策略（二期）

### 7.1 实测结论（来自 meeting-agent）

- 声纹冷启动 Top-1 仅 26.5%，主库匹配 69.4%
- **不做无人值守自动出稿**，人工确认是刚性环节
- 自动确认 precision 仅 66.7%，不能 100% 信任

### 7.2 二期实现

- 接 resemblyzer / ERes2NetV2
- 建 `data/speakers/speaker_gallery.json`
- 两阶段交付：先出纪要（spk0/spk1），后声纹回填人名
- 跨录音滚雪球：每次人工确认后更新声纹库

## 8. 与上游的同步策略

### 8.1 Git 布局

```
origin   → nierainbow/ai-meeting-workstation  （我们的 fork，推送目标）
upstream → renjieAI123/ai-meeting-workstation （原作者，拉取更新）
```

### 8.2 进化层隔离原则

我们的代码集中在：
- `src/server/minutes/`（全新目录，不碰上游）
- `src/server/proofread/`（全新目录）
- `scripts/transcribe_sherpa.py`（新文件，不碰 transcribe_audio.py）
- `config/`（新目录）
- `docs/`（新目录）

对上游源码的修改**仅两处**：
- `src/server/index.ts`：加两行 import + 两处 `app.use` 挂载 minutes 路由

这样 `git merge upstream/main` 时冲突面最小。

### 8.3 同步流程

```bash
git fetch upstream
git merge upstream/main
# 解决冲突（预期只有 src/server/index.ts 可能冲突）
npm run typecheck && npm run build && npm test
git push origin main
```

## 9. 配置与部署

### 9.1 本地开发

```bash
npm install
pip install funasr sherpa-onnx soundfile  # ASR sidecar
npm run dev   # 同时起 client (Vite) + server
```

### 9.2 生产打包（二期）

- PyInstaller 把 Python sidecar 打成二进制
- Node 用 pkg 或 SEA 打包
- 最终 .app 拖到 Applications

### 9.3 数据目录

```
data/
├── app.db                    # better-sqlite3
├── discussions/{id}/          # 每次会议一个目录
│   ├── audio.wav
│   ├── transcript.txt
│   ├── speaker_segments.json
│   ├── deliverable.md
│   └── archive.md
├── customers/                # 客户档案
└── speakers/                 # 声纹库（二期）
```

## 10. SOP v4.1 十一步法到代码的映射

杰思现有工作系统（依赖元宝录音）的每一步，在本 app 里都有对应实现：

| SOP 步骤 | 现有工作系统 | 本 app 对应模块 |
|---|---|---|
| Step 0 读项目规范 | 人工读 WORKSPACE_SPEC.md | 启动时加载 `config/` 下配置 |
| Step 1-3 拉元宝链接 | `extract_yuanbao_v3.py` | **`scripts/import_yuanbao.py`**（本次新增） |
| Step 4A 标准模式说话人推断 | Agent 人工推断 | 上游 FunASR cam++ 自动分离 + 手动校正 UI |
| Step 4B 声纹模式阶段一 | 同 4A | 同上（声纹后置） |
| Step 5 五项完整性校验 | Agent 人工执行 | **`minutes/checklist.ts`** 自动跑 |
| Step 6 双文件输出 | Agent 手工拆分模板 | **`minutes/deliverable.ts` + `archive.ts`** 自动渲染 |
| Step 7 名称校对 | 人工查参考表 | **`proofread/corrector.ts`** 自动扫描 + 存疑 |
| Step 8 本地归档 + 飞书 | Agent 写文件 + lark-cli | 本地自动落盘；飞书归档二期接 lark SDK |
| Step 9 知识图谱回写 | 人工 | 三期 |
| Step 10 声纹后置回填 | `extract_yuanbao_voiceprint.py` | 二期接 resemblyzer |

## 11. 元宝导入路径（兼容现有工作流）

用户现在的工作流是"贴元宝链接 → Agent 整理"。本 app 保留这条路径：

```
UI 粘贴元宝链接
  ↓
POST /api/import/yuanbao  { url, cookie? }
  ↓
Node spawn scripts/import_yuanbao.py
  ↓
拉页面 → 解析 __NEXT_DATA__ → 输出 transcript.txt + speaker_segments.json + yuanbao_meta.json
  ↓
走和本地上传录音完全相同的 pipeline：
  proofread → checklist → todos → 双 MD 交付
```

**关键兼容点**：
- 元宝已经做好的说话人区分（isSplitSpeaker）直接用，不重跑 ASR
- 元宝的 AI 摘要（voiceMinutes）作为 `minutes/templates.ts` 的输入参考
- 本地 SenseVoice/FunASR 转写只用于没有元宝链接的场景（自己录音、本地文件）

## 12. 独立 .app 打包方案

### 12.1 目标

最终交付一个 `AI Meeting Mate.app`，拖到 Applications 双击即用，不需要用户装 Node/Python。

### 12.2 打包分层

```
AI Meeting Mate.app
└── Contents/
    ├── MacOS/
    │   └── AI Meeting Mate          # 启动器（Node SEA 或 Electron 主进程）
    ├── Resources/
    │   ├── app.asar                  # Node server + client build
    │   ├── python/
    │   │   ├── transcribe_audio      # PyInstaller 打的 FunASR sidecar
    │   │   ├── transcribe_sherpa     # PyInstaller 打的 sherpa-onnx sidecar
    │   │   └── import_yuanbao       # PyInstaller 打的元宝导入
    │   ├── models/
    │   │   ├── sense-voice/         # 239MB，首次启动从 Type4Me 软链或下载
    │   │   ├── silero_vad/
    │   │   └── (可选) qwen3-asr/    # 4GB，用户按需下载
    │   └── config/
    │       ├── hotwords/jiesi.txt
    │       └── proofread/jiesi.json
    └── Info.plist
```

### 12.3 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | **Electron**（首选）或 Tauri | 已有 React SPA，Electron 最快落地 |
| Node server | Node SEA（Single Executable Application） | 官方原生，无外部依赖 |
| Python sidecar | **PyInstaller --onefile** | 把 sherpa-onnx/funasr 依赖全打进去 |
| 模型 | 不打进安装包（太大） | 首次启动引导用户选择：软链 Type4Me / 重新下载 |

### 12.4 首次启动引导

1. 检测 `~/Library/Application Support/Type4Me/models/` 是否存在
2. 存在 → 软链 SenseVoice + silero_vad，零下载
3. 不存在 → 弹窗引导下载（~250MB SenseVoice int8）
4. 可选下载 Qwen3-ASR（4GB，高准确率模式）

## 13. 二期路线

1. **前端导出按钮**：✅ 已完成
2. **Node 元宝导入路由**：POST /api/import/yuanbao + UI 粘贴入口
3. **sherpa-onnx 实测**：跑真实录音对比 CER
4. **Qwen3-ASR 下载**：4GB 模型，开阶段 2 校准
5. **声纹库**：resemblyzer + 两阶段交付（SOP Step 10）
6. **飞书归档**：接 lark SDK，按本地路径映射飞书文件夹
7. **PyInstaller + Electron 打包 .app**
5. **本地 LLM**：Ollama 默认 brainProvider
6. **CER 评测脚本**：量化 FunASR vs SenseVoice vs 元宝
7. **PyInstaller 打包 .app**

## 14. Type4Me 客户端架构吸纳

> 源码已 fork：`nierainbow/type4me`（上游 joewongjc/type4me）
> 以下架构分析基于本地 Type4Me.app 逆向 + 运行时进程观察。

### 14.1 Type4Me 整体架构

```
Type4Me.app (Swift 主进程, macOS only)
├── 菜单栏 UI / 快捷键监听 / 录音控制
├── sherpa-onnx SenseVoice int8（C++ 内嵌，流式识别）
├── 启动子进程 qwen3-asr-server（PyInstaller 打包, Python 3.12）
│   ├── MLX 后端跑 Qwen3-ASR（Apple Silicon GPU 加速）
│   ├── llama.cpp 跑本地 LLM 后处理（/v1/chat/completions）
│   └── FastAPI: POST /transcribe, GET /health
├── 配置文件 ~/Library/Application Support/Type4Me/
│   ├── hotwords.txt          # 热词（一行一词）
│   ├── modes.json            # 处理模式（不同 prompt）
│   ├── snippets.json         # 快捷文本
│   └── history.db            # SQLite 历史
└── 输出：识别结果直接注入当前输入框（macOS Accessibility API）
```

### 14.2 值得吸纳的设计

| Type4Me 设计 | 在本项目的落地 |
|---|---|
| **两段式 ASR**：SenseVoice 流式预览 + Qwen3-ASR 校准 | 已纳入 4.0 节，文件转写直接用 Qwen3-ASR |
| **模式系统（modes.json）**：不同场景用不同 LLM prompt | `minutes/templates.ts` 的 6 种场景 = 6 种 prompt |
| **热词文件 hotwords.txt**：一行一词，启动时传给 ASR | 已复用 `config/hotwords/jiesi.txt`（208 条） |
| **ASR server 独立进程**：主进程不加载模型，spawn 子进程 | 我们的 Python sidecar 同款设计，Node 通过 HTTP/文件交互 |
| **流式 confirmed/partial**：实时出字 | 上游 WebSocket 已有，文件转写场景不需要 |
| **LLM 后处理润色**：语音识别后用 LLM 做口语→书面语 | 二期接本地 LLM（Ollama），吸纳 modes.json 里的润色 prompt |
| **配置目录用户态**：模型/热词/历史都在 ~/Library/... | 跨平台后改成 `~/.ai-meeting-mate/`（Mac）/ `%APPDATA%/ai-meeting-mate/`（Win） |

### 14.3 不照搬的部分

| Type4Me 设计 | 原因 |
|---|---|
| Swift 主进程 + macOS Accessibility | 我们要跨平台，用 Electron + React |
| 注入输入框 | 我们是会议场景，不是输入法 |
| 快捷键全局监听 | 二期可加，不是核心 |
| MLX 后端 | Apple Silicon 专属，Windows/Linux 用 PyTorch |

## 15. Windows 跨平台兼容

### 15.1 原则

- **不硬编码任何 macOS 路径**（`/Applications/...`、`~/Library/...`）
- 所有模型路径、配置路径通过启动参数或配置文件指定
- Python sidecar 在 Windows 上用 PyInstaller 重新打包
- Electron 主进程跨平台编译

### 15.2 模型路径配置（跨平台）

| 模型 | Mac 默认路径 | Windows 默认路径 |
|---|---|---|
| SenseVoice int8 | 自动下载到 `~/.ai-meeting-mate/models/` | 同左（`%USERPROFILE%\.ai-meeting-mate\models\`） |
| Qwen3-ASR (MLX) | `/Applications/Type4Me.app/.../Qwen3-ASR`（可选软链） | Windows 无 MLX，需下载 PyTorch 版或用 llama.cpp GGUF |
| silero_vad | 自动下载 | 同左 |
| 热词 | `config/hotwords/jiesi.txt` | 同左 |

### 15.3 ASR 引擎跨平台矩阵

| 引擎 | Mac | Windows | 说明 |
|---|---|---|---|
| sherpa-onnx SenseVoice int8 | ✅ | ✅ | sherpa-onnx 官方支持 Windows CPU |
| Qwen3-ASR (MLX) | ✅ Apple Silicon | ❌ | Mac 专属 |
| Qwen3-ASR (PyTorch) | ✅ | ✅ | 跨平台，CPU 慢但可用 |
| Qwen3-ASR (llama.cpp GGUF) | ✅ | ✅ | 跨平台，推荐 Windows 用这个 |
| FunASR paraformer | ✅ | ✅ | Python 跨平台 |
| faster-whisper large-v3 | ✅ | ✅ | CTranslate2，跨平台 CPU/GPU |

**Windows 默认引擎**：sherpa-onnx SenseVoice int8（最快最省），可选 faster-whisper large-v3。

### 15.4 配置目录

```
跨平台配置根目录（通过 appdirs 库自动选择）：
  Mac:    ~/Library/Application Support/AI Meeting Mate/
  Win:    %APPDATA%\AI Meeting Mate\
  Linux:  ~/.config/ai-meeting-mate/

结构：
  models/          # ASR 模型
  config/          # 热词、校对词表
  data/            # 会议数据
  logs/
```

### 15.5 打包目标

| 平台 | 格式 | 工具 |
|---|---|---|
| Mac | .dmg / .app | electron-builder |
| Windows | .exe / .msix | electron-builder + PyInstaller (win64) |
| Linux | .AppImage / .deb | electron-builder（可选） |
