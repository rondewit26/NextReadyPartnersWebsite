/**
 * Minimale MP4/M4A-lezer en -splitser voor het opdelen van lange opnames.
 *
 * Er wordt niets gedecodeerd of geheencodeerd: de gecomprimeerde audiosamples (AAC, ALAC, ...)
 * worden ongewijzigd gekopieerd naar nieuwe, op zichzelf staande MP4-bestanden met een eigen
 * sample-tabel. De audio blijft daardoor bit voor bit gelijk en het kost weinig rekentijd.
 *
 * Ondersteund: één audiotrack in een gewoon (niet-gefragmenteerd) MP4/M4A-bestand, zoals Voice
 * Memos, Notities, Zoom-audio en de audiotrack van Teams-opnames. Niet ondersteund: gefragmenteerde
 * MP4 (moof), bestanden zonder audiotrack en andere containers (mp3, wav, ogg, webm).
 */

export class Mp4Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Mp4Error";
  }
}

interface Box {
  type: string;
  start: number;
  end: number;
  /** Eerste byte na de box-header. */
  payload: number;
}

export interface Mp4Track {
  /** Ruwe boxes uit het bronbestand, hergebruikt in elk deel. */
  ftyp: Uint8Array;
  mvhd: Uint8Array;
  tkhd: Uint8Array;
  mdhd: Uint8Array;
  hdlr: Uint8Array;
  smhd: Uint8Array | null;
  dinf: Uint8Array | null;
  stsd: Uint8Array;
  movieTimescale: number;
  mediaTimescale: number;
  sampleSizes: Uint32Array;
  /** Absolute positie van elk sample in het bronbestand. */
  sampleOffsets: Float64Array;
  /** Duur van elk sample in mediatijdeenheden. */
  sampleDurations: Uint32Array;
  totalUnits: number;
  totalBytes: number;
  durationSeconds: number;
}

export interface SplitLimits {
  /** Maximale sampledata per deel (zonder container-overhead). */
  maxBytes: number;
  maxSeconds: number;
}

const MAX_PARTS = 60;
/** Samples per chunk in de uitvoer; een gebruikelijke, kleine waarde. */
const SAMPLES_PER_CHUNK = 40;

// ---------- Lezen ----------

function readBoxes(buf: Uint8Array, view: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) throw new Mp4Error("Ongeldige MP4: afgekapte box-header");
      size = view.getUint32(pos + 8) * 2 ** 32 + view.getUint32(pos + 12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) {
      throw new Mp4Error(`Ongeldige MP4: box "${type}" loopt buiten het bestand (afgekapte upload?)`);
    }
    out.push({ type, start: pos, end: pos + size, payload: pos + header });
    pos += size;
  }
  return out;
}

const find = (boxes: Box[], type: string): Box | undefined => boxes.find((b) => b.type === type);

function need(box: Box | undefined, name: string): Box {
  if (!box) throw new Mp4Error(`Ongeldige of niet-ondersteunde MP4: box "${name}" ontbreekt`);
  return box;
}

/** Raw kopie van een box; alleen standaard 8-byte headers worden hergebruikt. */
function raw(buf: Uint8Array, box: Box): Uint8Array {
  if (box.payload - box.start !== 8) throw new Mp4Error(`Niet-ondersteunde MP4: box "${box.type}" heeft een grote header`);
  return buf.slice(box.start, box.end);
}

export function looksLikeMp4(buf: Uint8Array): boolean {
  return buf.length > 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70; // "ftyp"
}

