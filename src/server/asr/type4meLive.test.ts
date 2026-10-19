import { describe, expect, it } from "vitest";
import { LivePcmSegmenter } from "./type4meLive";

const BYTES_PER_MS = 32; // 16kHz * 2 bytes / 1000

function chunk(ms: number, amplitude: number): Buffer {
  const bytes = Math.round(ms * BYTES_PER_MS);
  const buffer = Buffer.alloc(bytes - (bytes % 2));
  for (let offset = 0; offset + 1 < buffer.byteLength; offset += 2) {
    buffer.writeInt16LE(amplitude, offset);
  }
  return buffer;
}

describe("LivePcmSegmenter", () => {
  it("语音后静音达到阈值即断句", () => {
    const segmenter = new LivePcmSegmenter({ silenceMs: 700, maxSegmentMs: 8000, rmsThreshold: 120 });
    expect(segmenter.push(chunk(300, 3000))).toBeNull(); // 说话
    const segment = segmenter.push(chunk(800, 0)); // 静音 800ms
    expect(segment).not.toBeNull();
    expect(segment?.reason).toBe("silence");
    expect(segment?.startMs).toBe(0);
    expect(segment?.endMs).toBe(1100);
    expect(segment?.pcm.byteLength).toBe(1100 * BYTES_PER_MS);
  });

  it("连续说话达到最大段长强制断句", () => {
    const segmenter = new LivePcmSegmenter({ silenceMs: 700, maxSegmentMs: 1000, rmsThreshold: 120 });
    let segment = null as ReturnType<LivePcmSegmenter["push"]>;
    for (let i = 0; i < 20 && !segment; i += 1) {
      segment = segmenter.push(chunk(100, 3000));
    }
    expect(segment).not.toBeNull();
    expect(segment?.reason).toBe("max_length");
    expect(segment?.endMs).toBeGreaterThanOrEqual(1000);
  });

  it("纯静音不产出段落且不会无限堆积", () => {
    const segmenter = new LivePcmSegmenter({ silenceMs: 700, maxSegmentMs: 8000, rmsThreshold: 120 });
    for (let i = 0; i < 40; i += 1) {
      expect(segmenter.push(chunk(100, 0))).toBeNull();
    }
    expect(segmenter.bufferedMs).toBeLessThanOrEqual(1000);
    expect(segmenter.flushRemaining()).toBeNull();
  });

  it("会话结束时 flushRemaining 吐出未断句的语音尾巴", () => {
    const segmenter = new LivePcmSegmenter({ silenceMs: 700, maxSegmentMs: 8000, rmsThreshold: 120 });
    segmenter.push(chunk(500, 3000));
    segmenter.push(chunk(100, 0)); // 静音不足 700ms，不断句
    const segment = segmenter.flushRemaining();
    expect(segment).not.toBeNull();
    expect(segment?.endMs).toBe(600);
    expect(segment?.pcm.byteLength).toBe(600 * BYTES_PER_MS);
    expect(segmenter.flushRemaining()).toBeNull();
  });

  it("断句后重新开始累计新段", () => {
    const segmenter = new LivePcmSegmenter({ silenceMs: 700, maxSegmentMs: 8000, rmsThreshold: 120 });
    segmenter.push(chunk(200, 3000));
    const first = segmenter.push(chunk(800, 0));
    expect(first?.startMs).toBe(0);
    segmenter.push(chunk(200, 3000));
    const second = segmenter.push(chunk(800, 0));
    expect(second).not.toBeNull();
    expect(second?.startMs).toBe(first?.endMs);
  });
});
