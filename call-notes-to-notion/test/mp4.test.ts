import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Mp4Error, extractPart, looksLikeMp4, parseMp4Audio, planSplit } from "../src/mp4";
import { buildSyntheticMp4 } from "./mp4-helpers";

function sampleData(bytes: Uint8Array, track: ReturnType<typeof parseMp4Audio>, i: number): Uint8Array {
  return bytes.subarray(track.sampleOffsets[i], track.sampleOffsets[i] + track.sampleSizes[i]);
}

function topLevelTypes(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = 0; pos + 8 <= bytes.length; ) {
    out.push(String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)));
    pos += v.getUint32(pos);
  }
  return out;
}

describe("parseMp4Audio", () => {
  const src = buildSyntheticMp4({ samples: 100, sampleSize: (i) => 50 + (i % 9) });

  it("leest samples, groottes, posities (ook verspreid over chunks) en duur", () => {
    expect(looksLikeMp4(src.bytes)).toBe(true);
    const track = parseMp4Audio(src.bytes);
    expect(track.sampleSizes.length).toBe(100);
    expect(track.mediaTimescale).toBe(22050);
    expect(track.durationSeconds).toBeCloseTo((100 * 1024) / 22050, 6);
    for (let i = 0; i < 100; i++) expect(Array.from(sampleData(src.bytes, track, i))).toEqual(Array.from(src.samples[i]));
  });

  it("weigert bestanden die geen MP4 zijn, zonder audiotrack, gefragmenteerd of afgekapt", () => {
    expect(looksLikeMp4(new TextEncoder().encode("RIFF....WAVEfmt "))).toBe(false);
    expect(() => parseMp4Audio(new Uint8Array(64))).toThrow(Mp4Error);
    expect(() => parseMp4Audio(buildSyntheticMp4({ samples: 10, handler: "vide" }).bytes)).toThrow("Geen audiotrack");
    expect(() => parseMp4Audio(buildSyntheticMp4({ samples: 10, fragmented: true }).bytes)).toThrow("Gefragmenteerde");
    expect(() => parseMp4Audio(src.bytes.subarray(0, src.bytes.length - 40))).toThrow(Mp4Error); // moov afgekapt
    const onlyHead = src.bytes.subarray(0, 400); // mdat afgekapt
    expect(() => parseMp4Audio(onlyHead)).toThrow(Mp4Error);
  });
});

describe("planSplit", () => {
  const src = buildSyntheticMp4({ samples: 1000, sampleSize: () => 100 }); // 100 kB, ~46 s
  const track = parseMp4Audio(src.bytes);

  it("geeft één deel als alles binnen de limieten past", () => {
    expect(planSplit(track, { maxBytes: 1e9, maxSeconds: 1e9 })).toEqual([0, 1000]);
  });

  it("deelt op bytelimiet in ongeveer gelijke delen die elk binnen de limiet blijven", () => {
    const bounds = planSplit(track, { maxBytes: 30_000, maxSeconds: 1e9 });
    expect(bounds.length - 1).toBe(4);
    expect(bounds[0]).toBe(0);
    expect(bounds.at(-1)).toBe(1000);
    for (let i = 0; i + 1 < bounds.length; i++) {
      expect(bounds[i + 1]).toBeGreaterThan(bounds[i]);
      expect((bounds[i + 1] - bounds[i]) * 100).toBeLessThanOrEqual(30_000);
    }
  });

  it("deelt op duurlimiet", () => {
    const bounds = planSplit(track, { maxBytes: 1e9, maxSeconds: 20 }); // 46 s -> 3 delen
    expect(bounds.length - 1).toBe(3);
  });

  it("gooit als een enkel sample al groter is dan de limiet", () => {
    expect(() => planSplit(track, { maxBytes: 50, maxSeconds: 1e9 })).toThrow(Mp4Error);
  });
});

describe("extractPart", () => {
  it("maakt delen die opnieuw parsen, met identieke sampledata, juiste duur en moov vóór mdat", () => {
    const src = buildSyntheticMp4({ samples: 333, sampleSize: (i) => 40 + (i % 13), samplesPerChunk: 5 });
    const track = parseMp4Audio(src.bytes);
    const bounds = planSplit(track, { maxBytes: 4000, maxSeconds: 1e9 });
    expect(bounds.length - 1).toBeGreaterThan(2);

    let total = 0;
    let durations = 0;
    for (let p = 0; p + 1 < bounds.length; p++) {
      const part = extractPart(src.bytes, track, bounds[p], bounds[p + 1]);
      expect(topLevelTypes(part)).toEqual(["ftyp", "moov", "mdat"]);
      const out = parseMp4Audio(part);
      expect(out.sampleSizes.length).toBe(bounds[p + 1] - bounds[p]);
      for (let k = 0; k < out.sampleSizes.length; k++) {
        expect(Array.from(sampleData(part, out, k))).toEqual(Array.from(src.samples[bounds[p] + k]));
      }
      expect(out.mediaTimescale).toBe(22050);
      durations += out.durationSeconds;
      total += out.sampleSizes.length;
    }
    expect(total).toBe(333);
    expect(durations).toBeCloseTo(track.durationSeconds, 6);
  });

  it("werkt ook met één sample en met een deel kleiner dan één chunk", () => {
    const src = buildSyntheticMp4({ samples: 20 });
    const track = parseMp4Audio(src.bytes);
    const one = extractPart(src.bytes, track, 3, 4);
    expect(parseMp4Audio(one).sampleSizes.length).toBe(1);
    expect(() => extractPart(src.bytes, track, 4, 4)).toThrow(Mp4Error);
  });
});

describe("echt bestand (gemaakt met ffmpeg)", () => {
  const bytes = new Uint8Array(readFileSync(new URL("./fixtures/real-20s.m4a", import.meta.url)));

  it("wordt gesplitst in delen met identieke audio", () => {
    const track = parseMp4Audio(bytes);
    expect(track.durationSeconds).toBeGreaterThan(19.9);
    expect(track.durationSeconds).toBeLessThan(20.2);
    const bounds = planSplit(track, { maxBytes: 20_000, maxSeconds: 8 });
    expect(bounds.length - 1).toBeGreaterThanOrEqual(3);
    let count = 0;
    for (let p = 0; p + 1 < bounds.length; p++) {
      const part = extractPart(bytes, track, bounds[p], bounds[p + 1]);
      const out = parseMp4Audio(part);
      for (let k = 0; k < out.sampleSizes.length; k++) {
        expect(Array.from(sampleData(part, out, k))).toEqual(Array.from(sampleData(bytes, track, bounds[p] + k)));
      }
      count += out.sampleSizes.length;
    }
    expect(count).toBe(track.sampleSizes.length);
  });
});
