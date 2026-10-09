# v0.1 可用版本 Plan

> 目标：跑出一版 `npm run dev` 能启动、能上传录音、能生成双文件纪要、能导出的可用版本。

## 已完成（前置）

- [x] fork 上游 + origin/upstream remote 配好
- [x] minutes/ 纪要引擎（双文件、5项校验、6场景、待办提取）
- [x] proofread/ 名称校对（95 条规则，自动从校对表生成）
- [x] 热词 209 条自动生成
- [x] 前端导出按钮
- [x] 元宝导入 sidecar
- [x] Qwen3-ASR / SenseVoice sidecar
- [x] 清理澄远科技字样
- [x] 设计文档

## 本轮要做

### 1. LLM Provider 补齐
- [ ] 确认上游已有 provider：mock / openai / deepseek / claude-cli / codex-cli / local-qwen
- [ ] 加常见预设：通义千问（DashScope OpenAI 兼容）、智谱（Zhipu OpenAI 兼容）、Moonshot、Ollama（本地）
- [ ] 设置页能选 provider、填 baseUrl/apiKey/model

### 2. 端到端验证
- [ ] npm run dev 启动
- [ ] 确认能打开浏览器页面
- [ ] 用 demo 模式跑一次完整流程：demo 录音 → 转写 → 生成纪要 → 导出双 MD
- [ ] 验证 /api/minutes/:id/preview 返回正确 JSON

### 3. README 更新
- [ ] 写清楚怎么启动、怎么配置 LLM、怎么跑 ASR
- [ ] 写清楚热词/校对表怎么更新

## 验收标准

1. `npm run dev` 启动无报错
2. 浏览器能打开 UI
3. demo 模式下能上传/播放录音
4. 点"导出会议纪要"能下载 .md
5. `npm test` 全绿
