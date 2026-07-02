import { describe, expect, it } from "vitest";

process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.STT_PROVIDER = "openai";
process.env.DEV_SKIP_AUTH = "true";

// eslint-disable-next-line import/first
import { estimateDurationSeconds } from "../src/pipeline/stt.js";

/**
 * Build a canonical PCM WAV header + `dataSize` bytes of fake sample data.
 * sampleRate*channels*(bitsPerSample/8) bytes per second → dataSize / byteRate
 * seconds of audio. Matches the layout probeWavDuration walks.
 */
function makeWav(opts: {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataSize: number;
}): Buffer {
  const { sampleRate, channels, bitsPerSample, dataSize } = opts;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

describe("estimateDurationSeconds", () => {
  it("computes seconds from a well-formed WAV header", () => {
    // 1 s of 16 kHz mono 16-bit → 32_000 bytes of samples.
    const wav = makeWav({
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      dataSize: 32000,
    });
    expect(estimateDurationSeconds(wav, "wav")).toBeCloseTo(1, 5);

    // 2.5 s at 44.1 kHz stereo 16-bit → 44100 * 2 * 2 * 2.5 = 441_000 bytes.
    const longer = makeWav({
      sampleRate: 44100,
      channels: 2,
      bitsPerSample: 16,
      dataSize: 441_000,
    });
    expect(estimateDurationSeconds(longer, "wav")).toBeCloseTo(2.5, 5);
  });

  it("returns 0 for a short/corrupt WAV buffer without throwing", () => {
    const junk = Buffer.from("not-a-wav");
    expect(() => estimateDurationSeconds(junk, "wav")).not.toThrow();
    expect(estimateDurationSeconds(junk, "wav")).toBe(0);

    // Buffer < 44 bytes — fails the "too short" guard.
    expect(estimateDurationSeconds(Buffer.alloc(20), "wav")).toBe(0);
  });

  it("estimates MP3 duration at ~CBR 128 kbps (±1%)", () => {
    // 128 kbps = 16 000 bytes / second; 32_000 bytes → 2 seconds.
    const mp3 = Buffer.alloc(32_000);
    const out = estimateDurationSeconds(mp3, "mp3");
    expect(out).toBeGreaterThan(1.98);
    expect(out).toBeLessThan(2.02);
  });

  it("returns 0 for unsupported containers we don't parse (m4a/ogg/webm/flac)", () => {
    const data = Buffer.alloc(10_000);
    // These paths hit warnUnsupportedFormatOnce; the return value is what we care about.
    expect(estimateDurationSeconds(data, "m4a")).toBe(0);
    expect(estimateDurationSeconds(data, "ogg")).toBe(0);
    expect(estimateDurationSeconds(data, "webm")).toBe(0);
    expect(estimateDurationSeconds(data, "flac")).toBe(0);
  });
});
