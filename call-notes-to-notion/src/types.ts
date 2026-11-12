/// <reference types="@cloudflare/workers-types" />

export interface Env {
  JOBS: KVNamespace;
  INGEST_TOKEN: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  NOTION_TOKEN: string;
  NOTION_DATA_SOURCE_ID: string;
  TIMEZONE: string;
  TRANSCRIBE_LANGUAGE: string;
  TRANSCRIBE_MODEL: string;
  /** Optioneel. Standaard leeg: gpt-4o-transcribe kan een prompt als transcript teruggeven. */
  TRANSCRIBE_PROMPT?: string;
  /** Optioneel: "auto" zet chunking_strategy aan. Standaard uit, want dat verloor woorden. */
  TRANSCRIBE_CHUNKING?: string;
  /** Optioneel: model dat wordt geprobeerd als het eerste faalt (bv. te lange opname). Standaard "whisper-1"; leeg = uit. */
  TRANSCRIBE_FALLBACK_MODEL?: string;
  CLAUDE_MODEL: string;
}

export type JobStatus = "pending" | "processing" | "done" | "failed";

/** Metadata die het Shortcut meestuurt (allemaal optioneel behalve datum). */
export interface IngestMeta {
  contact?: string;
  categorie?: string;
  project?: string;
  notities?: string;
  titel?: string;
  /** ISO-8601 met offset, in de geconfigureerde tijdzone. */
  datum: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  error?: string;
  pageId: string;
  pageUrl: string;
  /** Het "⏳ wordt verwerkt"-blok dat na afloop wordt verwijderd. */
  placeholderBlockId: string;
  contentType: string;
  filename: string;
  audioBytes: number;
  /** Aantal delen waarin de opname is opgeslagen (1 = ongesplitst). */
  parts?: number;
  /** Transcripten van de delen die al klaar zijn; een nieuwe poging hervat daarna. */
  partials?: string[];
  /** Transcript zodra bekend. Audio wordt op dat moment direct gewist. */
  transcript?: string;
  /** Of het transcript al op de Notion-pagina staat (transcriptie geslaagd). */
  transcriptSaved?: boolean;
  meta: IngestMeta;
}

export interface Actiepunt {
  actie: string;
  eigenaar: string;
  deadline: string;
}

/** Gestructureerde output van Claude. Lege strings/arrays betekenen "niet van toepassing". */
export interface CallSummary {
  titel: string;
  contact: string;
  categorie: string;
  project: string;
  samenvatting: string;
  kernpunten: string[];
  besluiten_en_afspraken: string[];
  actiepunten: Actiepunt[];
  openstaande_vragen: string[];
  vervolg: string;
}

export const JOB_TTL_SECONDS = 60 * 60 * 48;
/** Audio leeft hooguit zo lang in KV; normaal wordt hij al na enkele minuten (na transcriptie) gewist. */
export const AUDIO_TTL_SECONDS = 60 * 60;
/** Grootste bestand dat als geheel naar OpenAI mag (hun limiet is 25 MB, KV 25 MiB). */
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
/** Grootste upload. De Worker houdt het bestand in het geheugen (128 MB) en maakt er delen van. */
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
/** Onder deze grootte wordt een MP4 niet ingelezen om te splitsen. */
export const PARSE_THRESHOLD_BYTES = 5 * 1024 * 1024;
/** Sampledata per deel; met container-overhead blijft elk deel ruim onder 25 MB. */
export const PART_MAX_BYTES = 18 * 1024 * 1024;
/** Duur per deel. Voorzorg: gpt-4o-transcribe heeft volgens meldingen een duurlimiet van rond de 23 minuten. */
export const PART_MAX_SECONDS = 20 * 60;
export const MAX_ATTEMPTS = 3;
/** Na zoveel minuten "processing" zonder resultaat wordt een job opnieuw opgepakt. */
export const STALE_PROCESSING_MINUTES = 30;
