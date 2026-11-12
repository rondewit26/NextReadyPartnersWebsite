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
  /** Duur van elk deel in seconden, voor de volledigheidscontrole van het transcript. */
  partSeconds?: number[];
  /** Waarschuwingen over de kwaliteit van het transcript; komen als melding op de Notion-pagina. */
  warnings?: string[];
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
/**
 * Grootste upload. De Worker houdt het bestand in het geheugen (128 MB) en maakt er delen van, met
 * één hergebruikte buffer. Cloudflare weigert zelf uploads boven 100 MB. Ruim een uur in 130 kbps stereo.
 */
export const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
/** Onder deze grootte wordt een MP4 niet ingelezen om te splitsen. */
export const PARSE_THRESHOLD_BYTES = 256 * 1024;
/** Sampledata per deel; met container-overhead blijft elk deel ruim onder 25 MB. */
export const PART_MAX_BYTES = 18 * 1024 * 1024;
/** Duur per deel voor modellen zonder korte uitvoerlimiet (whisper-1). */
export const PART_MAX_SECONDS = 20 * 60;
/**
 * Duur per deel voor gpt-4o-transcribe en gpt-4o-mini-transcribe. Die modellen hebben een uitvoerlimiet van
 * 2.000 tokens (ongeveer 9 minuten Nederlandse spraak) en kappen een langer deel stilzwijgend af.
 * 5 minuten laat ruim marge, ook bij snel praten.
 */
export const GPT4O_PART_SECONDS = 5 * 60;
/** Onder dit aantal woorden per minuut (bij een deel van minstens 2 minuten) waarschuwt de Worker. */
export const MIN_WORDS_PER_MINUTE = 50;
export const MAX_ATTEMPTS = 3;
/** Na zoveel minuten "processing" zonder resultaat wordt een job opnieuw opgepakt. */
export const STALE_PROCESSING_MINUTES = 30;
