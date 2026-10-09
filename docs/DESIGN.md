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

## 10. 二期路线

1. **前端导出按钮**：React UI 加"导出纪要"入口
2. **sherpa-onnx 实测**：跑真实录音对比 CER
3. **Qwen3-ASR 下载**：4GB 模型，开阶段 2 校准
4. **声纹库**：resemblyzer + 两阶段交付
5. **本地 LLM**：Ollama 默认 brainProvider
6. **CER 评测脚本**：量化 FunASR vs SenseVoice vs 元宝
7. **PyInstaller 打包 .app**