/** Leest de eerste audiotrack uit een MP4/M4A-bestand. Gooit een Mp4Error als dat niet kan. */
export function parseMp4Audio(buf: Uint8Array): Mp4Track {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const top = readBoxes(buf, view, 0, buf.length);
  const ftyp = need(find(top, "ftyp"), "ftyp");
  const moov = need(find(top, "moov"), "moov");
  if (top.some((b) => b.type === "moof")) throw new Mp4Error("Gefragmenteerde MP4 wordt niet ondersteund");

  const moovKids = readBoxes(buf, view, moov.payload, moov.end);
  if (find(moovKids, "mvex")) throw new Mp4Error("Gefragmenteerde MP4 wordt niet ondersteund");
  const mvhd = need(find(moovKids, "mvhd"), "mvhd");
  const mvhdVersion = buf[mvhd.payload];
  const movieTimescale = view.getUint32(mvhd.payload + (mvhdVersion === 1 ? 20 : 12));

  for (const trak of moovKids.filter((b) => b.type === "trak")) {
    const kids = readBoxes(buf, view, trak.payload, trak.end);
    const mdia = find(kids, "mdia");
    if (!mdia) continue;
    const mdiaKids = readBoxes(buf, view, mdia.payload, mdia.end);
    const hdlr = find(mdiaKids, "hdlr");
    if (!hdlr) continue;
    const handler = String.fromCharCode(
      buf[hdlr.payload + 8],
      buf[hdlr.payload + 9],
      buf[hdlr.payload + 10],
      buf[hdlr.payload + 11],
    );
    if (handler !== "soun") continue;

    const tkhd = need(find(kids, "tkhd"), "tkhd");
    const mdhd = need(find(mdiaKids, "mdhd"), "mdhd");
    const mdhdVersion = buf[mdhd.payload];
    const mediaTimescale = view.getUint32(mdhd.payload + (mdhdVersion === 1 ? 20 : 12));
    if (!mediaTimescale || !movieTimescale) throw new Mp4Error("Ongeldige MP4: tijdschaal is 0");

    const minf = need(find(mdiaKids, "minf"), "minf");
    const minfKids = readBoxes(buf, view, minf.payload, minf.end);
    const stbl = need(find(minfKids, "stbl"), "stbl");
    const stblKids = readBoxes(buf, view, stbl.payload, stbl.end);
    const stsd = need(find(stblKids, "stsd"), "stsd");
    const stts = need(find(stblKids, "stts"), "stts");
    const stsc = need(find(stblKids, "stsc"), "stsc");
    const stsz = need(find(stblKids, "stsz"), "stsz");
    const stco = find(stblKids, "stco");
    const co64 = find(stblKids, "co64");
    if (!stco && !co64) throw new Mp4Error("Ongeldige MP4: chunk-offsets (stco/co64) ontbreken");

    // Sample-groottes.
    const constantSize = view.getUint32(stsz.payload + 4);
    const sampleCount = view.getUint32(stsz.payload + 8);
    if (sampleCount === 0) throw new Mp4Error("De audiotrack bevat geen samples (gefragmenteerde MP4?)");
    const sizes = new Uint32Array(sampleCount);
    if (constantSize !== 0) sizes.fill(constantSize);
    else {
      if (stsz.payload + 12 + 4 * sampleCount > stsz.end) throw new Mp4Error("Ongeldige MP4: stsz is afgekapt");
      for (let i = 0; i < sampleCount; i++) sizes[i] = view.getUint32(stsz.payload + 12 + 4 * i);
    }

    // Sample-duur (run-length gecodeerd).
    const durations = new Uint32Array(sampleCount);
    const sttsEntries = view.getUint32(stts.payload + 4);
    let si = 0;
    let totalUnits = 0;
    for (let e = 0; e < sttsEntries; e++) {
      const count = view.getUint32(stts.payload + 8 + 8 * e);
      const delta = view.getUint32(stts.payload + 12 + 8 * e);
      for (let k = 0; k < count && si < sampleCount; k++, si++) {
        durations[si] = delta;
        totalUnits += delta;
      }
    }
    if (si !== sampleCount) throw new Mp4Error("Ongeldige MP4: stts en stsz komen niet overeen");

    // Chunk-offsets en sample-to-chunk map.
    const chunkCount = view.getUint32((stco ?? co64)!.payload + 4);
    const chunkOffsets = new Float64Array(chunkCount);
    for (let c = 0; c < chunkCount; c++) {
      chunkOffsets[c] = stco
        ? view.getUint32(stco.payload + 8 + 4 * c)
        : view.getUint32(co64!.payload + 8 + 8 * c) * 2 ** 32 + view.getUint32(co64!.payload + 12 + 8 * c);
    }
    const stscEntries = view.getUint32(stsc.payload + 4);
    const firstChunk: number[] = [];
    const perChunk: number[] = [];
    for (let e = 0; e < stscEntries; e++) {
      firstChunk.push(view.getUint32(stsc.payload + 8 + 12 * e));
      perChunk.push(view.getUint32(stsc.payload + 12 + 12 * e));
    }
    if (!stscEntries) throw new Mp4Error("Ongeldige MP4: stsc is leeg");

    const offsets = new Float64Array(sampleCount);
    let sample = 0;
    let totalBytes = 0;
    let entry = 0;
    for (let c = 0; c < chunkCount && sample < sampleCount; c++) {
      while (entry + 1 < stscEntries && c + 1 >= firstChunk[entry + 1]) entry++;
      let pos = chunkOffsets[c];
      for (let k = 0; k < perChunk[entry] && sample < sampleCount; k++, sample++) {
        offsets[sample] = pos;
        pos += sizes[sample];
        totalBytes += sizes[sample];
      }
    }
    if (sample !== sampleCount) throw new Mp4Error("Ongeldige MP4: te weinig chunks voor alle samples");
    const last = sampleCount - 1;
    if (offsets[last] + sizes[last] > buf.length) throw new Mp4Error("MP4 is afgekapt: sampledata ontbreekt (onvolledige upload?)");

    return {
      ftyp: raw(buf, ftyp),
      mvhd: raw(buf, mvhd),
      tkhd: raw(buf, tkhd),
      mdhd: raw(buf, mdhd),
      hdlr: raw(buf, hdlr),
      smhd: find(minfKids, "smhd") ? raw(buf, find(minfKids, "smhd")!) : null,
      dinf: find(minfKids, "dinf") ? raw(buf, find(minfKids, "dinf")!) : null,
      stsd: raw(buf, stsd),
      movieTimescale,
      mediaTimescale,
      sampleSizes: sizes,
      sampleOffsets: offsets,
      sampleDurations: durations,
      totalUnits,
      totalBytes,
      durationSeconds: totalUnits / mediaTimescale,
    };
  }
  throw new Mp4Error("Geen audiotrack gevonden in dit bestand");
}

