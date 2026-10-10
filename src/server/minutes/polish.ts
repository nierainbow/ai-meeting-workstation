import type { UtteranceDto } from "../../shared/types";

export type PolishSettings = {
  brainProvider: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  deepseekBaseUrl: string;
  deepseekApiKey: string;
  deepseekModel: string;
};

const POLISH_SYSTEM_PROMPT = `你是一个会议纪要整理专家。把口语化的会议转写润色成简洁、专业的书面语。
要求：
1. 去掉语气词（嗯、啊、那个、就是说）和重复
2. 把零散的句子整合成完整的句子
3. 保留所有事实、数字、人名、术语
4. 不要添加原文没有的内容
5. 不要改变原意
6. 输出格式：直接输出润色后的文本，不要解释`;

/**
 * 对单段转写做 LLM 润色
 */
export async function polishUtterance(
  text: string,
  settings: PolishSettings
): Promise<string> {
  if (!settings.openaiApiKey && !settings.deepseekApiKey) {
    return text; // 没配置 API key 就跳过
  }

  const isDeepseek = settings.brainProvider === "deepseek";
  const baseUrl = isDeepseek ? settings.deepseekBaseUrl : settings.openaiBaseUrl;
  const apiKey = isDeepseek ? settings.deepseekApiKey : settings.openaiApiKey;
  const model = isDeepseek ? settings.deepseekModel : settings.openaiModel;

  if (!apiKey) return text;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: POLISH_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });

    if (!res.ok) return text;
    const data = await res.json();
    const polished = data.choices?.[0]?.message?.content?.trim();
    return polished || text;
  } catch {
    return text; // 失败就回退到原文
  }
}

/**
 * 批量润色所有 utterance（带并发控制）
 */
export async function polishAllUtterances(
  utterances: UtteranceDto[],
  settings: PolishSettings,
  concurrency = 3
): Promise<UtteranceDto[]> {
  const results: UtteranceDto[] = new Array(utterances.length);
  let index = 0;

  async function worker() {
    while (index < utterances.length) {
      const i = index++;
      const u = utterances[i];
      const polished = await polishUtterance(u.text, settings);
      results[i] = { ...u, text: polished };
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
