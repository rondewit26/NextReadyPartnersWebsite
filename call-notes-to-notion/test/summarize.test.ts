import { describe, expect, it } from "vitest";
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

  it("accepteert geldige opties en lege string", () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it("weigert een categorie die niet in Notion bestaat", () => {
    expect(schema.safeParse({ ...valid, categorie: "Onzin" }).success).toBe(false);
  });
});
