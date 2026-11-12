import { describe, expect, it } from "vitest";
import { extensionFor, handleIngest, handleIngestText, readBody } from "../src/ingest";
import type { Job } from "../src/types";
import { parseMp4Audio } from "../src/mp4";
import { MemoryKV, ingestRequest, makeEnv, mockFetch } from "./helpers";
import { buildSyntheticMp4 } from "./mp4-helpers";

const now = () => new Date("2026-10-08T12:03:00Z");

describe("handleIngest", () => {
  it("weigert zonder geldig token", async () => {
    const kv = new MemoryKV();
    const res = await handleIngest(ingestRequest({ token: "fout" }), makeEnv(kv), { fetchImpl: mockFetch().fetchImpl });
    expect(res.status).toBe(401);
    expect(kv.store.size).toBe(0);
  });

  it("weigert een lege body", async () => {
    const res = await handleIngest(
      ingestRequest({ token: "geheim-token", audio: new ArrayBuffer(0) }),
      makeEnv(new MemoryKV()),
      { fetchImpl: mockFetch().fetchImpl },
    );
    expect(res.status).toBe(400);
  });

  it("weigert uploads boven 80 MB op basis van Content-Length, zonder de body te lezen", async () => {
    const { fetchImpl, calls } = mockFetch();
    const res = await handleIngest(
      ingestRequest({ token: "geheim-token", contentLength: 90 * 1024 * 1024 }),
      makeEnv(new MemoryKV()),
      { fetchImpl },
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.error).toContain("80 MB");
    expect(calls).toHaveLength(0);
  });

  it("neemt een opname van meer dan 30 MB aan (voorheen te groot) zolang hij onder 80 MB blijft", async () => {
    const res = await handleIngest(
      ingestRequest({ token: "geheim-token", contentLength: 31 * 1024 * 1024, audio: new Uint8Array(4096).buffer as ArrayBuffer }),
      makeEnv(new MemoryKV()),
      { fetchImpl: mockFetch().fetchImpl, now },
    );
    expect(res.status).toBe(202);
  });

  it("maakt een placeholderpagina, slaat job + audio op en antwoordt 202", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = mockFetch();
    const res = await handleIngest(
      ingestRequest({
        token: "geheim-token",
        query: { contact: "Peter Kraan, Improvery", categorie: "Klanten", notities: "Belde terug over offerte" },
      }),
      makeEnv(kv),
      { fetchImpl, now, newId: () => "11111111-2222-3333-4444-555555555555" },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.url).toBe("https://www.notion.so/page-1");
    expect(body.warnings).toEqual([]);

    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/pages"))!;
    expect(create.body.parent).toEqual({ type: "data_source_id", data_source_id: "ds-123" });
    expect(create.body.properties.Naam.title[0].text.content).toBe("Telefoongesprek met Peter Kraan, Improvery – 08-10-2026 14:03");
    expect(create.body.properties.Datum.date.start).toBe("2026-10-08T14:03:00+02:00");
    expect(create.body.properties.Categorie).toEqual({ select: { name: "Klanten" } });

    const placeholder = calls.find((c) => c.url.endsWith("/blocks/page-1/children"))!;
    expect(placeholder.body.children[0].type).toBe("callout");

    const job = JSON.parse(await kv.get("job:11111111-2222-3333-4444-555555555555")) as Job;
    expect(job.status).toBe("pending");
    expect(job.pageId).toBe("page-1");
    expect(job.placeholderBlockId).toBe("page-1-b1");
    expect(job.meta.notities).toBe("Belde terug over offerte");
    expect(job.filename).toBe("gesprek-11111111.m4a");
    const audio = await kv.get("audio:11111111-2222-3333-4444-555555555555", "arrayBuffer");
    expect(new TextDecoder().decode(audio)).toBe("fake-audio-bytes");
    // Audio krijgt een harde TTL van een uur; de job zelf mag langer leven.
    expect(kv.ttl.get("audio:11111111-2222-3333-4444-555555555555")).toBe(3600);
    expect(kv.ttl.get("job:11111111-2222-3333-4444-555555555555")).toBe(48 * 3600);
  });

  it("negeert onbekende categorie met waarschuwing, maar zwijgt bij 'Laat Claude kiezen'", async () => {
    const { fetchImpl, calls } = mockFetch();
    const res1 = await handleIngest(
      ingestRequest({ token: "geheim-token", query: { categorie: "Onzin" } }),
      makeEnv(new MemoryKV()),
      { fetchImpl, now },
    );
    expect(((await res1.json()) as any).warnings[0]).toContain("Onzin");
    expect(calls.find((c) => c.method === "POST")!.body.properties.Categorie).toEqual({ select: null });

    const res2 = await handleIngest(
      ingestRequest({ token: "geheim-token", query: { categorie: "Laat Claude kiezen" } }),
      makeEnv(new MemoryKV()),
      { fetchImpl: mockFetch().fetchImpl, now },
    );
    expect(((await res2.json()) as any).warnings).toEqual([]);
  });

  it("geeft 502 als Notion niet bereikbaar is en slaat dan niets op", async () => {
    const kv = new MemoryKV();
    const res = await handleIngest(
      ingestRequest({ token: "geheim-token" }),
      makeEnv(kv),
      { fetchImpl: mockFetch({ fail: /POST .*\/pages$/ }).fetchImpl, now },
    );
    expect(res.status).toBe(502);
    expect(kv.store.size).toBe(0);
  });
});

