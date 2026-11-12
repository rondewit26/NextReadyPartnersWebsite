# call-notes-to-notion

Telefoongesprek op je iPhone opnemen → één tik in het deelmenu → binnen een paar minuten staat er een
volledige meeting note in je Notion-database "NIET VERWIJDEREN! Meeting notes database":
samenvatting, kernpunten, besluiten, actiepunten (als checkboxes), openstaande vragen, vervolg en het
complete transcript. De properties **Naam, Datum, Contact, Categorie en Project** worden gevuld.

```
iPhone                              Cloudflare (gratis tier)                    Externe diensten
──────────────────────────────      ─────────────────────────────────────       ───────────────────────────
Telefoon-app neemt op  ─┐
Notities › Gespreksopnamen │        POST /ingest  ──► Notion-pagina (⏳)  ─────► Notion API (pagina + props)
  › Deel audio ───────────┴─► Shortcut ──► audio + metadata ──► KV (job + audio)
                             ◄── 202 + Notion-link (direct een melding)

                                    cron */2 min ──► job ophalen
                                                 ──► transcriptie ───────────► OpenAI gpt-4o-transcribe (nl)
                                                 ──► samenvatting ───────────► Claude (claude-opus-5-5, structured output)
                                                 ──► pagina vullen, ⏳ weg ──► Notion API
```

Waarom asynchroon: een Shortcut-request loopt na ~60 s op een time-out, terwijl transcriptie plus
samenvatting van een half uur gesprek rustig 1 tot 3 minuten duurt. Het Shortcut krijgt daarom
direct de Notion-link terug; de inhoud volgt vanzelf.

## Alleen tekst wordt bewaard, geen audio

Uitgangspunt: er wordt uitsluitend transcriptie en samenvatting opgeslagen. De audio is alleen
doorvoer.

| Waar | Wat er met de audio gebeurt |
|---|---|
| iPhone | Apple bewaart de opname in Notities › Gespreksopnamen. Dat is Apple's keuze; verwijder hem daar na het delen als je hem niet wilt houden. |
| Cloudflare KV | Alleen tussen upload en transcriptie (normaal 2 tot 4 minuten). Direct na een geslaagde transcriptie wordt hij gewist, en met een harde TTL van 1 uur sowieso, ook als alles misgaat. KV is versleuteld at rest. |
| OpenAI | Verwerkt de audio voor de transcriptie. API-data wordt niet voor training gebruikt; OpenAI houdt API-verkeer tot 30 dagen voor misbruikdetectie, tenzij je account Zero Data Retention heeft. |
| Notion | Alleen transcript en samenvatting. |
| Worker-logs | Nooit audio of transcript; alleen job-ids en foutmeldingen. |

Wil je dat de audio je telefoon helemaal niet verlaat? Gebruik de variant met **on-device
transcriptie** in [docs/SHORTCUT.md](docs/SHORTCUT.md): de Shortcuts-actie "Transcribeer audio" maakt
de tekst op de iPhone en stuurt die naar `POST /ingest-text`. Dan gaat alleen tekst naar Claude en
Notion. Of Apple's on-device model Nederlands aankan, is niet door Apple gedocumenteerd; test het
met één opname. Werkt het niet, dan blijft de OpenAI-route over.

## Mappen

| Pad | Wat |
|---|---|
| `src/index.ts` | Worker-entrypoint: `POST /ingest`, `POST /ingest-text`, `GET /jobs/:id`, `POST /process`, `GET /health`, cron |
| `src/ingest.ts` | Upload (audio of tekst) ontvangen, placeholderpagina maken, job in KV zetten |
| `src/process.ts` | Jobverwerking in twee herstartbare stappen: transcriberen (audio direct wissen) → samenvatten |
| `src/transcribe.ts` | OpenAI-transcriptie (Nederlands, auto-chunking) |
| `src/summarize.ts` | Claude-samenvatting met afgedwongen JSON-schema; prompts komen uit je Notion-templates |
| `src/notion.ts` | Notion REST-client (API-versie 2025-09-03) en blokbouwers |
| `docs/SETUP.md` | Stap-voor-stap installatie (Notion, OpenAI, Anthropic, Cloudflare) |
| `docs/SHORTCUT.md` | Het iPhone-Shortcut, actie voor actie |
| `scripts/smoke.ts` | Test de Notion-koppeling met een voorbeeldtranscript, zonder audio |
| `test/` | Vitest-tests (alles gemockt, geen netwerk nodig) |

## Snel starten

```bash
npm install
npm test                 # 47 tests, geen API-keys nodig
npm run typecheck
```

Daarna [docs/SETUP.md](docs/SETUP.md) volgen en het Shortcut bouwen volgens [docs/SHORTCUT.md](docs/SHORTCUT.md).

## Wat er in Notion komt

Properties (gebruikerswaarden uit het Shortcut winnen altijd van wat Claude afleidt):

