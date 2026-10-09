# AI Meeting Mate 开发计划

> 更新：2026-10-09
> 当前版本：v0.1（可启动、API 通、待端到端实测）
> 仓库：nierainbow/ai-meeting-workstation（fork 自 renjieAI123/ai-meeting-workstation）

---

## v0.1 ✅ 已完成（可启动版本）

### 基础工程
- [x] fork 上游，origin/upstream remote 配好
- [x] 进化层隔离在新目录，merge 冲突面极小
- [x] 清理"澄远科技"等原作者 demo 字样

### 纪要引擎
- [x] `src/server/minutes/`：双文件交付（交付件 + 存档包）
- [x] 5 项完整性校验（时长/覆盖率/连续性/说话人/可读性）
- [x] 6 种场景模板（综合/面试/评审/需求/分享/1对1）
- [x] 规则法待办提取
- [x] REST: `/api/minutes/:id/preview|deliverable.md|archive.md`

### 名称校对与热词
- [x] `src/server/proofread/`：错别词自动替换 + 存疑标注
- [x] `scripts/build_jiesi_config.py`：从《杰思名称校对参考表》自动生成
  - 热词 209 条 → `config/hotwords/jiesi.txt`
  - 错别词规则 95 条 → `config/proofread/jiesi.json`

### ASR sidecar
- [x] `transcribe_sherpa.py`：sherpa-onnx SenseVoice int8（Type4Me 同款）
- [x] `transcribe_qwen_asr.py`：Qwen3-ASR server（复用 Type4Me 4GB 模型）
- [x] `import_yuanbao.py`：元宝链接导入（解析 __NEXT_DATA__）

### LLM 接入
- [x] 上游已有：mock / openai / deepseek / claude-cli / codex-cli
- [x] OpenAI 兼容预设表：通义千问、智谱、Moonshot、Ollama
- [x] README-JIESI.md 写清楚配置方法

### 前端
- [x] 两处"导出会议纪要"/"导出存档包"按钮

### 验证
- [x] typecheck / build / 99 个测试全绿
- [x] dev server 启动，`/api/minutes/scenes` 正常返回

---

## v0.2 待做（端到端可用）

### P0：真实录音跑通
- [ ] 找一段真实会议录音，跑 FunASR 完整转写
- [ ] 验证转写结果进入讨论时间线
- [ ] 点"导出会议纪要"能下载完整 .md
- [ ] 验证校对规则实际生效（华星→华鑫等）
- [ ] 验证5项校验报告输出正确

### P1：元宝导入 UI
- [ ] Node 端加 `POST /api/import/yuanbao` 路由
- [ ] 前端加"粘贴元宝链接"输入框
- [ ] 导入后自动走完整 pipeline（校对→校验→双 MD）

### P2：ASR 引擎选择器
- [ ] 设置页加 ASR provider 下拉：FunASR / SenseVoice / Qwen3-ASR
- [ ] `transcribe_qwen_asr.py` 实测跑一段录音，对比 CER
- [ ] 安装 sherpa-onnx：`pip install sherpa-onnx soundfile`

---

## v0.3 待做（体验完善）

### P0：声纹库（两阶段交付）
- [ ] 接 resemblyzer，建 `data/speakers/speaker_gallery.json`
- [ ] 阶段一：推断初标，立即出纪要
- [ ] 阶段二：交付后声纹识别 + 姓名回填
- [ ] 参考 SOP Step 10 的阈值（score≥0.65, gap≥0.08）

### P1：飞书归档
- [ ] 接 lark SDK
- [ ] 按本地路径映射飞书文件夹（参考本地到飞书文件夹映射表）
- [ ] 只归档交付件，存档包默认不入飞书

### P2：LLM 润色后处理
- [ ] 吸纳 Type4Me modes.json 的口语→书面语 prompt
- [ ] 可配置开关：转写后自动做润色
- [ ] 接 Ollama 本地 LLM 做后处理

---

## v1.0 待做（独立 .app）

### P0：打包
- [ ] PyInstaller 打 Python sidecar（FunASR/SenseVoice/Qwen3-ASR/元宝导入）
- [ ] electron-builder 打 .app / .exe
- [ ] 首次启动引导：检测模型、软链 Type4Me、可选下载 Qwen3-ASR
- [ ] 配置目录跨平台（Mac `~/Library/Application Support/`、Win `%APPDATA%`）

### P1：Windows 兼容
- [ ] ASR 引擎矩阵确认（SenseVoice / faster-whisper / Qwen3-ASR GGUF）
- [ ] 路径全部用 appdirs，不硬编码 /Applications/
- [ ] Windows 上 PyInstaller 重新打包 Python sidecar

### P2：文档
- [ ] 用户手册
- [ ] 运维手册（怎么加新词、怎么更新校对表）

---

## 验收标准（v0.2）

1. 上传一段 30 分钟录音，5 分钟内出转写
2. 点导出能拿到干净的 .md 纪要
3. 华星→华鑫、德芙→德福科技 等错别词自动校正
4. 元宝链接粘贴后 10 秒内出纪要
5. `npm test` 全绿
