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
  /** Optioneel: "off" zet chunking_strategy uit. Standaard "auto". */
  TRANSCRIBE_CHUNKING?: string;
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
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
export const MAX_ATTEMPTS = 3;
/** Na zoveel minuten "processing" zonder resultaat wordt een job opnieuw opgepakt. */
export const STALE_PROCESSING_MINUTES = 20;
