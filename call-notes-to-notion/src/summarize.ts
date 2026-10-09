import Anthropic from "@anthropic-ai/sdk";
// Vereist zod 4: de SDK-helper bouwt zijn JSON-schema met het v4-formaat. Met zod 3.x crasht
// zodOutputFormat() ("Cannot read properties of undefined (reading 'def')").
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { CallSummary, IngestMeta } from "./types";
import type { SelectOptions } from "./notion";

export class SummarizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummarizeError";
  }
}

export interface SummarizeArgs {
  apiKey: string;
  model: string;
  transcript: string;
  meta: IngestMeta;
  options: SelectOptions;
  datumLabel: string;
}

export type Summarizer = (args: SummarizeArgs) => Promise<CallSummary>;

/**
 * De samenvattingsinstructies zijn overgenomen uit de bestaande Notion-templates
 * ("Klant meeting" en "Interne meeting"), zodat de output dezelfde structuur heeft
 * als de meeting notes die Notion AI zelf zou maken.
 */
const PROFILES: Record<"klant" | "intern" | "algemeen", string> = {
  klant: `Dit is een gesprek met een (potentiële) klant. Structureer de samenvatting aan de hand van:
- wie is deze klant (persoon, rol, bedrijf)
- wat doet hij/zij met het bedrijf
- wat zijn de wensen en vragen
- welke processen kunnen er verbeterd worden
- hoe kunnen wij deze klant helpen
- welke afspraken en beloftes voor een vervolg worden er gemaakt
- overige bespreekpunten
Vat persoonlijke informatie zo kort mogelijk samen: handig om een beeld van de klant te vormen, maar niet gedetailleerd.`,
  intern: `Dit is een intern of zakelijk werkgesprek. Laat persoonlijke gesprekken en informele smalltalk volledig weg (weekenden, vakanties, kinderen, familie, gezondheid, hobby's, privéafspraken). Neem alleen werkrelevante informatie op:
- besproken onderwerpen en updates
- besluiten
- actiepunten
- verantwoordelijkheden
- deadlines
- openstaande vragen
- relevante risico's of knelpunten
Persoonlijke informatie alleen wanneer die nodig is voor een werkafspraak (beschikbaarheid, verlof, planning).`,
  algemeen: `Bepaal zelf of dit een klantgesprek, intern werkgesprek, acquisitiegesprek, leergesprek of privégesprek is en vat samen op de manier die daarbij past. Werkrelevante inhoud krijgt voorrang; smalltalk alleen noemen als het nodig is om een afspraak te begrijpen.`,
};

function profileFor(categorie: string | undefined): keyof typeof PROFILES {
  switch ((categorie ?? "").toLowerCase()) {
    case "klanten":
      return "klant";
    case "meeting":
    case "bedrijf":
    case "project":
    case "marketing":
      return "intern";
    default:
      return "algemeen";
  }
}

export function buildSystemPrompt(): string {
  return `Je bent de persoonlijke gespreksassistent van Ron de Wit (Agilitas BV / Next Ready Partners, interim IT-programma- en projectmanagement). Je krijgt het transcript van een telefoongesprek dat Ron heeft gevoerd en maakt daar een Nederlandstalige meeting note van voor zijn Notion-database.

Regels:
- Schrijf in het Nederlands, zakelijk, concreet en zonder opsmuk. Geen inleidende zinnen als "In dit gesprek...".
- Het transcript is automatisch gegenereerd: namen en bedrijven kunnen verkeerd gespeld zijn. Gebruik de meegegeven contactnaam als die er is; gok anders de meest waarschijnlijke spelling en wees consistent.
- De sprekers zijn niet gelabeld. Leid uit de context af wie Ron is en wie de gesprekspartner is.
- Verzin niets. Als iets niet in het transcript staat, laat het veld leeg (lege string of lege lijst).
- "titel": kort en herkenbaar in het formaat "Contact | Bedrijf | Onderwerp" (laat delen weg die onbekend zijn), max. 80 tekens.
- "contact": naam en bedrijf van de gesprekspartner, bv. "Peter Kraan, Improvery". Leeg als onbekend.
- "categorie" en "project": kies uitsluitend uit de opgegeven opties; kies "" als geen optie duidelijk past. Kies een project alleen als het gesprek er onmiskenbaar over gaat.
- "samenvatting": 1 tot 3 alinea's lopende tekst met de essentie en de context.
- "kernpunten": 3 tot 8 bullets met de belangrijkste inhoud.
- "besluiten_en_afspraken": wat is er concreet afgesproken of besloten.
- "actiepunten": per actie de eigenaar (naam, of "Ron" / naam gesprekspartner) en deadline als genoemd, anders lege string.
- "openstaande_vragen": vragen die nog beantwoord moeten worden.
- "vervolg": het afgesproken vervolg in 1 of 2 zinnen (volgende stap, wie neemt initiatief, wanneer).`;
}

