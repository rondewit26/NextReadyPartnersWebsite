/**
 * Vergelijkt transcriptie-instellingen op jouw eigen opname, zodat je ziet welke de namen en
 * bedrijfsnamen meeneemt:
 *   OPENAI_API_KEY=sk-... npx tsx scripts/compare-transcribe.ts "/pad/naar/opname.m4a"
 *
 * Kost enkele centen. Audio gaat alleen naar OpenAI en wordt nergens opgeslagen.
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { transcribe } from "../src/transcribe";

const apiKey = process.env.OPENAI_API_KEY;
const path = process.argv[2];
if (!apiKey || !path) {
  console.error('Gebruik: OPENAI_API_KEY=sk-... npx tsx scripts/compare-transcribe.ts "/pad/naar/opname.m4a"');
  process.exit(1);
}

const mime: Record<string, string> = { ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".webm": "audio/webm" };
const buf = readFileSync(path);
const audio = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
const contentType = mime[extname(path).toLowerCase()] ?? "application/octet-stream";
const OLD_PROMPT = "Nederlands telefoongesprek van Ron de Wit met Testpersoon.";

const variants = [
  { label: "A  gpt-4o-transcribe met chunking auto (was de standaard)", model: "gpt-4o-transcribe", chunking: "auto" as const },
  { label: "B  gpt-4o-transcribe, zonder chunking  [huidige instelling]", model: "gpt-4o-transcribe", chunking: "off" as const },
  { label: "C  gpt-4o-transcribe met de oude prompt (laat het lek zien)", model: "gpt-4o-transcribe", chunking: "auto" as const, prompt: OLD_PROMPT },
  { label: "D  whisper-1  [vangnet bij fouten]", model: "whisper-1", chunking: "off" as const },
];

console.log(`Bestand: ${basename(path)} (${(buf.length / 1048576).toFixed(1)} MB)\n`);
for (const v of variants) {
  const t0 = Date.now();
  try {
    const text = await transcribe({
      apiKey, model: v.model, language: "nl", audio, filename: basename(path), contentType, chunking: v.chunking, prompt: v.prompt,
    });
    const words = text.split(/\s+/).filter(Boolean).length;
    const leak = text.includes("Nederlands telefoongesprek van");
    console.log(`=== ${v.label}`);
    console.log(`    ${words} woorden, ${((Date.now() - t0) / 1000).toFixed(1)} s${leak ? ", LET OP: bevat de prompt-tekst" : ""}`);
    console.log(`${text}\n`);
  } catch (err) {
    console.log(`=== ${v.label}\n    FOUT: ${(err as Error).message}\n`);
  }
}
