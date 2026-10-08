/**
 * Smoke test tegen de echte Notion-database, zonder audio:
 *   NOTION_TOKEN=ntn_... ANTHROPIC_API_KEY=sk-ant-... npm run smoke [pad/naar/transcript.txt]
 *
 * Zonder ANTHROPIC_API_KEY wordt een vaste voorbeeldsamenvatting gebruikt, zodat je
 * alleen de Notion-koppeling test. De aangemaakte pagina heet "SMOKE TEST ..." en
 * kun je daarna gewoon weggooien.
 */
import { readFileSync } from "node:fs";
import { NotionClient, block, finalProperties, initialProperties, summaryBlocks, transcriptBlocks, transcriptSectionBlocks } from "../src/notion";
import { summarize } from "../src/summarize";
import { formatNl, toZonedIso } from "../src/time";
import type { CallSummary, IngestMeta } from "../src/types";

const token = process.env.NOTION_TOKEN;
if (!token) {
  console.error("Zet NOTION_TOKEN (interne Notion-integratie).");
  process.exit(1);
}
const dataSourceId = process.env.NOTION_DATA_SOURCE_ID ?? "19e0e5af-5d48-82ed-a90d-87cdbcef3cde";
const timeZone = process.env.TIMEZONE ?? "Europe/Amsterdam";
const transcript = readFileSync(process.argv[2] ?? "test/fixtures/transcript.txt", "utf8");

const now = new Date();
const datumLabel = formatNl(now, timeZone);
const meta: IngestMeta = {
  datum: toZonedIso(now, timeZone),
  contact: process.env.SMOKE_CONTACT,
  categorie: process.env.SMOKE_CATEGORIE,
  titel: `SMOKE TEST – ${datumLabel}`,
};

const fallback: CallSummary = {
  titel: "SMOKE TEST",
  contact: "Peter Kraan, Improvery",
  categorie: "Klanten",
  project: "LinkedIn interim ITPPM vacature tool",
  samenvatting: "Voorbeeldsamenvatting (geen ANTHROPIC_API_KEY gezet).",
  kernpunten: ["Pilot voor twee vacatures", "AVG: data binnen de EU"],
  besluiten_en_afspraken: ["Ron stuurt vrijdag een offerte voor een pilot van zes weken"],
  actiepunten: [{ actie: "Offerte sturen", eigenaar: "Ron", deadline: "vrijdag" }, { actie: "Demo inplannen", eigenaar: "Peter", deadline: "volgende week" }],
  openstaande_vragen: ["Prijs per plaatsing na de pilot"],
  vervolg: "Demo dinsdag of woensdag volgende week; Peter stuurt de uitnodiging.",
};

async function main() {
  const notion = new NotionClient(token!);
  const options = await notion.getSelectOptions(dataSourceId);
  console.log("Notion-opties:", options);

  const page = await notion.createPage({ dataSourceId, icon: "🧪", properties: initialProperties(meta, options, datumLabel) });
  console.log("Pagina aangemaakt:", page.url);
  const [placeholderId] = await notion.appendChildren(page.id, [block.callout("Smoke test bezig…", "⏳", "orange")]);

  let summary = fallback;
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("Samenvatten met Claude…");
    summary = await summarize({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
      transcript,
      meta,
      options,
      datumLabel,
    });
    console.log(JSON.stringify(summary, null, 2));
  }

  const props = finalProperties(meta, summary, options);
  if (Object.keys(props).length) await notion.updateProperties(page.id, props);
  const ids = await notion.appendChildren(page.id, transcriptSectionBlocks());
  await notion.appendChildren(ids[ids.length - 1], transcriptBlocks(transcript));
  await notion.appendChildren(page.id, summaryBlocks(summary, meta, datumLabel), placeholderId);
  await notion.deleteBlock(placeholderId);
  console.log("Klaar:", page.url);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
