import { describe, expect, it } from "vitest";
import { AudioError, audioKey, joinTranscripts, partFilename, partSecondsFor, planAudio } from "../src/audio";
import { parseMp4Audio } from "../src/mp4";
import { buildSyntheticMp4 } from "./mp4-helpers";

// Kleine limieten, zodat gesplitst kan worden met kleine testbestanden.
const small = { maxSingleBytes: 150_000, parseThresholdBytes: 10_000, maxPartBytes: 40_000, maxPartSeconds: 1e9 };

describe("planAudio", () => {
  it("laat kleine bestanden en niet-MP4-bestanden onder de limiet ongemoeid", () => {
    expect(planAudio(new Uint8Array(5000).fill(1), small)).toEqual({ mode: "single", parts: 1, partSeconds: [] });
    const tiny = buildSyntheticMp4({ samples: 50, sampleSize: () => 100 }).bytes; // < parse-drempel
    expect(planAudio(tiny, small).mode).toBe("single");
  });

  it("laat een MP4 binnen alle limieten heel, en meldt de duur", () => {
    const { bytes } = buildSyntheticMp4({ samples: 300, sampleSize: () => 100 }); // 30 kB
    const plan = planAudio(bytes, small);
    expect(plan.mode).toBe("single");
    expect(plan.durationSeconds).toBeCloseTo((300 * 1024) / 22050, 3);
  });

  it("splitst een MP4 boven de deellimiet in delen die elk parsen en samen alle samples bevatten", () => {
    const { bytes, samples } = buildSyntheticMp4({ samples: 1500, sampleSize: () => 100 }); // 150 kB
    const plan = planAudio(bytes, small);
    expect(plan.mode).toBe("split");
    if (plan.mode !== "split") return;
    expect(plan.parts).toBe(4);
    let at = 0;
    for (let i = 0; i < plan.parts; i++) {
      const part = plan.part(i);
      expect(part.length).toBeLessThan(small.maxPartBytes + 5000);
      const t = parseMp4Audio(part);
      for (let k = 0; k < t.sampleSizes.length; k++, at++) {
        expect(Array.from(part.subarray(t.sampleOffsets[k], t.sampleOffsets[k] + t.sampleSizes[k]))).toEqual(Array.from(samples[at]));
      }
    }
    expect(at).toBe(1500);
  });

  it("hergebruikt één buffer voor alle delen (zuinig met geheugen); elk deel is geldig zolang het niet vervangen is", () => {
    const { bytes } = buildSyntheticMp4({ samples: 1500, sampleSize: () => 100 });
    const plan = planAudio(bytes, small);
    if (plan.mode !== "split") throw new Error("verwachtte split");
    const first = plan.part(0);
    const firstCopy = first.slice();
    expect(parseMp4Audio(first).sampleSizes.length).toBeGreaterThan(0);
    const second = plan.part(1);
    expect(second.buffer).toBe(first.buffer); // zelfde onderliggende buffer
    expect(parseMp4Audio(second).sampleSizes.length).toBeGreaterThan(0);
    expect(Array.from(firstCopy).length).toBeGreaterThan(0);
  });

  it("splitst ook op duur, ook als het bestand klein genoeg is", () => {
    const { bytes } = buildSyntheticMp4({ samples: 1000, sampleSize: () => 20 }); // 20 kB, 46 s
    const plan = planAudio(bytes, { ...small, parseThresholdBytes: 0, maxPartSeconds: 20 });
    expect(plan.mode).toBe("split");
    expect(plan.parts).toBe(3);
  });

  it("weigert een niet-splitsbaar bestand boven de limiet, met een duidelijke melding", () => {
    expect.assertions(4);
    try {
      planAudio(new Uint8Array(200_000).fill(7), small);
    } catch (err) {
      expect(err).toBeInstanceOf(AudioError);
      expect((err as AudioError).status).toBe(413);
      expect((err as AudioError).message).toContain("alleen m4a/mp4");
    }
    const frag = buildSyntheticMp4({ samples: 2000, sampleSize: () => 100, fragmented: true }).bytes; // MP4 maar niet splitsbaar
    expect(() => planAudio(frag, small)).toThrow(AudioError);
  });

  it("verwerkt een onleesbare MP4 die wel in zijn geheel past ongewijzigd, zoals voorheen", () => {
    const bad = buildSyntheticMp4({ samples: 300, sampleSize: () => 100, fragmented: true }).bytes;
    expect(planAudio(bad, small).mode).toBe("single");
  });
});

describe("deelduur per model", () => {
  it("gpt-4o-modellen krijgen delen van 5 minuten (uitvoerlimiet van 2.000 tokens), whisper-1 van 20", () => {
    expect(partSecondsFor("gpt-4o-transcribe")).toBe(300);
    expect(partSecondsFor("gpt-4o-mini-transcribe")).toBe(300);
    expect(partSecondsFor(" GPT-4o-Transcribe ")).toBe(300);
    expect(partSecondsFor("whisper-1")).toBe(1200);
  });

  it("planAudio meldt de duur per deel, en die tellen op tot de totale duur", () => {
    const { bytes } = buildSyntheticMp4({ samples: 1000, sampleSize: () => 20 }); // 46 s
    const plan = planAudio(bytes, { ...small, parseThresholdBytes: 0, maxPartSeconds: 20 });
    expect(plan.mode).toBe("split");
    expect(plan.partSeconds).toHaveLength(plan.parts);
    expect(plan.partSeconds.reduce((a, b) => a + b, 0)).toBeCloseTo((1000 * 1024) / 22050, 3);
    expect(plan.partSeconds.every((x) => x <= 20.5)).toBe(true);
  });
});

describe("hulpfuncties", () => {
  it("audioKey houdt de oude sleutel voor één deel", () => {
    expect(audioKey("abc", 0, 1)).toBe("audio:abc");
    expect(audioKey("abc", 2, 4)).toBe("audio:abc:2");
  });

  it("partFilename voegt deelnummers toe voor de extensie", () => {
    expect(partFilename("gesprek-ab12.m4a", 0, 1)).toBe("gesprek-ab12.m4a");
    expect(partFilename("gesprek-ab12.m4a", 1, 3)).toBe("gesprek-ab12-deel2.m4a");
  });

  it("joinTranscripts: nieuwe alinea na een zin, doorlopen midden in een zin, lege delen overslaan", () => {
    expect(joinTranscripts(["Eerste deel.", "Tweede deel."])).toBe("Eerste deel.\n\nTweede deel.");
    expect(joinTranscripts(["We spraken over de", "offerte voor Improvery."])).toBe("We spraken over de offerte voor Improvery.");
    expect(joinTranscripts(["  A. ", "", "B."])).toBe("A.\n\nB.");
    expect(joinTranscripts([])).toBe("");
  });
});
