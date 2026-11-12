/**
 * Droogloop: laat zien of en hoe een opname door de Worker zou worden gesplitst, zonder iets te
 * uploaden en zonder API-keys:
 *   npx tsx scripts/split-check.ts "/pad/naar/opname.m4a" [uitvoermap]
 *
 * Met een uitvoermap worden de delen daar als m4a-bestanden neergezet, zodat je ze kunt afspelen.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AudioError, DEFAULT_AUDIO_LIMITS, partFilename, planAudio, type AudioPlan } from "../src/audio";
import { parseMp4Audio } from "../src/mp4";
import { MAX_UPLOAD_BYTES } from "../src/types";

const [path, outDir] = process.argv.slice(2);
if (!path) {
  console.error('Gebruik: npx tsx scripts/split-check.ts "/pad/naar/opname.m4a" [uitvoermap]');
  process.exit(1);
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const bytes = new Uint8Array(readFileSync(path));
console.log(`Bestand: ${path.split("/").pop()}, ${mb(bytes.length)}`);
if (bytes.length > MAX_UPLOAD_BYTES) {
  console.log(`Te groot: de Worker accepteert maximaal ${mb(MAX_UPLOAD_BYTES)}. Comprimeer de opname of neem hem in delen op.`);
  process.exit(1);
}

const t0 = performance.now();
let plan: AudioPlan;
try {
  plan = planAudio(bytes);
} catch (err) {
  console.log(`Wordt geweigerd: ${(err as AudioError).message}`);
  process.exit(1);
  throw err; // onbereikbaar; geeft TypeScript zekerheid dat `plan` hierna gevuld is
}

if (plan.mode === "single") {
  console.log(
    `Geen splitsing nodig${plan.durationSeconds ? ` (duur ${clock(plan.durationSeconds)})` : ""}: wordt als één bestand naar OpenAI gestuurd.`,
  );
} else {
  console.log(
    `Wordt gesplitst in ${plan.parts} delen (duur ${clock(plan.durationSeconds)}; per deel maximaal ${mb(DEFAULT_AUDIO_LIMITS.maxPartBytes)} en ${clock(DEFAULT_AUDIO_LIMITS.maxPartSeconds)}).`,
  );
  if (outDir) mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < plan.parts; i++) {
    const part = plan.part(i);
    const info = parseMp4Audio(part);
    const name = partFilename("gesprek.m4a", i, plan.parts);
    if (outDir) writeFileSync(`${outDir}/${name}`, part);
    console.log(`  deel ${i + 1}: ${mb(part.length)}, ${clock(info.durationSeconds)}${outDir ? `  -> ${outDir}/${name}` : ""}`);
  }
  console.log(`Rekentijd op deze computer: ${(performance.now() - t0).toFixed(0)} ms.`);
}
