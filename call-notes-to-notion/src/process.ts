import { NotionClient, block, finalProperties, summaryBlocks, transcriptBlocks, type FetchLike } from "./notion";
import { summarize as defaultSummarize, type Summarizer } from "./summarize";
import { formatNl, minutesBetween } from "./time";
import { transcribe as defaultTranscribe } from "./transcribe";
import { JOB_TTL_SECONDS, MAX_ATTEMPTS, STALE_PROCESSING_MINUTES, type Env, type Job } from "./types";

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
    const audio = await env.JOBS.get(`audio:${job.id}`, "arrayBuffer");
    if (!audio) throw new Error("Audio niet (meer) gevonden in KV; upload de opname opnieuw.");

    const datumLabel = formatNl(new Date(job.meta.datum), env.TIMEZONE);
    const transcript = await transcribe({
      apiKey: env.OPENAI_API_KEY,
      model: env.TRANSCRIBE_MODEL,
      language: env.TRANSCRIBE_LANGUAGE,
      audio,
      filename: job.filename,
      contentType: job.contentType,
      prompt: `Nederlands telefoongesprek van Ron de Wit${job.meta.contact ? ` met ${job.meta.contact}` : ""}.`,
      fetchImpl: deps.fetchImpl,
    });

    const options = await notion.getSelectOptions(env.NOTION_DATA_SOURCE_ID);
    const summary = await summarize({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.CLAUDE_MODEL,
      transcript,
      meta: job.meta,
      options,
      datumLabel,
    });

    const props = finalProperties(job.meta, summary, options);
    if (Object.keys(props).length) await notion.updateProperties(job.pageId, props);

    const ids = await notion.appendChildren(job.pageId, summaryBlocks(summary, job.meta, datumLabel));
    const toggleId = ids[ids.length - 1];
    await notion.appendChildren(toggleId, transcriptBlocks(transcript));

    try {
      await notion.deleteBlock(job.placeholderBlockId);
    } catch {
      // Niet fataal: hooguit blijft het ⏳-blok staan.
    }

    job.status = "done";
    job.finishedAt = new Date().toISOString();
    await saveJob(env, job);
    await env.JOBS.delete(`audio:${job.id}`);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    job.status = "failed";
    job.error = message;
    job.finishedAt = new Date().toISOString();
    await saveJob(env, job);
    try {
      const last = job.attempts >= MAX_ATTEMPTS;
      await notion.appendChildren(job.pageId, [
        block.callout(
          `Verwerken mislukt (poging ${job.attempts}/${MAX_ATTEMPTS})${last ? ", geen nieuwe poging" : ", wordt opnieuw geprobeerd"}: ${message}`,
          "⚠️",
          "red",
        ),
      ]);
    } catch {
      // Als Notion zelf het probleem is, kunnen we daar ook niets loggen.
    }
    throw err;
  }
}
