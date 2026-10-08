# Installatie

Reken op een uur, inclusief het Shortcut. Je hebt nodig: een Notion-account met toegang tot de database,
een OpenAI-account, een Anthropic-account en een (gratis) Cloudflare-account. Node 20+ op je Mac.

## 1. Notion-integratie

1. Ga naar <https://www.notion.so/profile/integrations> → **New integration**.
   Naam: `Call notes`. Type: *Internal*. Workspace: Agilitas BV HomeBASE.
2. Capabilities: *Read content*, *Update content*, *Insert content*. User information: *No user information*.
3. Kopieer het **Internal Integration Secret** (begint met `ntn_`). Dit wordt `NOTION_TOKEN`.
4. Koppel de integratie aan de database: open in Notion de pagina **Notion AI meeting notes (TEMPLATE)**
   → menu `···` rechtsboven → **Connections** → **Connect to** → `Call notes`.
   De database "NIET VERWIJDEREN! Meeting notes database" staat op die pagina en erft de koppeling.
5. Het data source-id staat al in `wrangler.toml` (`19e0e5af-5d48-82ed-a90d-87cdbcef3cde`). Gebruik je een
   andere database, haal het id dan op met:
   ```bash
   curl -s https://api.notion.com/v1/databases/<database-id> \
     -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2025-09-03" | jq '.data_sources'
   ```

## 2. API-keys

- **OpenAI**: <https://platform.openai.com/api-keys> → nieuwe key, alleen `audio` nodig. Zet een maandlimiet op het project (bijv. $20).
- **Anthropic**: <https://console.anthropic.com/settings/keys> → nieuwe key. Zet ook hier een spend limit.

## 3. Lokaal controleren

```bash
cd call-notes-to-notion
npm install
npm test
```

Test daarna de Notion-koppeling met een echte pagina (verwijder hem daarna gerust):

```bash
NOTION_TOKEN=ntn_... npm run smoke                       # alleen Notion, vaste voorbeeldsamenvatting
NOTION_TOKEN=ntn_... ANTHROPIC_API_KEY=sk-ant-... npm run smoke   # met echte Claude-samenvatting
```

Je krijgt een Notion-URL terug. Controleer of de properties en de blokken er goed uitzien.

## 4. Cloudflare

```bash
npx wrangler login
npx wrangler kv namespace create JOBS
```

Plak het teruggegeven `id` in `wrangler.toml` bij `[[kv_namespaces]]`. Zet dan de secrets:

```bash
openssl rand -base64 32              # kies/plak dit als INGEST_TOKEN
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put NOTION_TOKEN
npx wrangler deploy
```

De deploy print een URL als `https://call-notes-to-notion.<account>.workers.dev`. Test:

```bash
curl https://call-notes-to-notion.<account>.workers.dev/health

curl -X POST "https://call-notes-to-notion.<account>.workers.dev/ingest?contact=Testpersoon&categorie=Meeting" \
  -H "Authorization: Bearer <INGEST_TOKEN>" \
  -H "Content-Type: audio/x-m4a" \
  --data-binary @een-korte-opname.m4a
```

Je krijgt `202` met een `url`. Binnen 2 tot 4 minuten (cron) is de pagina gevuld. Wil je niet wachten:

```bash
curl -X POST https://call-notes-to-notion.<account>.workers.dev/process -H "Authorization: Bearer <INGEST_TOKEN>"
```

Logs live meekijken: `npx wrangler tail`.

## 5. Shortcut

Zie [SHORTCUT.md](SHORTCUT.md).

## Lokaal draaien (optioneel)

```bash
cp .dev.vars.example .dev.vars   # vul de vier secrets in
npm run dev                       # http://localhost:8787
curl -X POST "http://localhost:8787/__scheduled?cron=*/2+*+*+*+*"   # cron handmatig aftrappen
```

## Problemen

| Symptoom | Oorzaak / oplossing |
|---|---|
| `401 Niet geautoriseerd` | Token in Shortcut ≠ `INGEST_TOKEN`. Header moet `Authorization: Bearer <token>` zijn. |
| `502 Notion onbereikbaar: ... 404` | Integratie niet gekoppeld aan de pagina (stap 1.4) of verkeerd data source-id. |
| `413` | Opname > 24 MB. Hercodeer in het Shortcut of knip. |
| ⚠️-callout "OpenAI transcriptie mislukt (400)" | Meestal een onbekend audioformaat. Controleer `filename`/`Content-Type`; m4a werkt. |
| ⚠️-callout "Claude weigerde..." | Zeer zeldzaam bij zakelijke gesprekken. De tekst staat op de pagina; vat handmatig samen. |
| Pagina blijft op ⏳ staan | `GET /jobs/<jobId>` met je token geeft status en fout. `npx wrangler tail` toont de cron-logs. |
| `CPU time limit exceeded` in tail | Workers Paid ($5/mnd) inschakelen. |