| Property | Bron |
|---|---|
| Naam | Claude, formaat `Contact \| Bedrijf \| Onderwerp` (zoals je bestaande notes), of je eigen titel |
| Datum | Moment van upload, in `Europe/Amsterdam` |
| Contact | Wat je in het Shortcut invult, anders wat Claude uit het gesprek haalt |
| Categorie | Je keuze in het Shortcut, anders kiest Claude uit de bestaande select-opties |
| Project | Alleen gezet als het gesprek onmiskenbaar over een bestaand project gaat |

Pagina-inhoud, in de stijl van je templates (blauwe H3-koppen): callout met datum/contact,
Samenvatting, Kernpunten, Besluiten & afspraken, Actiepunten (to-do's met eigenaar en deadline),
Openstaande vragen, Vervolg, je eigen notities, en een inklapbare toggle met het volledige transcript.

De samenvattingsinstructies zijn letterlijk overgenomen uit je templates "Klant meeting" (wie is de
klant, wensen, hoe helpen wij, afspraken) en "Interne meeting" (smalltalk weglaten, besluiten,
actiepunten, deadlines). Categorie *Klanten* activeert het klantprofiel; Meeting/Bedrijf/Project/
Marketing het interne profiel; anders kiest Claude zelf. Aanpassen: `src/summarize.ts`.

## Beperkingen, eerlijk

- **iOS laat geen apps meeluisteren.** Opnemen gaat via Apple's eigen knop in de Telefoon-app (iOS 18.1+). Beide partijen horen een melding. Er is geen automatische trigger "gesprek beëindigd"; het delen vanuit Notities is de ene handmatige tik.
- **Apple's gesprekstranscriptie werkt niet in het Nederlands**, daarom gaat de audio standaard naar OpenAI (zie de tabel hierboven voor wat er precies wordt bewaard). Alternatief zonder audio-upload: de on-device variant in `docs/SHORTCUT.md`.
- **Max. 80 MB per upload.** Lange m4a-opnames worden automatisch gesplitst (zie "Lange gesprekken"). Andere formaten dan m4a/mp4 (mp3, wav) kunnen als geheel tot 24 MB, want OpenAI accepteert maximaal 25 MB per verzoek.
- **Notion's eigen "AI meeting notes"-blok** kan niet via de API worden aangemaakt. De pagina krijgt gewone blokken met dezelfde informatie. Je kunt in Notion wel nog Notion AI over het transcript laten lopen.
- **Cloudflare gratis tier** geeft 10 ms CPU per aanroep. Netwerk-wachttijd telt niet mee, dus dit past normaal. Zie je in `wrangler tail` toch "CPU time limit exceeded", dan is Workers Paid (5 dollar per maand, 30 s CPU) de oplossing.

## Kosten (indicatie, oktober 2026)

| Onderdeel | Per gesprek van 30 min |
|---|---|
| OpenAI gpt-4o-transcribe | ca. $0,18 |
| Claude Opus 5.5 (samenvatting) | ca. $0,05 tot $0,10 |
| Cloudflare Workers + KV | $0 (gratis tier) |

Grofweg een kwartje tot 30 cent per half uur. Goedkoper kan door `CLAUDE_MODEL` op `claude-sonnet-5-5`
te zetten of `TRANSCRIBE_MODEL` op `gpt-4o-mini-transcribe`; beide via `wrangler.toml`.

## Lange gesprekken

OpenAI neemt maximaal 25 MB per transcriptie aan, en gpt-4o-transcribe heeft volgens meldingen ook een
duurlimiet van rond de 23 minuten. Een uur Voice Memos is ongeveer 30 MB. Daarom splitst de Worker een
m4a/mp4-opname automatisch zodra hij te groot of te lang is:

1. Het bestand wordt **niet gedecodeerd of opnieuw gecodeerd**. De gecomprimeerde audiosamples worden
   ongewijzigd in nieuwe, zelfstandige m4a-bestanden gezet, elk hooguit 18 MB en 20 minuten. De audio blijft
   bit voor bit gelijk, dus er gaat geen kwaliteit verloren.
2. Elk deel wordt apart getranscribeerd en daarna direct gewist. De transcripten worden in volgorde aan elkaar gezet.
3. Een deel dat klaar is, wordt bewaard. Faalt een volgend deel, dan hervat een nieuwe poging daar en begint niet opnieuw.
4. Het vangnet met `whisper-1` geldt per deel.

| Opname | Wat er gebeurt |
|---|---|
| m4a/mp4 tot ongeveer 18 MB en 20 minuten | Ongewijzigd, één transcriptie |
| m4a/mp4 tot 80 MB | Gesplitst in delen |
| mp3, wav en andere formaten tot 24 MB | Ongewijzigd, één transcriptie |
| Alles boven 80 MB, of niet-m4a boven 24 MB | Geweigerd met een duidelijke melding, vóór er een Notion-pagina ontstaat |

80 MB is ruim een uur in 130 kbps stereo (bijv. een Voice Memo van 65 minuten is ongeveer 64 MB), of ruim twee uur
in een gewone mono-opname. Zie je eerst wat er met een opname zou gebeuren, zonder iets
te uploaden, met: `npx tsx scripts/split-check.ts "/pad/naar/opname.m4a"`.

**Heel grote bestanden (boven 80 MB).** Een gewone opname in 130 kbps stereo is ongeveer 61 MB per uur, dus een opname van meer dan
anderhalf uur komt boven de limiet, net als alles wat lossless is opgenomen: een uur lossless is ongeveer 300 tot 600 MB. Spraak
heeft die kwaliteit niet nodig. Cloudflare weigert uploads boven 100 MB al voordat de
Worker ze ziet, dus daar kan geen code iets aan doen. Zet zo'n bestand eerst om naar een klein m4a-bestand:

```bash
ffmpeg -i "opname.m4a" -vn -ac 1 -b:a 40k "opname-klein.m4a"
```

Dat geeft ongeveer 18 MB per uur (gemeten: een bron van 562 MB per uur werd 18 MB per uur). Stel Voice Memos zo in dat het
niet meer lossless opneemt: Instellingen, Apps, Voice Memos, Audio Quality op "Compressed".

Aandachtspunten:
- **Rekentijd.** Splitsen kost ongeveer 30 ms voor een bestand van 30 MB en ongeveer 80 ms voor een van 62 MB (gemeten in Node). Het gratis Cloudflare-plan staat
  maar 10 ms rekentijd per verzoek toe. Krijg je bij een grote upload de melding "Worker exceeded CPU time limit", dan is Workers Paid
  (5 dollar per maand, 30 seconden) de oplossing. Kleine opnames raken dit niet.
- **Op de grens tussen twee delen** kan één woord worden afgekapt. Gesneden wordt op een tijdstip en niet op een pauze, omdat dat zonder te decoderen kan.
- **Alleen gewone (niet-gefragmenteerde) m4a/mp4.** Een gefragmenteerd bestand boven 24 MB wordt geweigerd.
- **Geheugen (niet in productie gemeten).** Een Worker heeft 128 MB. De upload wordt in één vooraf toegewezen buffer ingelezen en de delen worden
  met één hergebruikte buffer gebouwd, zodat het in theorie ongeveer het bestand plus 20 MB kost. Dat heb ik lokaal wel gedraaid maar niet tegen de echte
  limiet in productie getest. Krijg je bij een grote upload "Worker exceeded memory limit", zet het bestand dan eerst om naar een kleiner bestand
  (ffmpeg, hierboven), bijvoorbeeld mono op 64 kbps: dat is ongeveer 29 MB per uur.

## Kwaliteit van de transcriptie

Eerste vergelijking op één echte opname van 40 seconden (`scripts/compare-transcribe.ts`):

| Instelling | Resultaat |
|---|---|
| gpt-4o-transcribe met chunking auto | Hakkelig, woorden en namen kwijt of verhaspeld |
| gpt-4o-transcribe met oude prompt | De prompt-tekst komt als transcript terug |
| gpt-4o-transcribe zonder chunking | Vloeiende tekst, juiste namen (huidige instelling) |
| whisper-1 | Vloeiende tekst, juiste namen (vangnet) |

Dat is één opname. Test een gesprek van 10 tot 30 minuten voordat je erop vertrouwt. Faalt het eerste
model, bijvoorbeeld omdat de opname te lang is, dan probeert de Worker automatisch `whisper-1`
(`TRANSCRIBE_FALLBACK_MODEL`, leeg zetten schakelt dit uit).

## Roadmap

- **Sprekerherkenning (gepland, na een paar echte gesprekken).** Variant met OpenAI's `gpt-4o-transcribe-diarize`, zodat het transcript sprekerlabels heeft en actiepunten aan de juiste persoon worden toegewezen. Aandachtspunten uit de OpenAI-documentatie: `chunking_strategy` is verplicht voor opnames langer dan 30 seconden, een `prompt` wordt niet ondersteund, en bekende sprekers kunnen met korte referentiefragmenten worden meegegeven. Beslismoment: de eerste echte gesprekken laten zien hoe vaak de eigenaar van een actiepunt nu verkeerd of leeg is.

## Verplaatsen naar een eigen repository

Deze map is zelfstandig (eigen `package.json`). Maak op GitHub een lege repo `call-notes-to-notion` aan en:

```bash
git subtree split --prefix=call-notes-to-notion -b call-notes-only
git push git@github.com:rondewit26/call-notes-to-notion.git call-notes-only:main
```

## Juridisch

Als deelnemer mag je in Nederland een gesprek opnemen zonder dat vooraf te melden (art. 139a/139b Sr).
Zakelijk netjes en AVG-verstandig blijft: even zeggen dat je opneemt. Apple's eigen melding doet dat al.
Bewaar transcripten niet langer dan nodig en deel ze niet zonder reden.
