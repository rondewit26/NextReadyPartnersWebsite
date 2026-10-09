import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { buildSystemPrompt, buildUserPrompt, summarySchema } from "../src/summarize";

const options = { categorie: ["Meeting", "Klanten"], project: ["Acquisitie briefing"] };

describe("summarize prompts", () => {
  it("kiest het klantprofiel voor Klanten en neemt de template-instructies op", () => {
    const prompt = buildUserPrompt({
      transcript: "Hallo",
      meta: { datum: "2026-10-08T14:03:00+02:00", categorie: "Klanten", contact: "Peter" },
      options,
      datumLabel: "08-10-2026 14:03",
    });
    expect(prompt).toContain("Gespreksprofiel: klant");
    expect(prompt).toContain("wat zijn de wensen en vragen");
    expect(prompt).toContain("Contact (opgegeven door Ron): Peter");
    expect(prompt).toContain("<transcript>\nHallo\n</transcript>");
  });

  it("kiest het interne profiel voor Meeting en het algemene profiel zonder categorie", () => {
    const base = { transcript: "x", options, datumLabel: "d" };
    expect(buildUserPrompt({ ...base, meta: { datum: "d", categorie: "Meeting" } })).toContain("Gespreksprofiel: intern");
    expect(buildUserPrompt({ ...base, meta: { datum: "d" } })).toContain("Gespreksprofiel: algemeen");
  });

  it("systeemprompt vraagt om Nederlands en het titelformaat", () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain("Nederlands");
    expect(sys).toContain("Contact | Bedrijf | Onderwerp");
  });

  it("systeemprompt verbiedt verzonnen acties en gokken op eigenaar of datum", () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain("Voeg geen actiepunten, vragen of voorbereidende stappen toe");
    expect(sys).toContain('laat je "eigenaar" leeg');
    expect(sys).toContain("zoals uitgesproken");
  });

  it("zet de weekdag in de gebruikersprompt", () => {
    const prompt = buildUserPrompt({
      transcript: "x", options, datumLabel: "09-10-2026 09:52", weekday: "vrijdag",
      meta: { datum: "2026-10-09T09:52:00+02:00" },
    });
    expect(prompt).toContain("Datum/tijd gesprek: vrijdag 09-10-2026 09:52");
  });
});

describe("summarySchema", () => {
  const schema = summarySchema(options);
  const valid = {
    titel: "t",
    contact: "",
    categorie: "Klanten",
    project: "",
    samenvatting: "s",
    kernpunten: [],
    besluiten_en_afspraken: [],
    actiepunten: [{ actie: "a", eigenaar: "", deadline: "" }],
    openstaande_vragen: [],
    vervolg: "",
  };

  it("kan door de echte SDK-helper tot JSON-schema worden omgezet (regressie: zod v3 vs v4)", () => {
    const format = zodOutputFormat(schema) as any;
    expect(format.type).toBe("json_schema");
    expect(format.schema.type).toBe("object");
    expect(format.schema.additionalProperties).toBe(false);
    expect(Object.keys(format.schema.properties)).toContain("actiepunten");
    // De opties staan in de veldbeschrijving zodat Claude ze kan lezen.
    expect(format.schema.properties.categorie.description).toContain('"Klanten"');
    expect(format.schema.properties.project.description).toContain('"Acquisitie briefing"');
  });

  it("parseert uitvoer en laat een onbekende categorie door; filtering gebeurt in finalProperties", () => {
    const format = zodOutputFormat(schema) as any;
    expect(format.parse(JSON.stringify(valid)).categorie).toBe("Klanten");
    expect(format.parse(JSON.stringify({ ...valid, categorie: "Onzin" })).categorie).toBe("Onzin");
  });

  it("weigert uitvoer waarin een verplicht veld ontbreekt", () => {
    const { vervolg: _omit, ...incomplete } = valid;
    expect(() => (zodOutputFormat(schema) as any).parse(JSON.stringify(incomplete))).toThrow();
  });
});
