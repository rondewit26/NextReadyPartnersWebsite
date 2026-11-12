import { extractPart, looksLikeMp4, parseMp4Audio, planSplit, rangeSeconds, type Mp4Track } from "./mp4";
import { GPT4O_PART_SECONDS, MAX_AUDIO_BYTES, PARSE_THRESHOLD_BYTES, PART_MAX_BYTES, PART_MAX_SECONDS } from "./types";

export class AudioError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AudioError";
  }
}

export interface AudioLimits {
  /** Grootste bestand dat nog als geheel naar OpenAI mag. */
  maxSingleBytes: number;
  /** Onder deze grootte wordt het bestand niet eens ingelezen. */
  parseThresholdBytes: number;
  /** Sampledata per deel. */
  maxPartBytes: number;
  maxPartSeconds: number;
}

export const DEFAULT_AUDIO_LIMITS: AudioLimits = {
  maxSingleBytes: MAX_AUDIO_BYTES,
  parseThresholdBytes: PARSE_THRESHOLD_BYTES,
  maxPartBytes: PART_MAX_BYTES,
  maxPartSeconds: PART_MAX_SECONDS,
};

/** Maximale duur per deel voor het gekozen transcriptiemodel. */
export function partSecondsFor(model: string): number {
  return /^gpt-4o/i.test(model.trim()) ? GPT4O_PART_SECONDS : PART_MAX_SECONDS;
}

export type AudioPlan =
  | { mode: "single"; parts: 1; durationSeconds?: number; partSeconds: number[] }
  | {
      mode: "split";
      parts: number;
      durationSeconds: number;
      /** Duur van elk deel in seconden. */
      partSeconds: number[];
      /**
       * Bouwt deel `index`. Alle delen delen één interne buffer, om geheugen te sparen: het resultaat is
       * alleen geldig tot de volgende aanroep. Sla het dus eerst op (await put) voordat je het volgende vraagt.
       */
      part: (index: number) => Uint8Array;
    };

/** KV-sleutel van een deel. Eén deel behoudt de oorspronkelijke sleutel, zodat oudere jobs blijven werken. */
export function audioKey(id: string, index: number, total: number): string {
  return total <= 1 ? `audio:${id}` : `audio:${id}:${index}`;
}

/** Bestandsnaam van een deel, bijv. `gesprek-ab12cd34-deel2.m4a`. */
export function partFilename(filename: string, index: number, total: number): string {
  if (total <= 1) return filename;
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".m4a";
  return `${base}-deel${index + 1}${ext}`;
}

const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

/**
 * Bepaalt of een opname als geheel kan of in delen moet. Delen zijn zelfstandige M4A-bestanden onder
 * de limiet van OpenAI en KV, met ongewijzigde audio. Kleine bestanden worden niet aangeraakt.
 *
 * Splitsen kan alleen bij MP4/M4A. Andere formaten kunnen als geheel tot `maxSingleBytes`.
 */
export function planAudio(bytes: Uint8Array, overrides: Partial<AudioLimits> = {}): AudioPlan {
  const limits = { ...DEFAULT_AUDIO_LIMITS, ...overrides };
  const tooBigForSingle = bytes.length > limits.maxSingleBytes;
  const single: AudioPlan = { mode: "single", parts: 1, partSeconds: [] };
  const cannotSplit = (reason: string): AudioError =>
    new AudioError(
      `Opname is ${mb(bytes.length)} MB en kan niet automatisch worden gesplitst (${reason}). Het maximum voor dit bestand is ${mb(limits.maxSingleBytes)} MB. Comprimeer de opname of gebruik een m4a-bestand.`,
      tooBigForSingle ? 413 : 415,
    );

  if (!looksLikeMp4(bytes)) {
    if (tooBigForSingle) throw cannotSplit("alleen m4a/mp4 kan worden gesplitst");
    return single;
  }
  if (bytes.length <= limits.parseThresholdBytes) return single;

  let track: Mp4Track;
  let bounds: number[];
  try {
    track = parseMp4Audio(bytes);
    bounds = planSplit(track, { maxBytes: limits.maxPartBytes, maxSeconds: limits.maxPartSeconds });
  } catch (err) {
    // Een bestand dat in zijn geheel past, wordt zoals voorheen ongewijzigd verwerkt.
    if (tooBigForSingle) throw cannotSplit((err as Error).message);
    return single;
  }

  if (bounds.length === 2 && !tooBigForSingle) {
    return { mode: "single", parts: 1, durationSeconds: track.durationSeconds, partSeconds: [track.durationSeconds] };
  }
  let scratch = new Uint8Array(0);
  const alloc = (length: number): Uint8Array => {
    if (scratch.length < length) scratch = new Uint8Array(length);
    return scratch.subarray(0, length);
  };
  return {
    mode: "split",
    parts: bounds.length - 1,
    durationSeconds: track.durationSeconds,
    partSeconds: bounds.slice(1).map((end, i) => rangeSeconds(track, bounds[i], end)),
    part: (index) => extractPart(bytes, track, bounds[index], bounds[index + 1], alloc),
  };
}

/**
 * Plakt de transcripten van de delen aan elkaar. Eindigt een deel midden in een zin, dan loopt de tekst
 * door; anders begint het volgende deel als nieuwe alinea.
 */
export function joinTranscripts(parts: string[]): string {
  let out = "";
  for (const raw of parts) {
    const text = raw.trim();
    if (!text) continue;
    if (!out) out = text;
    else out += (/[.!?…"')\]]$/.test(out) ? "\n\n" : " ") + text;
  }
  return out;
}
