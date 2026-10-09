import { describe, expect, it } from "vitest";
import { handleIngest, handleIngestText } from "../src/ingest";
import { processPendingJobs, shouldProcess } from "../src/process";
import type { CallSummary, Job } from "../src/types";
import { MemoryKV, ingestRequest, makeEnv, mockFetch } from "./helpers";

const now = () => new Date("2026-10-08T12:03:00Z");

const summary: CallSummary = {
  titel: "Peter Kraan | Improvery | Vacaturetool",
  contact: "Peter Kraan, Improvery",
  categorie: "Klanten",
  project: "Acquisitie briefing",
  samenvatting: "Korte samenvatting.",
  kernpunten: ["Kernpunt"],
  besluiten_en_afspraken: ["Afspraak"],
  actiepunten: [{ actie: "Offerte", eigenaar: "Ron", deadline: "" }],
  openstaande_vragen: [],
  vervolg: "Volgende week bellen.",
};

async function ingest(kv: MemoryKV, fetchImpl: typeof fetch, query: Record<string, string> = {}) {
  const res = await handleIngest(ingestRequest({ token: "geheim-token", query }), makeEnv(kv), {
    fetchImpl,
    now,
    newId: () => "job-1",
  });
  expect(res.status).toBe(202);
}

describe("processPendingJobs", () => {
  it("transcribeert, vat samen, vult de pagina en ruimt op", async () => {
    const kv = new MemoryKV();
    const transcript = "Dit is zin één. Dit is zin twee. ".repeat(200).trim(); // > 1800 tekens -> meerdere paragrafen
    const { fetchImpl, calls } = mockFetch({ transcript });
    await ingest(kv, fetchImpl, { contact: "Peter" });
    const before = calls.length;

    let summarizeArgs: any;
    const result = await processPendingJobs(makeEnv(kv), {
      fetchImpl,
      now,
      log: () => {},
      summarize: async (args) => {
        summarizeArgs = args;
        return summary;
      },
    });
    expect(result).toEqual({ processed: ["job-1"], failed: [] });

    // Transcriptie: juiste velden in de multipart-body.
    const openai = calls.find((c) => c.url.includes("api.openai.com"))!;
    const form = openai.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("language")).toBe("nl");
    expect(form.get("chunking_strategy")).toBe("auto");
    expect(form.get("prompt")).toBeNull(); // geen prompt: die lekte eerder als transcript
    expect((form.get("file") as File).name).toBe("gesprek-job-1.m4a");
    expect(openai.headers.Authorization).toBe("Bearer sk-test");

    // Claude kreeg transcript, meta en de Notion-opties.
    expect(summarizeArgs.transcript).toBe(transcript);
    expect(summarizeArgs.meta.contact).toBe("Peter");
    expect(summarizeArgs.options.categorie).toContain("Klanten");
    expect(summarizeArgs.model).toBe("claude-opus-5-5");

    const after = calls.slice(before);
    // Volgorde: eerst transcript veiligstellen (divider+toggle, dan paragrafen in de toggle),
    // daarna properties en samenvatting ná de placeholder, dan placeholder weg.
    const appends = after.filter((c) => c.method === "PATCH" && /\/children$/.test(c.url));
    expect(appends[0].url).toContain("/blocks/page-1/children");
    expect((appends[0].body.children as any[]).map((b) => b.type)).toEqual(["divider", "toggle"]);
    expect(appends[1].url).toContain("/blocks/page-1-b3/children"); // b1 = placeholder, b2 = divider, b3 = toggle
    const paragraphs = appends[1].body.children as any[];
    expect(paragraphs.length).toBeGreaterThan(1);
    expect(paragraphs.every((p) => p.type === "paragraph")).toBe(true);

    const patchPage = after.find((c) => c.method === "PATCH" && c.url.endsWith("/pages/page-1"))!;
    expect(patchPage.body.properties.Naam.title[0].text.content).toBe(summary.titel);
    expect(patchPage.body.properties.Contact).toBeUndefined();
    expect(patchPage.body.properties.Categorie).toEqual({ select: { name: "Klanten" } });

    expect(appends[2].url).toContain("/blocks/page-1/children");
    expect(appends[2].body.after).toBe("page-1-b1");
    expect((appends[2].body.children as any[])[0].type).toBe("callout");
    expect((appends[2].body.children as any[]).some((b) => b.type === "toggle")).toBe(false);

    // Placeholder weg, job klaar, audio en transcript uit KV.
    expect(after.some((c) => c.method === "DELETE" && c.url.endsWith("/blocks/page-1-b1"))).toBe(true);
    const job = JSON.parse(await kv.get("job:job-1")) as Job;
    expect(job.status).toBe("done");
    expect(job.attempts).toBe(1);
    expect(job.transcript).toBeUndefined();
    expect(await kv.get("audio:job-1")).toBeNull();
  });

  it("wist de audio direct na transcriptie, ook als de samenvatting daarna mislukt, en hervat vanaf het transcript", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = mockFetch({ transcript: "Transcript tekst." });
    await ingest(kv, fetchImpl);
    const env = makeEnv(kv);

    let calledWith: string | undefined;
    const failing = { fetchImpl, now, log: () => {}, summarize: async (a: any) => { calledWith = a.transcript; throw new Error("Claude down"); } };
    await processPendingJobs(env, failing);

    let job = JSON.parse(await kv.get("job:job-1")) as Job;
    expect(job.status).toBe("failed");
    expect(await kv.get("audio:job-1")).toBeNull(); // audio weg, ondanks mislukte samenvatting
    expect(job.transcript).toBe("Transcript tekst."); // transcript bewaard voor de retry
    expect(job.transcriptSaved).toBe(true);
    expect(calledWith).toBe("Transcript tekst.");

    // Tweede ronde: geen nieuwe transcriptie-call, wel samenvatting.
    const openaiCalls = () => calls.filter((c) => c.url.includes("api.openai.com")).length;
    expect(openaiCalls()).toBe(1);
    await processPendingJobs(env, { fetchImpl, now, log: () => {}, summarize: async () => summary });
    expect(openaiCalls()).toBe(1);
    job = JSON.parse(await kv.get("job:job-1")) as Job;
    expect(job.status).toBe("done");
    // Transcript-sectie is niet nog een keer toegevoegd.
    const sections = calls.filter((c) => /\/blocks\/page-1\/children$/.test(c.url) && c.body.children?.[0]?.type === "divider");
    expect(sections).toHaveLength(1);
  });

  it("verwerkt een tekst-job (geen audio, geen OpenAI-call)", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = mockFetch();
    const res = await handleIngestText(
      new Request("https://worker.test/ingest-text", {
        method: "POST",
        headers: { Authorization: "Bearer geheim-token" },
        body: JSON.stringify({ transcript: "Lokaal transcript." }),
      }),
      makeEnv(kv),
      { fetchImpl, now, newId: () => "t-1" },
    );
    expect(res.status).toBe(202);
    let gotTranscript = "";
    await processPendingJobs(makeEnv(kv), { fetchImpl, now, log: () => {}, summarize: async (a) => { gotTranscript = a.transcript; return summary; } });
    expect(gotTranscript).toBe("Lokaal transcript.");
    expect(calls.some((c) => c.url.includes("api.openai.com"))).toBe(false);
    expect(JSON.parse(await kv.get("job:t-1")).status).toBe("done");
  });

  it("markeert een job als failed en logt op de pagina; audio is na transcriptie al weg", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = mockFetch();
    await ingest(kv, fetchImpl);

    const result = await processPendingJobs(makeEnv(kv), {
      fetchImpl,
      now,
      log: () => {},
      summarize: async () => {
        throw new Error("Claude down");
      },
    });
    expect(result).toEqual({ processed: [], failed: ["job-1"] });

    const job = JSON.parse(await kv.get("job:job-1")) as Job;
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(job.error).toBe("Claude down");
    expect(await kv.get("audio:job-1")).toBeNull();

    const warn = calls.filter((c) => /\/blocks\/page-1\/children$/.test(c.url)).at(-1)!;
    expect(warn.body.children[0].callout.rich_text[0].text.content).toContain("Claude down");
    expect(warn.body.children[0].callout.rich_text[0].text.content).toContain("poging 1/3");

    // Een tweede ronde pakt hem opnieuw op.
    expect(shouldProcess(job, now())).toBe(true);
  });

  it("stopt na het maximale aantal pogingen", async () => {
    const kv = new MemoryKV();
    const { fetchImpl } = mockFetch();
    await ingest(kv, fetchImpl);
    const env = makeEnv(kv);
    const deps = { fetchImpl, now, log: () => {}, summarize: async () => { throw new Error("nee"); } };
    for (let i = 0; i < 3; i++) await processPendingJobs(env, deps);
    const result = await processPendingJobs(env, deps);
    expect(result).toEqual({ processed: [], failed: [] });
    const job = JSON.parse(await kv.get("job:job-1")) as Job;
    expect(job.attempts).toBe(3);
    expect(shouldProcess(job, now())).toBe(false);
  });

  it("slaat een transcriptiefout netjes af met de OpenAI-foutmelding", async () => {
    const kv = new MemoryKV();
    const { fetchImpl } = mockFetch({ fail: /api\.openai\.com/ });
    await ingest(kv, fetchImpl);
    await processPendingJobs(makeEnv(kv), { fetchImpl, now, log: () => {}, summarize: async () => summary });
    const job = JSON.parse(await kv.get("job:job-1")) as Job;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("OpenAI transcriptie mislukt (500)");
    // Transcriptie zelf mislukt: audio blijft voor de retry, maar nooit langer dan de TTL van 1 uur.
    expect(await kv.get("audio:job-1")).not.toBeNull();
    expect(job.transcript).toBeUndefined();
  });
});

describe("shouldProcess", () => {
  const base: Job = {
    id: "x", status: "processing", createdAt: "", attempts: 1, pageId: "p", pageUrl: "", placeholderBlockId: "b",
    contentType: "audio/mp4", filename: "a.m4a", audioBytes: 1, meta: { datum: "" },
  };
  it("pakt vastgelopen 'processing'-jobs na 20 minuten opnieuw op, eerder niet", () => {
    const t = new Date("2026-10-08T12:30:00Z");
    expect(shouldProcess({ ...base, startedAt: "2026-10-08T12:25:00Z" }, t)).toBe(false);
    expect(shouldProcess({ ...base, startedAt: "2026-10-08T12:00:00Z" }, t)).toBe(true);
    expect(shouldProcess({ ...base, status: "done" }, t)).toBe(false);
  });
});