const splitLimits = { maxSingleBytes: 150_000, parseThresholdBytes: 10_000, maxPartBytes: 40_000, maxPartSeconds: 1e9 };

describe("handleIngest met lange opnames", () => {
  const long = () => buildSyntheticMp4({ samples: 1500, sampleSize: () => 100 }).bytes; // 150 kB -> 4 delen

  it("splitst de opname, bewaart elk deel apart met een korte TTL en noteert het aantal delen in de job", async () => {
    const kv = new MemoryKV();
    const bytes = long();
    const res = await handleIngest(
      ingestRequest({ token: "geheim-token", audio: bytes.buffer as ArrayBuffer }),
      makeEnv(kv),
      { fetchImpl: mockFetch().fetchImpl, now, newId: () => "lang-1", audioLimits: splitLimits },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.delen).toBe(4);
    expect(body.bericht).toContain("4 delen");

    const job = JSON.parse(await kv.get("job:lang-1")) as Job;
    expect(job.parts).toBe(4);
    expect(job.contentType).toBe("audio/mp4");
    expect(job.filename).toBe("gesprek-lang-1.m4a");
    expect(job.audioBytes).toBe(bytes.length);

    let samples = 0;
    for (let i = 0; i < 4; i++) {
      const key = `audio:lang-1:${i}`;
      expect(kv.ttl.get(key)).toBe(3600);
      samples += parseMp4Audio(new Uint8Array(await kv.get(key, "arrayBuffer"))).sampleSizes.length;
    }
    expect(samples).toBe(1500);
    expect(kv.store.has("audio:lang-1")).toBe(false);
  });

  it("ruimt de opgeslagen delen op als Notion niet bereikbaar is", async () => {
    const kv = new MemoryKV();
    const res = await handleIngest(
      ingestRequest({ token: "geheim-token", audio: long().buffer as ArrayBuffer }),
      makeEnv(kv),
      { fetchImpl: mockFetch({ fail: /POST .*\/pages$/ }).fetchImpl, now, newId: () => "lang-2", audioLimits: splitLimits },
    );
    expect(res.status).toBe(502);
    expect(kv.store.size).toBe(0);
  });

  it("weigert een niet-splitsbaar bestand boven de limiet vóór er iets in Notion wordt aangemaakt", async () => {
    const kv = new MemoryKV();
    const { fetchImpl, calls } = mockFetch();
    const res = await handleIngest(
      ingestRequest({ token: "geheim-token", audio: new Uint8Array(200_000).fill(9).buffer as ArrayBuffer }),
      makeEnv(kv),
      { fetchImpl, now, audioLimits: splitLimits },
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error).toContain("alleen m4a/mp4");
    expect(calls).toHaveLength(0);
    expect(kv.store.size).toBe(0);
  });
});

