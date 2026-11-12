/**
 * Bouwt kleine, geldige M4A-bestanden voor tests, met bewust verspreide samples (junk tussen de chunks)
 * zodat het kopiëren van niet-aaneensluitende data wordt getest. Geen ffmpeg nodig.
 */
const enc = new TextEncoder();

export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(8 + payload);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(enc.encode(type), 4);
  let pos = 8;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(4 * values.length);
  const v = new DataView(out.buffer);
  values.forEach((x, i) => v.setUint32(4 * i, x >>> 0));
  return out;
}

const zeros = (n: number) => new Uint8Array(n);

export interface SyntheticOptions {
  samples: number;
  sampleSize?: (index: number) => number;
  /** Duur van elk sample in mediatijdeenheden. */
  delta?: number;
  timescale?: number;
  samplesPerChunk?: number;
  handler?: string;
  /** Voeg een moof-box toe (gefragmenteerde MP4). */
  fragmented?: boolean;
}

export interface Synthetic {
  bytes: Uint8Array;
  /** De sampledata zoals die in het bestand staat, in volgorde. */
  samples: Uint8Array[];
}

export function sampleBytes(index: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let j = 0; j < size; j++) out[j] = (index * 31 + j * 7 + 1) & 0xff;
  return out;
}

export function buildSyntheticMp4(opts: SyntheticOptions): Synthetic {
  const n = opts.samples;
  const sizeOf = opts.sampleSize ?? (() => 100);
  const delta = opts.delta ?? 1024;
  const timescale = opts.timescale ?? 22050;
  const perChunk = opts.samplesPerChunk ?? 7;
  const samples = Array.from({ length: n }, (_, i) => sampleBytes(i, sizeOf(i)));

  const ftyp = box("ftyp", enc.encode("M4A "), u32(0), enc.encode("M4A mp42isom"));
  const ftypLength = ftyp.length;

  // mdat: chunks gescheiden door 5 bytes junk.
  const chunkOffsets: number[] = [];
  const mdatParts: Uint8Array[] = [];
  let pos = ftypLength + 8;
  for (let i = 0; i < n; i += perChunk) {
    chunkOffsets.push(pos);
    for (let k = i; k < Math.min(n, i + perChunk); k++) {
      mdatParts.push(samples[k]);
      pos += samples[k].length;
    }
    mdatParts.push(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00]));
    pos += 5;
  }
  const mdat = box("mdat", ...mdatParts);

  const duration = n * delta;
  const movieTs = 1000;
  const movieDuration = Math.round((duration * movieTs) / timescale);
  const mvhd = box("mvhd", u32(0, 0, 0, movieTs, movieDuration, 0x00010000), zeros(2 + 10 + 36 + 24), u32(2));
  const tkhd = box("tkhd", u32(7, 0, 0, 1, 0, movieDuration), zeros(8 + 2 + 2 + 2 + 2 + 36 + 8));
  const mdhd = box("mdhd", u32(0, 0, 0, timescale, duration), zeros(4));
  const hdlr = box("hdlr", u32(0, 0), enc.encode(opts.handler ?? "soun"), zeros(12 + 2));
  const stsd = box("stsd", u32(0, 1), box("mp4a", zeros(6), new Uint8Array([0, 1]), zeros(8), new Uint8Array([0, 1, 0, 16]), zeros(4), u32(timescale << 16)));
  const stts = box("stts", u32(0, 1, n, delta));
  const full = Math.floor(n / perChunk);
  const rest = n % perChunk;
  const stscEntries = [...(full ? [1, perChunk, 1] : []), ...(rest ? [full + 1, rest, 1] : [])];
  const stsc = box("stsc", u32(0, stscEntries.length / 3, ...stscEntries));
  const stsz = box("stsz", u32(0, 0, n, ...samples.map((s) => s.length)));
  const stco = box("stco", u32(0, chunkOffsets.length, ...chunkOffsets));
  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const dinf = box("dinf", box("dref", u32(0, 1), box("url ", u32(1))));
  const minf = box("minf", box("smhd", zeros(8)), dinf, stbl);
  const moov = box("moov", mvhd, box("trak", tkhd, box("mdia", mdhd, hdlr, minf)));

  const tail = opts.fragmented ? [box("moof", zeros(8))] : [];
  const parts = [ftyp, mdat, moov, ...tail];
  const bytes = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, samples };
}
