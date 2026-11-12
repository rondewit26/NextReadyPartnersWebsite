import { describe, expect, it } from "vitest";
import { handleIngest, handleIngestText } from "../src/ingest";
import { canFallBack, completenessWarning, processPendingJobs, shouldProcess } from "../src/process";
import { TranscribeError } from "../src/transcribe";
import type { CallSummary, Job } from "../src/types";
import { MemoryKV, ingestRequest, makeEnv, mockFetch } from "./helpers";
import { buildSyntheticMp4 } from "./mp4-helpers";

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
    expect(form.get("chunking_strategy")).toBeNull(); // chunking auto verloor woorden
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
  it("pakt vastgelopen 'processing'-jobs na 30 minuten opnieuw op, eerder niet", () => {
    const t = new Date("2026-10-08T12:45:00Z");
    expect(shouldProcess({ ...base, startedAt: "2026-10-08T12:25:00Z" }, t)).toBe(false);
    expect(shouldProcess({ ...base, startedAt: "2026-10-08T12:00:00Z" }, t)).toBe(true);
    expect(shouldProcess({ ...base, status: "done" }, t)).toBe(false);
  });
});

describe("transcriptie-vangnet", () => {
  const ok = async () => summary;
  const run = async (env: ReturnType<typeof makeEnv>, kv: MemoryKV, transcribe: any, fetchImpl: typeof fetch) =>
    processPendingJobs(env, { fetchImpl, now, log: () => {}, summarize: ok, transcribe });

  it("probeert whisper-1 zonder chunking als het eerste model met 400 faalt", async () => {
    const kv = new MemoryKV();
    const { fetchImpl } = mockFetch();
    await ingest(kv, fetchImpl);
    const seen: { model: string; chunking?: string }[] = [];
    const transcribe = async (a: any) => {
      seen.push({ model: a.model, chunking: a.chunking });
      if (a.model === "gpt-4o-transcribe") throw new TranscribeError("audio te lang", 400);
      return "Tekst via whisper.";
    };
    const result = await run(makeEnv(kv), kv, transcribe, fetchImpl);
    expect(result.processed).toEqual(["job-1"]);
    expect(seen).toEqual([{ model: "gpt-4o-transcribe", chunking: "off" }, { model: "whisper-1", chunking: "off" }]);
  });

  it("probeert niet opnieuw bij een foute key, bij 429 of als het vangnet uit staat", async () => {
    for (const [status, fallbackSetting] of [[401, undefined], [429, undefined], [400, ""]] as const) {
      const kv = new MemoryKV();
      const { fetchImpl } = mockFetch();
      await ingest(kv, fetchImpl);
      let calls = 0;
      const transcribe = async () => { calls++; throw new TranscribeError("nee", status); };
      const env = { ...makeEnv(kv), ...(fallbackSetting === undefined ? {} : { TRANSCRIBE_FALLBACK_MODEL: fallbackSetting }) };
      const result = await run(env, kv, transcribe, fetchImpl);
      expect(result.failed).toEqual(["job-1"]);
      expect(calls).toBe(1);
    }
  });

  it("canFallBack: alleen bij opname- of modelproblemen en een ander model", () => {
    expect(canFallBack(new TranscribeError("x", 500), "whisper-1", "gpt-4o-transcribe")).toBe(true);
    expect(canFallBack(new TranscribeError("x", 413), "whisper-1", "gpt-4o-transcribe")).toBe(true);
    expect(canFallBack(new TranscribeError("x", 401), "whisper-1", "gpt-4o-transcribe")).toBe(false);
    expect(canFallBack(new TranscribeError("x", 422), "whisper-1", "gpt-4o-transcribe")).toBe(false);
    expect(canFallBack(new TranscribeError("x", 500), "gpt-4o-transcribe", "gpt-4o-transcribe")).toBe(false);
    expect(canFallBack(new Error("x"), "whisper-1", "gpt-4o-transcribe")).toBe(false);
  });
});

