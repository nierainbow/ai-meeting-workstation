# AI Meeting Mate 进化蓝图

> fork 自 [`renjieAI123/ai-meeting-workstation`](https://github.com/renjieAI123/ai-meeting-workstation)（MIT），
> 融合杰思 workspace《会议录音处理 SOP v4.1》方法论 + `meeting-agent` 半成品实测经验 + Type4Me 本地 ASR 实践，
> 打造**完整独立、本地化运行**的 AI 会议伴侣。

## 0. 与上游的关系

- `src/`、`scripts/transcribe_audio.py`、`package.json` 等上游代码**尽量不改**，方便 `git pull upstream main` 持续吸纳。
- 我们的进化层集中在三个位置：
  1. `src/server/minutes/` `src/server/proofread/` — 纪要引擎与名称校对（纯 TS，不依赖上游内部模块）
  2. `scripts/transcribe_sherpa.py` — 新增 sherpa-onnx ASR sidecar（与 transcribe_audio.py 并列）
  3. `config/proofread/` `config/hotwords/` — 配置资产

## 1. ASR 路线（吸收 Type4Me 两段式架构）

Type4Me 设置页确认的本地引擎是 **"SenseVoice 流式 + Qwen3 ASR 校准"**：

| 阶段 | 模型 | 内存 | 作用 |
|---|---|---|---|
| 阶段 1 | SenseVoice int8 (sherpa-onnx) | ~500MB | 快速转写，CPU 1~2 倍实时 |
| 阶段 2 | Qwen3-ASR | ~4GB | 录音结束后对每段做精准二次校准 |

我们的会议场景（文件转写、不需要流式）直接跑阶段 1，可选接阶段 2 做高准确率模式：

| 引擎 | 模型 | 特点 | 状态 |
|---|---|---|---|
| FunASR（上游默认） | paraformer-large + cam++ | 已有，带说话人分离 | 保留 |
| **sherpa-onnx SenseVoice int8** | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` | 239MB，CPU 快，中文识别率优于 paraformer | 本次新增 sidecar |
| Qwen3-ASR 校准 | 4GB | 最高准确率，按需下载 | 二期 |
| Faster-Whisper large-v3 | — | 备选 | 三期 |

**模型复用**：直接软链 `~/Library/Application Support/Type4Me/models/` 下的 SenseVoice int8 和 silero_vad，不重复下载。

**热词复用**：Type4Me 的 `hotwords.txt`（208 条杰思专有名词）已复制到 `config/hotwords/jiesi.txt`。

## 2. 吸纳 Type4Me 的设计思路

| Type4Me 设计 | 在本项目的落地 |
|---|---|
| 流式 ASR confirmed/partial | 实时会议页面保留上游 websocket；文件转写后处理用 sherpa-onnx |
| 模式（modes.json）+ LLM 润色 prompt | `minutes/templates.ts` 的 6 种场景 = 6 种后处理 prompt；可选接本地 LLM 做口语→书面语润色 |
| 自我修正/删语气词/口语转书面语 | 作为可选 LLM 后处理步骤，规则兜底在 `minutes/todos.ts` |
| 热词表 hotwords.txt | `config/hotwords/`，同时喂给 FunASR 和 sherpa-onnx |
| 本地 SQLite 存历史 | 复用上游 better-sqlite3 |

## 3. 吸纳 meeting-agent 的实测结论

- **不做无人值守自动出稿**：声纹绝对识别率有限（冷启动 26.5%，主库匹配 69%），人工确认是刚性环节。
- **两阶段交付**：先快速出纪要（推断名），后声纹回填。对应 `minutes/engine.ts` 一次出双文件。
- **声纹库接口预留**：`speaker/` 目录二期接 resemblyzer/ERes2NetV2。
- **CER 评测待补**：`eval/` 二期用同一份 wav 对比 FunASR vs SenseVoice vs 元宝。

## 4. 吸纳杰思 SOP v4.1 方法论

| SOP 步骤 | 本仓库落地 |
|---|---|
| 双文件输出（交付件/存档包） | `minutes/deliverable.ts` + `minutes/archive.ts` |
| 5 项完整性校验 | `minutes/checklist.ts` |
| 6 种场景模板 | `minutes/templates.ts` |
| 名称校对 | `proofread/corrector.ts` + `config/proofread/jiesi.json` |
| 待办结构化提取 | `minutes/todos.ts` |
| 说话人智能推断 | 上游 speaker_bindings + 二期声纹库 |

## 5. REST API（新增）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/minutes/scenes` | 场景列表 |
| GET | `/api/minutes/:id/preview?scene=review` | JSON 预览（校验+待办+校对+双 MD） |
| GET | `/api/minutes/:id/deliverable.md?scene=review` | 下载交付件 |
| GET | `/api/minutes/:id/archive.md?scene=review` | 下载存档包 |

## 6. 二期路线

1. 声纹库：接 resemblyzer，建 `speaker_gallery.json`，跨录音自动识别人名；
2. 本地 LLM：Ollama / llama.cpp 作为 brainProvider 默认项；
3. CER 评测脚本：量化 FunASR vs SenseVoice vs 元宝；
4. 飞书归档：保留可选 publisher；
5. PyInstaller 打包独立 .app。