export function buildUserPrompt(args: Omit<SummarizeArgs, "apiKey" | "model">): string {
  const { meta, options, transcript, datumLabel } = args;
  const profile = profileFor(meta.categorie);
  const lines = [
    `Gespreksprofiel: ${profile}`,
    PROFILES[profile],
    "",
    `Datum/tijd gesprek: ${datumLabel}`,
    `Contact (opgegeven door Ron): ${meta.contact?.trim() || "onbekend"}`,
    `Categorie (opgegeven door Ron): ${meta.categorie?.trim() || "niet opgegeven, kies zelf"}`,
    `Project (opgegeven door Ron): ${meta.project?.trim() || "niet opgegeven"}`,
    `Beschikbare categorie-opties: ${options.categorie.join(", ") || "(geen)"}`,
    `Beschikbare project-opties: ${options.project.join(", ") || "(geen)"}`,
  ];
  if (meta.notities?.trim()) lines.push("", "Eigen notities van Ron bij dit gesprek:", meta.notities.trim());
  lines.push("", "<transcript>", transcript, "</transcript>");
  return lines.join("\n");
}

/**
 * Categorie en project zijn bewust gewone strings met een beschrijving, geen enum:
 * de SDK dwingt string-enums niet af, en een afwijkende waarde mag de samenvatting
 * niet laten mislukken. `finalProperties` in notion.ts zet alleen waarden door die
 * echt als select-optie in Notion bestaan.
 */
export function summarySchema(options: SelectOptions) {
  const choose = (opts: string[]) =>
    `Kies exact één van: ${opts.map((o) => `"${o}"`).join(", ") || "(geen opties)"}. Lege string als niets duidelijk past.`;
  return z.object({
    titel: z.string(),
    contact: z.string(),
    categorie: z.string().describe(choose(options.categorie)),
    project: z.string().describe(choose(options.project)),
    samenvatting: z.string(),
    kernpunten: z.array(z.string()),
    besluiten_en_afspraken: z.array(z.string()),
    actiepunten: z.array(z.object({ actie: z.string(), eigenaar: z.string(), deadline: z.string() })),
    openstaande_vragen: z.array(z.string()),
    vervolg: z.string(),
  });
}

/** Samenvatting via Claude met structured outputs (JSON-schema afgedwongen door de API). */
export const summarize: Summarizer = async (args) => {
  const client = new Anthropic({ apiKey: args.apiKey });
  const schema = summarySchema(args.options);

  const response = await client.messages.parse({
    model: args.model,
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(schema) },
    system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildUserPrompt(args) }],
  });

  if (response.stop_reason === "refusal") {
    const details = (response as { stop_details?: { explanation?: string } | null }).stop_details;
    const why = details?.explanation ?? "geen toelichting";
    throw new SummarizeError(`Claude weigerde dit gesprek samen te vatten: ${why}`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new SummarizeError("Claude-antwoord afgekapt (max_tokens); transcript te lang?");
  }
  if (!response.parsed_output) {
    throw new SummarizeError("Claude gaf geen geldige gestructureerde output terug");
  }
  return response.parsed_output;
};
