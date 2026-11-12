import {
  NotionClient,
  block,
  finalProperties,
  summaryBlocks,
  transcriptBlocks,
  transcriptSectionBlocks,
  type FetchLike,
} from "./notion";
import { summarize as defaultSummarize, type Summarizer } from "./summarize";
import { formatNl, minutesBetween, weekdayNl } from "./time";
import { audioKey, joinTranscripts, partFilename } from "./audio";
import { TranscribeError, transcribe as defaultTranscribe } from "./transcribe";
import { JOB_TTL_SECONDS, MAX_ATTEMPTS, MIN_WORDS_PER_MINUTE, STALE_PROCESSING_MINUTES, type Env, type Job } from "./types";

export interface ProcessDeps {
  fetchImpl?: FetchLike;
  summarize?: Summarizer;
  transcribe?: typeof defaultTranscribe;
  now?: () => Date;
  log?: (msg: string) => void;
}

async function listJobKeys(kv: KVNamespace): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "job:", cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

export function shouldProcess(job: Job, now: Date): boolean {
  if (job.status === "pending") return true;
  if (job.status === "failed") return job.attempts < MAX_ATTEMPTS;
  if (job.status === "processing") {
    return !!job.startedAt && minutesBetween(job.startedAt, now) > STALE_PROCESSING_MINUTES && job.attempts < MAX_ATTEMPTS;
  }
  return false;
}

/**
 * Een tweede poging met een ander model heeft alleen zin bij een probleem met de opname of het
 * model zelf (bijv. te lang, niet te verwerken, serverfout), niet bij een foute key, een
 * volle tegoedlimiet of een leeg transcript.
 */
export function canFallBack(err: unknown, fallbackModel: string, primaryModel: string): boolean {
  if (!fallbackModel || fallbackModel === primaryModel) return false;
  if (!(err instanceof TranscribeError)) return false;
  return err.status === 400 || err.status === 413 || err.status >= 500;
}

const clock = (seconds: number): string => {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

/**
 * Waarschuwt als een deel verdacht weinig woorden bevat voor zijn duur. Modellen als gpt-4o-transcribe kunnen
 * een transcript stilzwijgend afkappen; dit vangt dat op. Het kan ook gewoon een stil stuk zijn.
 */
export function completenessWarning(index: number, total: number, text: string, partSeconds?: number[]): string | null {
  const seconds = partSeconds?.[index];
  if (!seconds || seconds < 120) return null;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const perMinute = words / (seconds / 60);
  if (perMinute >= MIN_WORDS_PER_MINUTE) return null;
  const start = (partSeconds ?? []).slice(0, index).reduce((a, b) => a + b, 0);
  const where = total > 1 ? `Deel ${index + 1} van ${total} (${clock(start)} tot ${clock(start + seconds)})` : `De opname (${clock(seconds)})`;
  return `Let op: ${where} bevat maar ${words} woorden voor ${(seconds / 60).toFixed(1)} minuten, ${Math.round(perMinute)} per minuut. Gewone spraak is ongeveer 100 tot 160 per minuut. Het transcript is hier mogelijk onvolledig, of dit stuk bevat vooral stilte.`;
}

async function saveJob(env: Env, job: Job): Promise<void> {
  await env.JOBS.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });
}