// ---------- Plannen ----------

/**
 * Bepaalt de grenzen (sample-indices) van de delen. Delen zijn ongeveer even lang en blijven onder
 * zowel de bytelimiet als de duurlimiet. Geeft `[0, ..., sampleCount]` terug; lengte 2 = één deel.
 */
export function planSplit(track: Mp4Track, limits: SplitLimits): number[] {
  const n = track.sampleSizes.length;
  const cumUnits = new Float64Array(n + 1);
  const cumBytes = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumUnits[i + 1] = cumUnits[i] + track.sampleDurations[i];
    cumBytes[i + 1] = cumBytes[i] + track.sampleSizes[i];
  }
  const lowerBound = (target: number): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cumUnits[mid] >= target) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  let parts = Math.max(1, Math.ceil(cumBytes[n] / limits.maxBytes), Math.ceil(track.durationSeconds / limits.maxSeconds));
  for (; parts <= MAX_PARTS; parts++) {
    if (parts > n) break;
    const bounds = [0];
    for (let k = 1; k < parts; k++) {
      const b = Math.min(Math.max(lowerBound((track.totalUnits * k) / parts), bounds[bounds.length - 1] + 1), n - (parts - k));
      bounds.push(b);
    }
    bounds.push(n);
    const ok = bounds.slice(1).every((end, idx) => {
      const start = bounds[idx];
      return (
        end > start &&
        cumBytes[end] - cumBytes[start] <= limits.maxBytes &&
        (cumUnits[end] - cumUnits[start]) / track.mediaTimescale <= limits.maxSeconds + 0.5
      );
    });
    if (ok) return bounds;
  }
  throw new Mp4Error(`Opname is niet te splitsen binnen ${MAX_PARTS} delen`);
}

// ---------- Schrijven ----------

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(8 + payload);
  const v = new DataView(out.buffer);
  v.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let pos = 8;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function u32a(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(4 * values.length);
  const v = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) v.setUint32(4 * i, values[i] >>> 0);
  return out;
}

function u32s(...values: number[]): Uint8Array {
  return u32a(values);
}

/** Zet de duur in een mvhd/tkhd/mdhd-box (versie 0 of 1). */
function withDuration(rawBox: Uint8Array, kind: "mvhd" | "mdhd" | "tkhd", duration: number): Uint8Array {
  const out = rawBox.slice();
  const v = new DataView(out.buffer);
  const version = out[8];
  const pos = kind === "tkhd" ? (version === 1 ? 36 : 28) : version === 1 ? 32 : 24;
  if (version === 1) {
    v.setUint32(pos, Math.floor(duration / 2 ** 32));
    v.setUint32(pos + 4, duration >>> 0);
  } else {
    v.setUint32(pos, Math.min(duration, 0xffffffff));
  }
  return out;
}

const DEFAULT_SMHD = box("smhd", new Uint8Array(8));
const DEFAULT_DINF = box("dinf", box("dref", u32s(0, 1), box("url ", u32s(1))));

