/**
 * 日志脱敏工具：用于把结构化日志与诊断包里的敏感字段擦除、长文本截断。
 *
 * 两条硬约束（来自 T1.5 验收）：
 *  - 不落 Key：任何 key/secret/token/password 等名字的字段一律整段替换为 [REDACTED]。
 *  - 不落转写全文：超过阈值的长字符串（如整段转写）截断为前缀 + 长度提示。
 */

export const REDACTED = "[REDACTED]";

/** 命中即整段擦除的字段名（大小写不敏感，做子串匹配）。 */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /authorization/i,
  /auth/i,
  /cookie/i,
  /private/i,
  /apikey/i
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * 递归脱敏一个值。
 * @param value 任意结构（对象/数组/基本类型）。
 * @param maxStringLength 超过该长度的字符串截断（默认 2000，转写全文通常远超）。
 */
export function redact(value: unknown, maxStringLength = 2000): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, maxStringLength));
  }

  if (typeof value === "object") {
    if (Buffer.isBuffer(value)) {
      return "<" + value.byteLength + " bytes, redacted>";
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(val, maxStringLength);
    }
    return out;
  }

  if (typeof value === "string") {
    if (value.length > maxStringLength) {
      return value.slice(0, maxStringLength) + "…(truncated, total " + value.length + " chars)";
    }
    return value;
  }

  return value;
}

/**
 * 针对已经拼成一段文本（例如 console 输出、错误串）的兜底脱敏：
 * 把形如 KEY=value 或常见令牌前缀（sk-、AKID、Bearer ）的敏感片段擦除。
 * 只做保守匹配，避免误伤普通中文日志。KEY/TOKEN= 这类用 lookbehind 只擦值、保留前缀。
 */
const SECRET_TEXT_PATTERNS: RegExp[] = [
  /(sk-[A-Za-z0-9]{8,})/g,
  /(AKID[A-Za-z0-9]{8,})/g,
  /(Bearer\s+[A-Za-z0-9._-]{8,})/gi,
  /(?<=(?:API_?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)\S+/gi
];

export function redactSecretsInText(text: string): string {
  let result = text;
  for (const pattern of SECRET_TEXT_PATTERNS) {
    result = result.replace(pattern, () => REDACTED);
  }
  return result;
}