describe("lange opnames in meerdere delen", () => {
  const limits = { maxSingleBytes: 150_000, parseThresholdBytes: 10_000, maxPartBytes: 40_000, maxPartSeconds: 1e9 };
  const bytes = buildSyntheticMp4({ samples: 1500, sampleSize: () => 100 }).bytes; // 4 delen

  async function ingestLong(kv: MemoryKV, fetchImpl: typeof fetch) {
    const res = await handleIngest(ingestRequest({ token: "geheim-token", audio: bytes.buffer as ArrayBuffer }), makeEnv(kv), {
      fetchImpl, now, newId: () => "lang", audioLimits: limits,
    });
    expect(res.status).toBe(202);
  }

  it("transcribeert elk deel in volgorde, wist elk deel meteen en zet de delen aan elkaar", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = mockFetch();
    await ingestLong(kv, fetchImpl);
    const seen: { model: string; filename: string; chunking?: string }[] = [];
    const keysDuring: number[] = [];
    const transcribe = async (a: any) => {
      seen.push({ model: a.model, filename: a.filename, chunking: a.chunking });
      keysDuring.push([...kv.store.keys()].filter((k) => k.startsWith("audio:")).length);
      return `Deel ${seen.length}.`;
    };
    const result = await processPendingJobs(makeEnv(kv), { fetchImpl, now, log: () => {}, summarize: async () => summary, transcribe });
    expect(result.processed).toEqual(["lang"]);
    expect(seen.map((s) => s.filename)).toEqual([
      "gesprek-lang-deel1.m4a", "gesprek-lang-deel2.m4a", "gesprek-lang-deel3.m4a", "gesprek-lang-deel4.m4a",
    ]);
    expect(seen.every((s) => s.model === "gpt-4o-transcribe" && s.chunking === "off")).toBe(true);
    expect(keysDuring).toEqual([4, 3, 2, 1]); // elk deel wordt gewist zodra het klaar is
    expect([...kv.store.keys()].some((k) => k.startsWith("audio:"))).toBe(false);

    // Het transcript op de pagina: één alinea per deel, in de juiste volgorde.
    const transcriptCall = calls.find((c) => c.method === "PATCH" && /\/children$/.test(c.url) && c.body.children?.[0]?.type === "paragraph")!;
    expect((transcriptCall.body.children as any[]).map((b) => b.paragraph.rich_text[0].text.content)).toEqual(["Deel 1.", "Deel 2.", "Deel 3.", "Deel 4."]);
    const job = JSON.parse(await kv.get("job:lang")) as Job;
    expect(job.status).toBe("done");
    expect(job.partials).toBeUndefined();
  });

  it("hervat na een fout bij het volgende deel in plaats van opnieuw te beginnen", async () => {
    const kv = new MemoryKV();
    const { fetchImpl } = mockFetch();
    await ingestLong(kv, fetchImpl);
    const env = makeEnv(kv);
    let call = 0;
    const calledFor: string[] = [];
    const transcribe = async (a: any) => {
      calledFor.push(a.filename);
      call++;
      if (call === 2) throw new TranscribeError("sleutel afgewezen", 401);
      return `Tekst ${a.filename}.`;
    };
    const deps = { fetchImpl, now, log: () => {}, summarize: async () => summary, transcribe };

    const first = await processPendingJobs(env, deps);
    expect(first.failed).toEqual(["lang"]);
    let job = JSON.parse(await kv.get("job:lang")) as Job;
    expect(job.status).toBe("failed");
    expect(job.error).toContain("Deel 2 van 4");
    expect(job.partials).toHaveLength(1);
    expect(kv.store.has("audio:lang:0")).toBe(false); // klaar en gewist
    expect(kv.store.has("audio:lang:1")).toBe(true); // nog nodig

    const second = await processPendingJobs(env, deps);
    expect(second.processed).toEqual(["lang"]);
    expect(calledFor).toEqual([
      "gesprek-lang-deel1.m4a", "gesprek-lang-deel2.m4a", // eerste ronde: deel 2 faalt
      "gesprek-lang-deel2.m4a", "gesprek-lang-deel3.m4a", "gesprek-lang-deel4.m4a", // tweede ronde: deel 1 niet opnieuw
    ]);
    job = JSON.parse(await kv.get("job:lang")) as Job;
    expect(job.status).toBe("done");
  });

  it("gebruikt het vangnet-model alleen voor het deel dat faalt", async () => {
    const kv = new MemoryKV();
    const { fetchImpl } = mockFetch();
    await ingestLong(kv, fetchImpl);
    const models: string[] = [];
    const transcribe = async (a: any) => {
      models.push(a.model);
      if (a.model === "gpt-4o-transcribe" && a.filename.endsWith("deel3.m4a")) throw new TranscribeError("te lang", 400);
      return "Tekst.";
    };
    const result = await processPendingJobs(makeEnv(kv), { fetchImpl, now, log: () => {}, summarize: async () => summary, transcribe });
    expect(result.processed).toEqual(["lang"]);
    expect(models).toEqual(["gpt-4o-transcribe", "gpt-4o-transcribe", "gpt-4o-transcribe", "whisper-1", "gpt-4o-transcribe"]);
  });
});

