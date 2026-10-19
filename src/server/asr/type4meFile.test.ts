import { describe, expect, it } from "vitest";
import { extractPcmFromWav } from "./type4meFile";

function buildWav(chunks: Array<{ id: string; data: Buffer }>): Buffer {
  const body = Buffer.concat(
    chunks.map(({ id, data }) => {
      const header = Buffer.alloc(8);
      header.write(id, 0, "ascii");
      header.writeUInt32LE(data.length, 4);
      return Buffer.concat([header, data, data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0)]);
    })
  );
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, body]);
}

describe("extractPcmFromWav", () => {
  it("取出 data 块的原始 PCM", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const wav = buildWav([
      { id: "fmt ", data: Buffer.alloc(16) },
      { id: "data", data: pcm }
    ]);
    expect(extractPcmFromWav(wav).equals(pcm)).toBe(true);
  });

  it("容忍 data 前面的额外块与奇数长度填充", () => {
    const pcm = Buffer.from([9, 8, 7]);
    const wav = buildWav([
      { id: "LIST", data: Buffer.from([1, 2, 3]) },
      { id: "data", data: pcm }
    ]);
    expect(extractPcmFromWav(wav).equals(pcm)).toBe(true);
  });

  it("缺少 data 块时抛错", () => {
    const wav = buildWav([{ id: "fmt ", data: Buffer.alloc(16) }]);
    expect(() => extractPcmFromWav(wav)).toThrow("data");
  });
});