/** Bouwt één standalone MP4 met samples [s0, s1) van de bron. */
export function extractPart(buf: Uint8Array, track: Mp4Track, s0: number, s1: number): Uint8Array {
  const count = s1 - s0;
  if (count <= 0) throw new Mp4Error("Leeg deel");

  // Tabellen die niet van de positie in het uitvoerbestand afhangen.
  let payloadBytes = 0;
  let units = 0;
  const chunkCount = Math.ceil(count / SAMPLES_PER_CHUNK);
  const relOffsets = new Uint32Array(chunkCount);
  for (let i = 0; i < count; i++) {
    if (i % SAMPLES_PER_CHUNK === 0) relOffsets[i / SAMPLES_PER_CHUNK] = payloadBytes;
    payloadBytes += track.sampleSizes[s0 + i];
    units += track.sampleDurations[s0 + i];
  }

  const sttsRuns: number[] = [];
  for (let i = s0; i < s1; ) {
    const d = track.sampleDurations[i];
    let j = i + 1;
    while (j < s1 && track.sampleDurations[j] === d) j++;
    sttsRuns.push(j - i, d);
    i = j;
  }
  const stts = box("stts", u32a([0, sttsRuns.length / 2].concat(sttsRuns)));

  const fullChunks = Math.floor(count / SAMPLES_PER_CHUNK);
  const rest = count % SAMPLES_PER_CHUNK;
  const stscEntries: number[] = [];
  if (fullChunks > 0) stscEntries.push(1, SAMPLES_PER_CHUNK, 1);
  if (rest > 0) stscEntries.push(fullChunks + 1, rest, 1);
  const stsc = box("stsc", u32a([0, stscEntries.length / 3].concat(stscEntries)));

  const sizes = new Uint8Array(12 + 4 * count);
  const sv = new DataView(sizes.buffer);
  sv.setUint32(8, count);
  for (let i = 0; i < count; i++) sv.setUint32(12 + 4 * i, track.sampleSizes[s0 + i]);
  const stsz = box("stsz", sizes);

  const mediaDuration = units;
  const movieDuration = Math.round((units * track.movieTimescale) / track.mediaTimescale);
  const mvhd = withDuration(track.mvhd, "mvhd", movieDuration);
  const tkhd = withDuration(track.tkhd, "tkhd", movieDuration);
  const mdhd = withDuration(track.mdhd, "mdhd", mediaDuration);

  const buildMoov = (mdatPayloadStart: number): Uint8Array => {
    const co = new Uint8Array(8 + 4 * chunkCount);
    const cv = new DataView(co.buffer);
    cv.setUint32(4, chunkCount);
    for (let c = 0; c < chunkCount; c++) cv.setUint32(8 + 4 * c, mdatPayloadStart + relOffsets[c]);
    const stbl = box("stbl", track.stsd, stts, stsc, stsz, box("stco", co));
    const minf = box("minf", track.smhd ?? DEFAULT_SMHD, track.dinf ?? DEFAULT_DINF, stbl);
    return box("moov", mvhd, box("trak", tkhd, box("mdia", mdhd, track.hdlr, minf)));
  };

  // moov staat vóór mdat (geschikt voor streaming-lezers); de grootte hangt niet van de offsets af.
  const moovLength = buildMoov(0).length;
  const mdatPayloadStart = track.ftyp.length + moovLength + 8;
  const moov = buildMoov(mdatPayloadStart);

  const out = new Uint8Array(mdatPayloadStart + payloadBytes);
  out.set(track.ftyp, 0);
  out.set(moov, track.ftyp.length);
  const mdatHeader = new DataView(out.buffer, mdatPayloadStart - 8, 8);
  mdatHeader.setUint32(0, payloadBytes + 8);
  out.set([0x6d, 0x64, 0x61, 0x74], mdatPayloadStart - 4); // "mdat"

  // Kopieer de sampledata; aaneensluitende samples gaan in één keer.
  let pos = mdatPayloadStart;
  for (let i = s0; i < s1; ) {
    const start = track.sampleOffsets[i];
    let end = start + track.sampleSizes[i];
    let j = i + 1;
    while (j < s1 && track.sampleOffsets[j] === end) {
      end += track.sampleSizes[j];
      j++;
    }
    out.set(buf.subarray(start, end), pos);
    pos += end - start;
    i = j;
  }
  return out;
}
