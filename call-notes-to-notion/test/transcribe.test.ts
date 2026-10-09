import { describe, expect, it } from "vitest";
import { transcribe } from "../src/transcribe";
import { mockFetch } from "./helpers";

const base = { apiKey: "k", model: "gpt-4o-transcribe", language: "nl", audio: new ArrayBuffer(4), filename: "a.m4a", contentType: "audio/mp4" };
const formOf = (calls: { body: unknown }[]) => calls.find((c) => c.body instanceof FormData)!.body as FormData;

describe("transcribe", () => {
  it("stuurt standaard geen prompt mee (de prompt lekte als transcript) en wel chunking auto", async () => {
    const { fetchImpl, calls } = mockFetch();
    await transcribe({ ...base, fetchImpl });
    const form = formOf(calls);
    expect(form.get("prompt")).toBeNull();
    expect(form.get("chunking_strategy")).toBe("auto");
    expect(form.get("language")).toBe("nl");
  });

  it("laat chunking_strategy weg bij chunking 'off'", async () => {
    const { fetchImpl, calls } = mockFetch();
    await transcribe({ ...base, chunking: "off", fetchImpl });
    expect(formOf(calls).get("chunking_strategy")).toBeNull();
  });

  it("stuurt een prompt alleen mee als die expliciet is opgegeven", async () => {
    const { fetchImpl, calls } = mockFetch();
    await transcribe({ ...base, prompt: "Improvery, Kraan", fetchImpl });
    expect(formOf(calls).get("prompt")).toBe("Improvery, Kraan");
  });

  it("gooit een duidelijke fout bij een leeg transcript", async () => {
    const { fetchImpl } = mockFetch({ transcript: "   " });
    await expect(transcribe({ ...base, fetchImpl })).rejects.toThrow("Transcript is leeg");
  });
});
