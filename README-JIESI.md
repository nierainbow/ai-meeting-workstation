# AI Meeting Mate（杰思内部 fork）

本地化运行的 AI 会议伴侣，fork 自 [renjieAI123/ai-meeting-workstation](https://github.com/renjieAI123/ai-meeting-workstation)。

## 快速启动

```bash
npm install
npm run dev
# 打开 http://127.0.0.1:5173
```

## LLM 配置（主流大模型）

设置页选 `openai` 或 `deepseek` provider，按下表填 baseUrl/apiKey/model：

| 厂商 | baseUrl | model 示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| 通义千问 DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama（本地） | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` |

也支持 `claude-cli`、`codex-cli`（本机已装 CLI 时）。

## ASR 配置

| 引擎 | 说明 |
|---|---|
| FunASR（默认） | 上传录音后本地转写，需 `pip install funasr` |
| sherpa-onnx SenseVoice int8 | `python scripts/transcribe_sherpa.py`，239MB，CPU 快 |
| Qwen3-ASR | `python scripts/transcribe_qwen_asr.py`，复用 Type4Me 已下载的 4GB 模型 |
| 元宝链接导入 | `python scripts/import_yuanbao.py --url <元宝链接>` |

## 热词与校对表（自动生成）

```bash
# 从《杰思集团名称校对参考表》自动生成热词和错别词表
python scripts/build_jiesi_config.py
```

改了校对表后跑一次即可，不需要手动维护 `config/` 下的文件。

## 同步上游

```bash
git fetch upstream
git merge upstream/main
git push origin main
```
