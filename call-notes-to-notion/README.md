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
npm test                 # 44 tests, geen API-keys nodig
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
- **Max. 24 MB per opname** (OpenAI-limiet is 25 MB). Apple's opnames zijn compact; een gesprek van ruim een uur past meestal. Te groot? Het Shortcut kan de audio eerst hercoderen met "Codeer media" (alleen audio).
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
