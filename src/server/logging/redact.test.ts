import { describe, expect, it } from "vitest";
import { REDACTED, isSensitiveKey, redact, redactSecretsInText } from "./redact";

describe("redact", () => {
  it("replaces sensitive-key fields entirely regardless of value", () => {
    const input = {
      volcengineApiKey: "sk-real-secret",
      resourceId: "volc.seedasr.sauc.duration",
      nested: { deepseekApiKey: "also-secret", fine: "keep me" }
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.volcengineApiKey).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).deepseekApiKey).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).fine).toBe("keep me");
    expect(out.resourceId).toBe("volc.seedasr.sauc.duration");
  });

  it("matches keys case-insensitively and on substring", () => {
    expect(isSensitiveKey("API_KEY")).toBe(true);
    expect(isSensitiveKey("auth")).toBe(true);
    expect(isSensitiveKey("topic")).toBe(false);
    expect(isSensitiveKey("customerName")).toBe(false);
  });

  it("truncates long strings and notes the total length", () => {
    const long = "x".repeat(5000);
    const out = redact(long, 2000) as string;
    expect(out.endsWith("…(truncated, total 5000 chars)")).toBe(true);
    expect(out.length).toBeLessThan(5000);
  });

  it("keeps short strings intact (no transcription-style mangling)", () => {
    expect(redact("会议纪要的第一句话", 2000)).toBe("会议纪要的第一句话");
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });

  it("redacts buffer values to a length note, never the bytes", () => {
    const out = redact(Buffer.from("secret-audio-bytes")) as string;
    expect(out).toContain("bytes, redacted");
    expect(out).not.toContain("secret-audio-bytes");
  });

  it("redacts arrays element-by-element", () => {
    const out = redact([{ apiKey: "a" }, "short text"]) as unknown[];
    expect((out[0] as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect(out[1]).toBe("short text");
  });
});

describe("redactSecretsInText", () => {
  it("masks sk- prefixed tokens", () => {
    expect(redactSecretsInText("token=sk-abcdefghijklmnop")).toBe("token=" + REDACTED);
  });

  it("masks Bearer tokens", () => {
    expect(redactSecretsInText("Authorization: Bearer abcdef1234567890")).toBe("Authorization: " + REDACTED);
  });

  it("leaves ordinary Chinese log lines untouched", () => {
    const line = "正在启动本地转写引擎，参与者 3 人";
    expect(redactSecretsInText(line)).toBe(line);
  });
});
