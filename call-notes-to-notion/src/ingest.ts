import { NotionClient, block, initialProperties, type FetchLike } from "./notion";
import { formatNl, toZonedIso } from "./time";
import { AUDIO_TTL_SECONDS, JOB_TTL_SECONDS, MAX_AUDIO_BYTES, type Env, type IngestMeta, type Job } from "./types";

export interface IngestDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  newId?: () => string;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Accepteert `Authorization: Bearer <token>` of `X-Token: <token>` (Shortcuts-vriendelijk). */
export function isAuthorized(request: Request, env: Env): boolean {
  if (!env.INGEST_TOKEN) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const header = request.headers.get("X-Token")?.trim() ?? "";
  return timingSafeEqual(bearer, env.INGEST_TOKEN) || timingSafeEqual(header, env.INGEST_TOKEN);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clean(value: string | null, max = 500): string | undefined {
  const v = value?.trim();
  return v ? v.slice(0, max) : undefined;
}

export function extensionFor(contentType: string, filename?: string): string {
  const fromName = filename?.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const ct = contentType.toLowerCase();
  if (ct.includes("mp4") || ct.includes("m4a") || ct.includes("aac")) return "m4a";
  if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  if (ct.includes("wav")) return "wav";
  if (ct.includes("webm")) return "webm";
  if (ct.includes("ogg")) return "ogg";
  return "m4a";
}

function metaFromQuery(url: URL, now: Date, timeZone: string): IngestMeta {
  return {
    contact: clean(url.searchParams.get("contact"), 200),
    categorie: clean(url.searchParams.get("categorie"), 100),
    project: clean(url.searchParams.get("project"), 200),
    notities: clean(url.searchParams.get("notities"), 4000),
    titel: clean(url.searchParams.get("titel"), 200),
    datum: toZonedIso(now, timeZone),
  };
}

/** Controleert categorie/project tegen Notion en maakt de placeholderpagina aan. */
async function preparePage(env: Env, meta: IngestMeta, datumLabel: string, fetchImpl?: FetchLike) {
  const notion = new NotionClient(env.NOTION_TOKEN, fetchImpl);
  const warnings: string[] = [];
  const options = await notion.getSelectOptions(env.NOTION_DATA_SOURCE_ID);
  if (meta.categorie && !options.categorie.includes(meta.categorie)) {
    // "Laat Claude kiezen" (of een andere onbekende waarde) betekent: geen categorie opgeven.
    if (!/^laat claude/i.test(meta.categorie)) {
      warnings.push(`Categorie "${meta.categorie}" bestaat niet in Notion; Claude kiest er zelf een.`);
    }
    meta.categorie = undefined;
  }
  if (meta.project && !options.project.includes(meta.project)) {
    warnings.push(`Project "${meta.project}" bestaat niet in Notion; genegeerd.`);
    meta.project = undefined;
  }
  const page = await notion.createPage({
    dataSourceId: env.NOTION_DATA_SOURCE_ID,
    icon: "📞",
    properties: initialProperties(meta, options, datumLabel),
  });
  const [placeholderBlockId] = await notion.appendChildren(page.id, [
    block.callout(
      "Opname ontvangen. Transcriptie en samenvatting volgen binnen enkele minuten; deze melding verdwijnt dan.",
      "⏳",
      "orange",
    ),
  ]);
  return { page, placeholderBlockId, warnings };
}

/**
 * POST /ingest-text  (JSON: { transcript, contact?, categorie?, project?, notities?, titel? })
 *
 * Voor wie de transcriptie al op de telefoon maakt (Shortcuts-actie "Transcribeer audio"):
 * de audio verlaat het toestel dan nooit. Alleen de samenvatting loopt nog via Claude.
 */
export async function handleIngestText(request: Request, env: Env, deps: IngestDeps = {}): Promise<Response> {
  if (!isAuthorized(request, env)) return json({ ok: false, error: "Niet geautoriseerd" }, 401);
  const now = (deps.now ?? (() => new Date()))();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "Body moet JSON zijn" }, 400);
  }
  const str = (k: string, max: number) => (typeof body[k] === "string" ? clean(body[k] as string, max) : undefined);
  const transcript = str("transcript", 400_000);
  if (!transcript) return json({ ok: false, error: "Veld 'transcript' ontbreekt of is leeg" }, 400);

  const meta: IngestMeta = {
    contact: str("contact", 200),
    categorie: str("categorie", 100),
    project: str("project", 200),
    notities: str("notities", 4000),
    titel: str("titel", 200),
    datum: toZonedIso(now, env.TIMEZONE),
  };
  const datumLabel = formatNl(now, env.TIMEZONE);

  let prepared;
  try {
    prepared = await preparePage(env, meta, datumLabel, deps.fetchImpl);
  } catch (err) {
    return json({ ok: false, error: `Notion: ${(err as Error).message}` }, 502);
  }

  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  const job: Job = {
    id,
    status: "pending",
    createdAt: now.toISOString(),
    attempts: 0,
    pageId: prepared.page.id,
    pageUrl: prepared.page.url,
    placeholderBlockId: prepared.placeholderBlockId,
    contentType: "text/plain",
    filename: "transcript.txt",
    audioBytes: 0,
    transcript,
    meta,
  };
  await env.JOBS.put(`job:${id}`, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });

  return json(
    {
      ok: true,
      jobId: id,
      url: prepared.page.url,
      bericht: "Transcript ontvangen. De Notion-pagina staat klaar en wordt binnen enkele minuten samengevat.",
      warnings: prepared.warnings,
    },
    202,
  );
}

