import type { Env } from "../src/types";

/** Minimale in-memory KV die genoeg van de KVNamespace-API nadoet voor de tests. */
export class MemoryKV {
  store = new Map<string, ArrayBuffer | string>();

  async get(key: string, type?: string): Promise<any> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    if (type === "arrayBuffer") return typeof v === "string" ? new TextEncoder().encode(v).buffer : v;
    return typeof v === "string" ? v : new TextDecoder().decode(v);
  }
  async put(key: string, value: string | ArrayBuffer): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(opts: { prefix?: string; cursor?: string } = {}) {
    const keys = [...this.store.keys()].filter((k) => !opts.prefix || k.startsWith(opts.prefix));
    return { keys: keys.map((name) => ({ name })), list_complete: true, cursor: undefined };
  }
}

export function makeEnv(kv: MemoryKV): Env {
  return {
    JOBS: kv as unknown as KVNamespace,
    INGEST_TOKEN: "geheim-token",
    OPENAI_API_KEY: "sk-test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    NOTION_TOKEN: "ntn_test",
    NOTION_DATA_SOURCE_ID: "ds-123",
    TIMEZONE: "Europe/Amsterdam",
    TRANSCRIBE_LANGUAGE: "nl",
    TRANSCRIBE_MODEL: "gpt-4o-transcribe",
    CLAUDE_MODEL: "claude-opus-5-5",
  };
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

export const DATA_SOURCE = {
  properties: {
    Naam: { type: "title" },
    Categorie: {
      type: "select",
      select: { options: ["Meeting", "Klanten", "Bedrijf", "Project", "Marketing", "Leren", "Prive"].map((name) => ({ name })) },
    },
    Project: { type: "select", select: { options: [{ name: "Acquisitie briefing" }] } },
  },
};

/**
 * Nep-fetch voor Notion + OpenAI. Registreert elke call zodat tests de payloads kunnen controleren.
 * Via `fail` kun je een endpoint laten falen.
 */
export function mockFetch(opts: { transcript?: string; fail?: RegExp } = {}) {
  const calls: RecordedCall[] = [];
  let blockCounter = 0;
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = init.method ?? "GET";
    let body: any = init.body;
    if (typeof body === "string") body = JSON.parse(body);
    calls.push({ method, url, headers: (init.headers as Record<string, string>) ?? {}, body });

    if (opts.fail?.test(`${method} ${url}`)) {
      return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
    }
    if (url.includes("api.openai.com/v1/audio/transcriptions")) {
      return Response.json({ text: opts.transcript ?? "Hallo, dit is een test. Tot ziens." });
    }
    if (url.endsWith("/data_sources/ds-123")) return Response.json(DATA_SOURCE);
    if (method === "POST" && url.endsWith("/pages")) {
      return Response.json({ id: "page-1", url: "https://www.notion.so/page-1" });
    }
    if (method === "PATCH" && /\/blocks\/[^/]+\/children$/.test(url)) {
      const parent = url.match(/\/blocks\/([^/]+)\/children$/)![1];
      const results = (body.children as unknown[]).map(() => ({ id: `${parent}-b${++blockCounter}` }));
      return Response.json({ results });
    }
    if (method === "PATCH" && /\/pages\/[^/]+$/.test(url)) return Response.json({ id: "page-1" });
    if (method === "DELETE" && /\/blocks\/[^/]+$/.test(url)) return Response.json({});
    return new Response(JSON.stringify({ message: `onbekende route ${method} ${url}` }), { status: 404 });
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

export function ingestRequest(args: { token?: string; audio?: ArrayBuffer; query?: Record<string, string>; contentLength?: number } = {}) {
  const q = new URLSearchParams(args.query ?? {}).toString();
  const headers: Record<string, string> = { "Content-Type": "audio/x-m4a" };
  if (args.token !== undefined) headers.Authorization = `Bearer ${args.token}`;
  if (args.contentLength !== undefined) headers["Content-Length"] = String(args.contentLength);
  const audio = args.audio ?? (new TextEncoder().encode("fake-audio-bytes").buffer as ArrayBuffer);
  return new Request(`https://worker.test/ingest${q ? `?${q}` : ""}`, { method: "POST", headers, body: audio });
}
