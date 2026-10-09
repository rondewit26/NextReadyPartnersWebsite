# Het iPhone-Shortcut "Gesprek naar Notion"

Getest op iOS 26 met een Engelstalige interface. Een Shortcut kan niet zonder ondertekening worden
geïmporteerd, dus je bouwt hem één keer zelf (ongeveer 10 minuten). De actienamen hieronder zijn de
Engelse namen zoals ze in de app Shortcuts (Opdrachten) staan.

## Opnemen (Apple, iOS 18.1 en hoger)

1. Tijdens een gesprek: tik linksboven op de opnameknop. Beide partijen horen dat het gesprek wordt opgenomen.
2. Hang op of stop de opname. De opname staat in **Notes**, in de map met je gespreksopnamen.

## Versie 1: basis (getest)

Open **Shortcuts** en tik op **+**.

1. Tik op de titel, kies **Rename** en geef hem de naam `Gesprek naar Notion`.
2. Tik onderaan op **ⓘ** en zet **Show in Share Sheet** aan. Controleer of bovenaan "Receive … from **Share Sheet**" staat. Staat daar "Nowhere", dan staat het deelmenu nog uit.
3. Zoek via **Search Actions** de actie **Get Contents of URL** en voeg hem toe:
   - **URL**: `https://<jouw-worker>.workers.dev/ingest`
   - **Method**: `POST`
   - **Headers**, twee regels:
     - `Authorization` = `Bearer ` (één spatie) gevolgd door je INGEST_TOKEN
     - `Content-Type` = `audio/x-m4a`
   - **Request Body**: `File`, en als bestand **Shortcut Input**
4. Voeg **Show Content** toe (in oudere iOS-versies heet dit **Show Result**). Zijn invoer moet **Contents of URL** zijn.
5. Sla op met de terugpijl.

Gebruik: open Notes, tik op de opname, deel de opname zelf (niet de hele notitie) en kies **Gesprek naar Notion**.
Lukt delen vanuit Notes niet, kies dan **Save to Files** en deel het bestand vanuit **Files**.

Je ziet `ok: true` en een `url`. Binnen enkele minuten staat de meeting note in Notion.

Het token in de header is geheim. Deel dit Shortcut dus nooit via een link of iCloud-deling, en maak
een token onleesbaar in screenshots (zie "Token wisselen" hieronder).

## Versie 2: met vragen voor contact, categorie en notities

Zet deze acties direct onder "Receive", vóór "Get Contents of URL":

1. **Ask for Input** (type Text), vraag `Met wie was dit gesprek? (naam, bedrijf)`. Hernoem de uitvoer naar `Contact`.
2. **List** met de regels `Klanten`, `Meeting`, `Bedrijf`, `Project`, `Marketing`, `Leren`, `Prive`, `Laat Claude kiezen`.
3. **Choose from List** met die lijst, prompt `Categorie`. Hernoem de uitvoer naar `Categorie`.
4. **Ask for Input** (Text), vraag `Eigen notities? (optioneel)`. Hernoem naar `Notities`.
5. Drie keer **URL Encode**, met als invoer `Contact`, `Categorie` en `Notities`.
6. Zet in het URL-veld van **Get Contents of URL**:
   `https://<jouw-worker>.workers.dev/ingest?contact=[Contact]&categorie=[Categorie]&notities=[Notities]`
   waarbij de blokjes de URL-gecodeerde variabelen uit stap 5 zijn.

"Laat Claude kiezen" betekent dat de Worker de categorie door Claude laat bepalen. Een categorie of
project dat niet in Notion bestaat, wordt genegeerd en komt als waarschuwing in het antwoord.
Wat je zelf invult, wint altijd van wat Claude afleidt.

## Variant B: transcriptie op de iPhone, audio verlaat het toestel niet

Standaard is versie 1 of 2 (OpenAI, beste Nederlandse kwaliteit). Variant B is pas interessant als
Apple's on-device model jouw opnames goed in het Nederlands aankan. Test dat eerst in twee minuten,
los van de Worker:

1. Nieuw Shortcut met **Receive** uit het Share Sheet, daarna **Transcribe Audio** (invoer **Shortcut Input**), daarna **Quick Look** op het resultaat.
2. Deel een echte gespreksopname uit Notes naar dit Shortcut.
3. Beoordeel: Nederlands herkend? Namen en bedrijven redelijk? Geen afgekapte tekst bij een lange opname?

Valt het mee, bouw dan variant B: zelfde Shortcut, maar vervang de actie **Get Contents of URL** door een aanroep naar
`https://<jouw-worker>.workers.dev/ingest-text` met **Method** `POST`, dezelfde `Authorization`-header, **Request Body**
`JSON` en de velden `transcript` (de uitvoer van Transcribe Audio), `contact`, `categorie` en `notities`.
De Worker slaat dan de transcriptiestap over; alleen de samenvatting loopt nog via Claude.

## Token wisselen

Doe dit als een token in een screenshot, chat of e-mail heeft gestaan.

1. Maak een nieuwe code: `openssl rand -hex 32`. Bewaar hem in je wachtwoordmanager en maak er geen screenshot van.
2. Zet hem in de Worker: `npx wrangler secret put INGEST_TOKEN` en plak de nieuwe code.
3. Vervang in het Shortcut het token in de header `Authorization`, achter `Bearer `.
4. Lees hem in je Terminal opnieuw in voor eigen tests: `read -s INGEST_TOKEN`.

## Een token onleesbaar maken in een screenshot

Open de screenshot in Markup, kies de **Pen** (niet de Marker, die is doorschijnend), kies zwart en de dikste lijn,
en teken meerdere strepen over het token. Zoom in om te controleren dat er geen letters doorschemeren.

## Problemen

| Je ziet | Oorzaak |
|---|---|
| `Niet geautoriseerd` | Het token in het Shortcut is niet hetzelfde als `INGEST_TOKEN` in de Worker, of er staat geen spatie na `Bearer` |
| Shortcut staat niet in het Share-menu | **Show in Share Sheet** staat uit; bovenaan moet "from Share Sheet" staan |
| Fout van OpenAI over het bestand | Je hebt de notitie gedeeld in plaats van de opname zelf |
| `413` | Opname groter dan 24 MB; knip hem of deel een kortere opname |
| Pagina blijft op ⏳ | Wacht tot vier minuten of start `POST /process`; zie `docs/SETUP.md` |
