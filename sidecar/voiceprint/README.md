# 声纹 sidecar（voiceprint）

离线声纹抽取与说话人识别服务，由 ai-meeting-workstation 的 Node 侧拉起（默认端口 **8792**）。

## 定位

```
┌──────────────────────┐   POST /identify   ┌──────────────────────────┐
│ ai-meeting-workstation│ ────────────────▶ │ sidecar/voiceprint :8792 │
│ (Electron/Node)       │ ◀──────────────── │ ERes2NetV2 聚类           │
│  声纹 UI（只显示「疑似」）│  clusters/pending │ Resemblyzer 主库匹配      │
└──────────────────────┘                   └──────────────────────────┘
```

- 聚类用 ERes2NetV2-192（diarization），**匹配主库只用 Resemblyzer-256**（16 人主库维度一致，防混维）。
- 模型权重走 ModelScope（`~/.cache/modelscope/models/iic--speech_eres2netv2_sv_zh-cn_16k-common`）。
- 声纹主库 `gallery.pkl` **永不进 git**（`*.pkl` 已在 .gitignore）；只登记路径 + sha256（`GET /gallery` 返回）。
- 首启自举：`.local-data/voiceprint/gallery.pkl` 不存在时，从 `meeting-agent/assets/speaker_gallery_master.pkl` 拷贝一份。

## 硬约束（来自《产品化规划-2026-10-19》第七节）

1. 声纹 Top-1 实测 25–70%，独立 16 人库自动确认精度仅 66.7% → **自动认人结果只能显示「疑似：姓名？」，禁止当事实**。
2. `< 1.5s` 的噪声碎片不进待确认队列（`min_duration_sec=1.5`）。
3. 贡献包三件套保持 `metadata.format=ressemblyzer-256`，兼容既有 merge 脚本。
4. 双条件才自动确认：`score >= 0.65 且 gap >= 0.05`。

## 运行

```bash
# 解释器需含 resemblyzer + funasr + fastapi（workstation .venv 已装齐）
VOICEPRINT_PYTHON_PATH=../.venv/bin/python \
  python -m uvicorn sidecar.voiceprint.app:app --host 127.0.0.1 --port 8792

# 或直接
./sidecar/voiceprint/server.py
```

Node 侧拉起方式（T2.2 起）参考 `src/server/asr/funasrFile.ts` 的 spawnCommand 模式：
`VOICEPRINT_PYTHON_PATH` 优先，其次 `.venv/bin/python`，最后 `python3`。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 解释器能力（embedder 是否可导入）、主库路径/sha256、阈值口径 |
| POST | `/identify` | `{audioPath, utterances:[{id?, startMs?, endMs?, ranges?, label?}], meetingId?, title?}` → `{clusterCount, clusters:[{clusterId, 疑似姓名, score, gap, durationSec, utterances, 疑似, autoName}], pending, galleryCount}` |
| POST | `/confirm` | `{meetingId, clusterId, 姓名|null}` → 暂存人工确认（null = 拒绝该簇） |
| GET | `/gallery` | `{path, sha256, count, speakers:[{name, sample_count, total_seconds}]}` |
| POST | `/gallery` | `{action: rename\|merge\|delete, old/new/src/dst/name}` |
| POST | `/finalize` | `{meetingId, contributor?, meetingTitle?}` → 加权累积回库 + 导出贡献三件套到 `.local-data/voiceprint/contrib/<meetingId>-<ts>/` |

## 与 meeting-agent 基线的对齐口径

- 输入：`utterances` 每个元素 = 一个说话人的若干句子区间（ranges 按序拼接），即 meeting-agent 的 `voice_id -> [(start_ms,end_ms)]`。
- 聚类：`cluster_segments(seg_audio, eres2net, threshold=0.40, min_duration_sec=1.5)`。
- 匹配：每簇拼接音频 → `Gallery.match_segments(cluster_audio, resemblyzer, threshold=0.65, margin=0.05)`。
- 累积：`finalize` 用 utterance 级音频（不是簇级）做加权累积，与 `MeetingPipeline.finalize` 一致。