describe("deelduur bij gpt-4o-transcribe", () => {
  // 12 minuten audio van ongeveer 600 kB: boven de parse-drempel van 256 kB, ver onder elke bytelimiet.
  const twelveMinutes = () => buildSyntheticMp4({ samples: 15_504, sampleSize: () => 40 }).bytes;

  it("snijdt een opname van 12 minuten in delen van hooguit 5 minuten, met de duur per deel in de job", async () => {
    const kv = new MemoryKV();
    const res = await handleIngest(
      ingestRequest({ token: "geheim-token", audio: twelveMinutes().buffer as ArrayBuffer }),
      makeEnv(kv),
      { fetchImpl: mockFetch().fetchImpl, now, newId: () => "twaalf" },
    );
    expect(res.status).toBe(202);
    const job = JSON.parse(await kv.get("job:twaalf")) as Job;
    expect(job.parts).toBe(3);
    expect(job.partSeconds).toHaveLength(3);
    expect(job.partSeconds!.every((s) => s <= 300.5)).toBe(true);
    expect(job.partSeconds!.reduce((a, b) => a + b, 0)).toBeCloseTo((15_504 * 1024) / 22050, 2);
  });

  it("laat dezelfde opname heel bij whisper-1 (delen van 20 minuten)", async () => {
    const kv = new MemoryKV();
    const res = await handleIngest(
      ingestRequest({ token: "geheim-token", audio: twelveMinutes().buffer as ArrayBuffer }),
      { ...makeEnv(kv), TRANSCRIBE_MODEL: "whisper-1" },
      { fetchImpl: mockFetch().fetchImpl, now, newId: () => "heel" },
    );
    expect(res.status).toBe(202);
    const job = JSON.parse(await kv.get("job:heel")) as Job;
    expect(job.parts).toBe(1);
    expect(job.partSeconds).toHaveLength(1);
  });
});

describe("extensionFor", () => {
  it("haalt de extensie uit de bestandsnaam of het content-type", () => {
    expect(extensionFor("audio/x-m4a", "Opname 3.M4A")).toBe("m4a");
    expect(extensionFor("audio/mpeg")).toBe("mp3");
    expect(extensionFor("application/octet-stream")).toBe("m4a");
  });
});

describe("handleIngestText", () => {
  const req = (body: unknown, token = "geheim-token") =>
    new Request("https://worker.test/ingest-text", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("maakt een job met transcript aan zonder audio in KV", async () => {
    const kv = new MemoryKV();
    const { fetchImpl } = mockFetch();
    const res = await handleIngestText(req({ transcript: "Hallo Peter.", contact: "Peter", categorie: "Klanten" }), makeEnv(kv), {
      fetchImpl,
      now,
      newId: () => "t-1",
    });
    expect(res.status).toBe(202);
    const job = JSON.parse(await kv.get("job:t-1")) as Job;
    expect(job.transcript).toBe("Hallo Peter.");
    expect(job.audioBytes).toBe(0);
    expect(job.meta.contact).toBe("Peter");
    expect([...kv.store.keys()].some((k) => k.startsWith("audio:"))).toBe(false);
  });

  it("weigert zonder transcript, zonder JSON en zonder token", async () => {
    const env = makeEnv(new MemoryKV());
    const deps = { fetchImpl: mockFetch().fetchImpl, now };
    expect((await handleIngestText(req({ contact: "x" }), env, deps)).status).toBe(400);
    expect((await handleIngestText(req("geen json"), env, deps)).status).toBe(400);
    expect((await handleIngestText(req({ transcript: "x" }, "fout"), env, deps)).status).toBe(401);
  });
});

describe("readBody", () => {
  const streamOf = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((x) => c.enqueue(x));
        c.close();
      },
    });
  const req = (body: BodyInit | null) => new Request("https://x.test/", { method: "POST", body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);

  it("leest een body in stukken in één buffer van de aangekondigde grootte", async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
    const out = await readBody(req(streamOf(chunks)), 6);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("geeft alleen de echt ontvangen bytes terug als de body korter is dan aangekondigd", async () => {
    const out = await readBody(req(streamOf([new Uint8Array([9, 9, 9])])), 10);
    expect(Array.from(out)).toEqual([9, 9, 9]);
  });

  it("weigert een body die groter is dan de Content-Length", async () => {
    await expect(readBody(req(streamOf([new Uint8Array(8)])), 5)).rejects.toThrow("groter dan de Content-Length");
  });

  it("valt zonder bruikbare Content-Length terug op arrayBuffer()", async () => {
    expect(Array.from(await readBody(req(streamOf([new Uint8Array([7, 8])])), 0))).toEqual([7, 8]);
    expect(Array.from(await readBody(req(new Uint8Array([1, 2, 3])), NaN))).toEqual([1, 2, 3]);
  });
});
