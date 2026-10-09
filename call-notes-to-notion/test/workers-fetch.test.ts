import { afterEach, describe, expect, it, vi } from "vitest";
import { NotionClient } from "../src/notion";
import { transcribe } from "../src/transcribe";

/**
 * Cloudflare Workers gooit "Illegal invocation" als de globale `fetch` wordt aangeroepen met een
 * andere `this` dan de globale omgeving, bijvoorbeeld als `obj.fetchImpl(...)`. Node merkt dat niet,
 * dus de gewone mocks vangen het niet. Deze strikte fetch doet het Workers-gedrag na.
 */
function strictWorkersFetch(calls: string[]) {
  return function (this: unknown, input: RequestInfo | URL): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    calls.push(String(input));
    const url = String(input);
    if (url.includes("openai.com")) return Promise.resolve(Response.json({ text: "Hallo wereld." }));
    return Promise.resolve(Response.json({ properties: {} }));
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("globale fetch in Workers-stijl", () => {
  it("NotionClient werkt met de standaard fetch (geen fetchImpl meegegeven)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", strictWorkersFetch(calls));
    const client = new NotionClient("tok");
    await expect(client.getSelectOptions("ds-1")).resolves.toEqual({ categorie: [], project: [] });
    expect(calls[0]).toContain("/data_sources/ds-1");
  });

  it("transcribe werkt met de standaard fetch", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", strictWorkersFetch(calls));
    const text = await transcribe({
      apiKey: "k", model: "m", language: "nl", audio: new ArrayBuffer(4), filename: "a.m4a", contentType: "audio/mp4",
    });
    expect(text).toBe("Hallo wereld.");
  });

  it("de strikte fetch gooit echt bij een verkeerde this (test van de test)", () => {
    const strict = strictWorkersFetch([]);
    expect(() => ({ f: strict }).f("https://x.test")).toThrow("Illegal invocation");
  });
});
