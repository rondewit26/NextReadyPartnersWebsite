import { describe, expect, it } from "vitest";
import { extensionFor, handleIngest, handleIngestText } from "../src/ingest";
import type { Job } from "../src/types";
import { MemoryKV, ingestRequest, makeEnv, mockFetch } from "./helpers";

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

  it("weigert te grote uploads op basis van Content-Length", async () => {
    const res = await handleIngest(
      ingestRequest({ token: "geheim-token", contentLength: 30 * 1024 * 1024 }),
      makeEnv(new MemoryKV()),
      { fetchImpl: mockFetch().fetchImpl },
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.error).toContain("24 MB");
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