describe("volledigheidscontrole", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `woord${i}`).join(" ");

  it("waarschuwt bij te weinig woorden voor de duur van een deel, met tijdstippen", () => {
    const w = completenessWarning(3, 4, words(640), [986, 986, 986, 986])!;
    expect(w).toContain("Deel 4 van 4 (49:18 tot 1:05:44)");
    expect(w).toContain("640 woorden");
    expect(w).toContain("39 per minuut");
  });

  it("zwijgt bij normaal spraakverloop, bij korte delen en zonder duur", () => {
    expect(completenessWarning(0, 4, words(1800), [986])).toBeNull(); // ~110 per minuut
    expect(completenessWarning(0, 1, words(5), [90])).toBeNull(); // korter dan 2 minuten
    expect(completenessWarning(0, 1, words(5), undefined)).toBeNull();
  });

  it("formuleert het voor een ongedeelde opname", () => {
    expect(completenessWarning(0, 1, words(100), [600])).toContain("De opname (10:00)");
  });
});

describe("waarschuwing op de Notion-pagina", () => {
  const limits = { maxSingleBytes: 150_000, parseThresholdBytes: 10_000, maxPartBytes: 40_000, maxPartSeconds: 1e9 };
  const bytes = buildSyntheticMp4({ samples: 1500, sampleSize: () => 100 }).bytes; // 4 delen van ~11,6 s... te kort

  it("zet een oranje melding bovenaan de samenvatting als een deel te weinig woorden heeft", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = mockFetch();
    await handleIngest(ingestRequest({ token: "geheim-token", audio: bytes.buffer as ArrayBuffer }), makeEnv(kv), {
      fetchImpl, now, newId: () => "w", audioLimits: limits,
    });
    // Maak de delen lang genoeg voor de controle (>= 2 minuten) door de duur in de job te overschrijven.
    const job = JSON.parse(await kv.get("job:w")) as Job;
    job.partSeconds = [600, 600, 600, 600];
    await kv.put("job:w", JSON.stringify(job));
    const transcribe = async (a: any) => (a.filename.endsWith("deel3.m4a") ? "Maar vijf woorden hier." : Array.from({ length: 1000 }, (_, i) => `w${i}`).join(" "));
    await processPendingJobs(makeEnv(kv), { fetchImpl, now, log: () => {}, summarize: async () => summary, transcribe });

    const summaryCall = calls.filter((c) => c.method === "PATCH" && /\/children$/.test(c.url)).find((c) => c.body.after);
    const first = (summaryCall!.body.children as any[])[0];
    expect(first.type).toBe("callout");
    const text = first.callout.rich_text[0].text.content as string;
    expect(text).toContain("Deel 3 van 4");
    expect(text).not.toContain("Deel 1 van 4");
    const done = JSON.parse(await kv.get("job:w")) as Job;
    expect(done.status).toBe("done");
  });
});
