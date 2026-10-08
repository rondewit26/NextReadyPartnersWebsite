import { describe, expect, it } from "vitest";
import {
  NotionClient,
  finalProperties,
  initialProperties,
  richText,
  splitText,
  summaryBlocks,
  transcriptBlocks,
  transcriptSectionBlocks,
} from "../src/notion";
import type { CallSummary, IngestMeta } from "../src/types";
import { mockFetch } from "./helpers";

const options = { categorie: ["Meeting", "Klanten"], project: ["Acquisitie briefing"] };

const summary: CallSummary = {
  titel: "Peter Kraan | Improvery | Vacaturetool",
  contact: "Peter Kraan, Improvery",
  categorie: "Klanten",
  project: "Acquisitie briefing",
  samenvatting: "Gesprek over de vacaturetool.",
  kernpunten: ["Punt 1", "Punt 2"],
  besluiten_en_afspraken: [],
  actiepunten: [
    { actie: "Offerte sturen", eigenaar: "Ron", deadline: "vrijdag" },
    { actie: "Demo plannen", eigenaar: "", deadline: "" },
  ],
  openstaande_vragen: ["Budget?"],
  vervolg: "Ron belt volgende week terug.",
};

describe("splitText", () => {
  it("laat korte tekst heel", () => {
    expect(splitText("Hallo wereld.")).toEqual(["Hallo wereld."]);
  });

  it("splitst op alinea's en daarna op zinsgrenzen binnen het maximum", () => {
    const sentence = "Dit is een zin die precies lang genoeg is om te testen. ";
    const long = sentence.repeat(60); // ~3400 tekens
    const chunks = splitText(`Eerste alinea.\n\n${long}`, 500);
    expect(chunks[0]).toBe("Eerste alinea.");
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    for (const c of chunks.slice(1)) expect(c.endsWith(".")).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(`Eerste alinea. ${long}`.replace(/\s+/g, " ").trim());
  });

  it("hakt een onsplitsbare zin hard door", () => {
    const chunks = splitText("a".repeat(2500), 1000);
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
  });
});

describe("richText", () => {
  it("knipt op 2000 tekens", () => {
    const rt = richText("x".repeat(4500));
    expect(rt.map((r) => r.text.content.length)).toEqual([2000, 2000, 500]);
  });
  it("is leeg voor lege string", () => {
    expect(richText("")).toEqual([]);
  });
});

describe("properties", () => {
  const meta: IngestMeta = { datum: "2026-10-08T14:03:00+02:00", contact: "Peter" };

  it("initialProperties zet titel, datum, contact en alleen geldige selects", () => {
    const props = initialProperties({ ...meta, categorie: "Bestaat niet" }, options, "08-10-2026 14:03") as any;
    expect(props.Naam.title[0].text.content).toBe("Telefoongesprek met Peter – 08-10-2026 14:03");
    expect(props.Datum.date.start).toBe("2026-10-08T14:03:00+02:00");
    expect(props.Contact.rich_text[0].text.content).toBe("Peter");
    expect(props.Categorie).toEqual({ select: null });
    expect(props.Project).toBeUndefined();
  });

  it("finalProperties laat door de gebruiker ingevulde velden met rust", () => {
    const props = finalProperties({ ...meta, categorie: "Meeting" }, summary, options) as any;
    expect(props.Naam.title[0].text.content).toBe(summary.titel);
    expect(props.Contact).toBeUndefined(); // gebruiker gaf contact op
    expect(props.Categorie).toBeUndefined(); // gebruiker gaf categorie op
    expect(props.Project).toEqual({ select: { name: "Acquisitie briefing" } });
  });

  it("finalProperties negeert een project dat niet bestaat", () => {
    const props = finalProperties({ datum: meta.datum }, { ...summary, project: "Onzin" }, options) as any;
    expect(props.Project).toBeUndefined();
    expect(props.Categorie).toEqual({ select: { name: "Klanten" } });
    expect(props.Contact.rich_text[0].text.content).toBe("Peter Kraan, Improvery");
  });
});

describe("summaryBlocks", () => {
  it("bouwt secties in volgorde, slaat lege secties over en eindigt met de transcript-toggle", () => {
    const blocks = summaryBlocks(summary, { datum: "2026-10-08T14:03:00+02:00", notities: "Mijn notitie" }, "08-10-2026 14:03") as any[];
    const headings = blocks.filter((b) => b.type === "heading_3").map((b) => b.heading_3.rich_text[0].text.content);
    expect(headings).toEqual(["Samenvatting", "Kernpunten", "Actiepunten", "Openstaande vragen", "Vervolg", "Eigen notities"]);
    expect(blocks[0].type).toBe("callout");
    expect(blocks[0].callout.rich_text[0].text.content).toContain("Peter Kraan, Improvery");
    const todos = blocks.filter((b) => b.type === "to_do").map((b) => b.to_do.rich_text[0].text.content);
    expect(todos).toEqual(["Offerte sturen — Ron, vrijdag", "Demo plannen"]);
    expect(blocks.some((b) => b.type === "toggle")).toBe(false);
  });

  it("transcriptSectionBlocks is divider + toggle", () => {
    expect((transcriptSectionBlocks() as any[]).map((b) => b.type)).toEqual(["divider", "toggle"]);
  });

  it("transcriptBlocks geeft paragrafen", () => {
    expect(transcriptBlocks("Zin een. Zin twee.").length).toBe(1);
    expect((transcriptBlocks("")[0] as any).paragraph.rich_text[0].text.content).toContain("leeg");
  });
});

describe("NotionClient", () => {
  it("appendChildren batcht per 100 en geeft alle ids terug", async () => {
    const { fetchImpl, calls } = mockFetch();
    const client = new NotionClient("tok", fetchImpl);
    const ids = await client.appendChildren("blk", Array.from({ length: 250 }, (_, i) => ({ i })));
    expect(ids).toHaveLength(250);
    const appends = calls.filter((c) => c.url.endsWith("/blocks/blk/children"));
    expect(appends.map((c) => c.body.children.length)).toEqual([100, 100, 50]);
    expect(appends[0].headers["Notion-Version"]).toBe("2025-09-03");
    expect(appends[0].body.after).toBeUndefined();
  });

  it("appendChildren met `after` schuift het anker per batch op", async () => {
    const { fetchImpl, calls } = mockFetch();
    const client = new NotionClient("tok", fetchImpl);
    await client.appendChildren("blk", Array.from({ length: 150 }, (_, i) => ({ i })), "anker");
    const appends = calls.filter((c) => c.url.endsWith("/blocks/blk/children"));
    expect(appends[0].body.after).toBe("anker");
    expect(appends[1].body.after).toBe("blk-b100");
  });

  it("gooit een NotionError met status bij een fout", async () => {
    const { fetchImpl } = mockFetch({ fail: /GET .*data_sources/ });
    const client = new NotionClient("tok", fetchImpl);
    await expect(client.getSelectOptions("ds-123")).rejects.toMatchObject({ name: "NotionError", status: 500 });
  });

  it("leest select-opties uit de data source", async () => {
    const { fetchImpl } = mockFetch();
    const client = new NotionClient("tok", fetchImpl);
    const opts = await client.getSelectOptions("ds-123");
    expect(opts.categorie).toContain("Klanten");
    expect(opts.project).toEqual(["Acquisitie briefing"]);
  });
});
