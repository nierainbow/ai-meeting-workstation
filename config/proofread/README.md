# 名称校对词表

本目录存放会议纪要的专有名词校对规则。`src/server/proofread/` 会在生成交付件时自动加载并扫描转写文本。

## 文件说明

- `jiesi.json` — 杰思集团高频语音识别错误表（从《会议录音处理 SOP v4.1 §7.2》和 `meeting-agent/minutes.py` 吸纳）
- `custom.json` — 用户自定义词表（不提交 git）

## 格式

```json
{
  "corrections": [
    {
      "wrong": "华星科技",
      "right": "华鑫科技",
      "type": "同音/形近",
      "note": "备注（进存档包）"
    }
  ],
  "suspicious": [
    { "pattern": "正则", "guess": "猜测正确写法" }
  ]
}
```

- `corrections`：自动替换。替换发生在**交付件**里；替换记录进**存档包**的"三、名称校对记录"。
- `suspicious`：只标记不替换，列出原文供人工确认，全部进存档包。

## 新增词表

直接编辑 `custom.json`，格式同上。重启服务后生效。