/**
 * POST /ingest?contact=..&categorie=..&project=..&notities=..&titel=..&filename=..
 * Body: de ruwe audio (Shortcuts: "Request Body" = File).
 *
 * Maakt direct een Notion-pagina met placeholder aan en zet de audio in KV.
 * De cron-trigger doet daarna het zware werk, zodat het Shortcut nooit op een
 * time-out loopt.
 */
export async function handleIngest(request: Request, env: Env, deps: IngestDeps = {}): Promise<Response> {
  if (!isAuthorized(request, env)) return json({ ok: false, error: "Niet geautoriseerd" }, 401);

  const url = new URL(request.url);
  const now = (deps.now ?? (() => new Date()))();
  const contentType = request.headers.get("Content-Type") || "audio/mp4";
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_AUDIO_BYTES) {
    return json(
      {
        ok: false,
        error: `Audio is ${(declared / 1048576).toFixed(1)} MB; maximum is ${MAX_AUDIO_BYTES / 1048576} MB. Knip de opname of comprimeer hem (Shortcuts: "Codeer media" → alleen audio).`,
      },
      413,
    );
  }

  const audio = await request.arrayBuffer();
  if (audio.byteLength === 0) return json({ ok: false, error: "Geen audio ontvangen (lege body)" }, 400);
  if (audio.byteLength > MAX_AUDIO_BYTES) return json({ ok: false, error: "Audio groter dan 24 MB" }, 413);

  const meta = metaFromQuery(url, now, env.TIMEZONE);
  const filename = clean(url.searchParams.get("filename"), 200);
  const ext = extensionFor(contentType, filename);
  const datumLabel = formatNl(now, env.TIMEZONE);

  let prepared;
  try {
    prepared = await preparePage(env, meta, datumLabel, deps.fetchImpl);
  } catch (err) {
    return json({ ok: false, error: `Notion: ${(err as Error).message}` }, 502);
  }
  const { page, placeholderBlockId, warnings } = prepared;

  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  const job: Job = {
    id,
    status: "pending",
    createdAt: now.toISOString(),
    attempts: 0,
    pageId: page.id,
    pageUrl: page.url,
    placeholderBlockId,
    contentType,
    filename: `gesprek-${id.slice(0, 8)}.${ext}`,
    audioBytes: audio.byteLength,
    meta,
  };

  // Audio is tijdelijk: na transcriptie wordt hij direct gewist, en na een uur sowieso.
  await env.JOBS.put(`audio:${id}`, audio, { expirationTtl: AUDIO_TTL_SECONDS });
  await env.JOBS.put(`job:${id}`, JSON.stringify(job), { expirationTtl: JOB_TTL_SECONDS });

  return json(
    {
      ok: true,
      jobId: id,
      url: page.url,
      bericht: "Opname ontvangen. De Notion-pagina staat klaar en wordt binnen enkele minuten gevuld.",
      warnings,
    },
    202,
  );
}
