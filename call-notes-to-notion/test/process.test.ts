import { describe, expect, it } from "vitest";
import { handleIngest } from "../src/ingest";
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
    expect((form.get("file") as File).name).toBe("gesprek-job-1.m4a");
    expect(openai.headers.Authorization).toBe("Bearer sk-test");

    // Claude kreeg transcript, meta en de Notion-opties.
    expect(summarizeArgs.transcript).toBe(transcript);
    expect(summarizeArgs.meta.contact).toBe("Peter");
    expect(summarizeArgs.options.categorie).toContain("Klanten");
    expect(summarizeArgs.model).toBe("claude-opus-5-5");

    const after = calls.slice(before);
    // Properties: titel + categorie + project van Claude, contact blijft van Ron.
    const patchPage = after.find((c) => c.method === "PATCH" && c.url.endsWith("/pages/page-1"))!;
    expect(patchPage.body.properties.Naam.title[0].text.content).toBe(summary.titel);
    expect(patchPage.body.properties.Contact).toBeUndefined();
    expect(patchPage.body.properties.Categorie).toEqual({ select: { name: "Klanten" } });

    // Samenvattingsblokken op de pagina, daarna transcript in de toggle.
    const appends = after.filter((c) => c.method === "PATCH" && /\/children$/.test(c.url));
    expect(appends[0].url).toContain("/blocks/page-1/children");
    const summaryChildren = appends[0].body.children as any[];
    expect(summaryChildren.at(-1).type).toBe("toggle");
    const toggleIdx = summaryChildren.length; // laatste id van die batch
    expect(appends[1].url).toContain(`/blocks/page-1-b${1 + toggleIdx}/children`);
    const paragraphs = appends[1].body.children as any[];
    expect(paragraphs.length).toBeGreaterThan(1);
    expect(paragraphs.every((p) => p.type === "paragraph")).toBe(true);

    // Placeholder weg, job klaar, audio opgeruimd.
    expect(after.some((c) => c.method === "DELETE" && c.url.endsWith("/blocks/page-1-b1"))).toBe(true);
    const job = JSON.parse(await kv.get("job:job-1")) as Job;
    expect(job.status).toBe("done");
    expect(job.attempts).toBe(1);
    expect(await kv.get("audio:job-1")).toBeNull();
  });

  it("markeert een job als failed, logt op de pagina en bewaart de audio voor een nieuwe poging", async () => {
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
    expect(await kv.get("audio:job-1")).not.toBeNull();

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