/** Verwerkt alle openstaande jobs, één voor één. Wordt door de cron-trigger aangeroepen. */
export async function processPendingJobs(env: Env, deps: ProcessDeps = {}): Promise<{ processed: string[]; failed: string[] }> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((m: string) => console.log(m));
  const result = { processed: [] as string[], failed: [] as string[] };

  for (const key of await listJobKeys(env.JOBS)) {
    const raw = await env.JOBS.get(key);
    if (!raw) continue;
    const job = JSON.parse(raw) as Job;
    if (!shouldProcess(job, now)) continue;
    try {
      await processJob(env, job, deps);
      result.processed.push(job.id);
      log(`job ${job.id}: klaar -> ${job.pageUrl}`);
    } catch (err) {
      result.failed.push(job.id);
      log(`job ${job.id}: mislukt: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * Twee stappen, elk apart herstartbaar:
 *  1. transcriptie: audio uit KV -> transcript op de Notion-pagina -> audio direct wissen
 *  2. samenvatting: transcript -> Claude -> properties + samenvattingsblokken
 * Audio wordt nooit langer bewaard dan tot het einde van stap 1 (en hooguit AUDIO_TTL_SECONDS).
 */
export async function processJob(env: Env, job: Job, deps: ProcessDeps = {}): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const notion = new NotionClient(env.NOTION_TOKEN, deps.fetchImpl);
  const transcribe = deps.transcribe ?? defaultTranscribe;
  const summarize = deps.summarize ?? defaultSummarize;

  job.status = "processing";
  job.startedAt = now.toISOString();
  job.attempts += 1;
  job.error = undefined;
  await saveJob(env, job);

  try {
    const datumLabel = formatNl(new Date(job.meta.datum), env.TIMEZONE);

    // Stap 1: transcriptie, per deel (overgeslagen als het transcript al bekend is). Elk deel dat klaar
    // is wordt bewaard, zodat een nieuwe poging bij het volgende deel verdergaat.
    if (!job.transcript) {
      const total = job.parts ?? 1;
      job.partials ??= [];
      for (let i = job.partials.length; i < total; i++) {
        const key = audioKey(job.id, i, total);
        const label = total > 1 ? `deel ${i + 1} van ${total}` : "";
        const audio = await env.JOBS.get(key, "arrayBuffer");
        if (!audio) {
          throw new Error(`Audio${label ? ` (${label})` : ""} niet (meer) beschikbaar (al gewist of verlopen); upload de opname opnieuw.`);
        }
        const request = {
          apiKey: env.OPENAI_API_KEY,
          language: env.TRANSCRIBE_LANGUAGE,
          audio,
          filename: partFilename(job.filename, i, total),
          contentType: job.contentType,
          prompt: env.TRANSCRIBE_PROMPT?.trim() || undefined,
          fetchImpl: deps.fetchImpl,
        };
        try {
          try {
            job.partials.push(
              await transcribe({ ...request, model: env.TRANSCRIBE_MODEL, chunking: env.TRANSCRIBE_CHUNKING === "auto" ? "auto" : "off" }),
            );
          } catch (err) {
            const fallback = (env.TRANSCRIBE_FALLBACK_MODEL ?? "whisper-1").trim();
            if (!canFallBack(err, fallback, env.TRANSCRIBE_MODEL)) throw err;
            (deps.log ?? console.log)(`job ${job.id}${label ? ` ${label}` : ""}: ${env.TRANSCRIBE_MODEL} faalde (${(err as Error).message}); opnieuw met ${fallback}`);
            job.partials.push(await transcribe({ ...request, model: fallback, chunking: "off" }));
          }
        } catch (err) {
          throw label ? new Error(`${label[0].toUpperCase()}${label.slice(1)}: ${(err as Error).message}`) : err;
        }
        const warning = completenessWarning(i, total, job.partials[i], job.partSeconds);
        if (warning) (job.warnings ??= []).push(warning);
        // Dit deel is getranscribeerd: de audio ervan hoeft nergens meer te bestaan.
        await env.JOBS.delete(key);
        await saveJob(env, job);
      }
      job.transcript = joinTranscripts(job.partials);
      delete job.partials;
      await saveJob(env, job);
    }

    // Transcript meteen veiligstellen op de pagina, los van of de samenvatting lukt.
    if (!job.transcriptSaved) {
      const ids = await notion.appendChildren(job.pageId, transcriptSectionBlocks());
      await notion.appendChildren(ids[ids.length - 1], transcriptBlocks(job.transcript));
      job.transcriptSaved = true;
      await saveJob(env, job);
    }

    // Stap 2: samenvatting.
    const options = await notion.getSelectOptions(env.NOTION_DATA_SOURCE_ID);
    const summary = await summarize({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.CLAUDE_MODEL,
      transcript: job.transcript,
      meta: job.meta,
      options,
      datumLabel,
      weekday: weekdayNl(new Date(job.meta.datum), env.TIMEZONE),
    });

    const props = finalProperties(job.meta, summary, options);
    if (Object.keys(props).length) await notion.updateProperties(job.pageId, props);
    // Samenvatting komt direct na de placeholder, dus vóór het transcript.
    const notice = job.warnings?.length ? [block.callout(job.warnings.join("\n"), "⚠️", "orange")] : [];
    await notion.appendChildren(job.pageId, [...notice, ...summaryBlocks(summary, job.meta, datumLabel)], job.placeholderBlockId);

    try {
      await notion.deleteBlock(job.placeholderBlockId);
    } catch {
      // Niet fataal: hooguit blijft het ⏳-blok staan.
    }

    job.status = "done";
    job.finishedAt = new Date().toISOString();
    delete job.transcript; // staat nu in Notion; niet nodig in KV
    await saveJob(env, job);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    job.status = "failed";
    job.error = message;
    job.finishedAt = new Date().toISOString();
    await saveJob(env, job);
    try {
      const last = job.attempts >= MAX_ATTEMPTS;
      await notion.appendChildren(
        job.pageId,
        [
          block.callout(
            `Verwerken mislukt (poging ${job.attempts}/${MAX_ATTEMPTS})${last ? ", geen nieuwe poging" : ", wordt opnieuw geprobeerd"}: ${message}`,
            "⚠️",
            "red",
          ),
        ],
        job.placeholderBlockId,
      );
    } catch {
      // Als Notion zelf het probleem is, kunnen we daar ook niets loggen.
    }
    throw err;
  }
}
