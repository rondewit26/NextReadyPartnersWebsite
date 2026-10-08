# Het iPhone-Shortcut "Gesprek → Notion"

Shortcuts kunnen niet als bestand worden geïmporteerd zonder ondertekening, daarom bouw je het één keer
zelf (10 minuten). De actienamen hieronder zijn de Nederlandse iOS 26-namen; tussen haakjes het Engels.

## Opnemen (Apple, iOS 18.1 en hoger)

1. Tijdens een gesprek: tik linksboven op de **opnameknop** (golfje). Beide partijen horen "Dit gesprek wordt opgenomen".
2. Stop de opname of hang op. De opname staat in **Notities** → map **Gespreksopnamen**.

## Shortcut bouwen

Open **Opdrachten** (Shortcuts) → `+` → noem hem **Gesprek → Notion**.

### Instellingen van het Shortcut (ⓘ-knop)

- **Toon in deelmenu** (Show in Share Sheet): aan.
- Deelmenutypen: **Audio** en **Bestanden**.
- Dit maakt bovenaan de actie *Ontvang [Audio en Bestanden] uit Deelmenu* (Receive input from Share Sheet). Als er geen invoer is: **Vraag om** → Bestanden.

### Acties, in deze volgorde

1. **Vraag om invoer** (Ask for Input)
   Type *Tekst*. Prompt: `Met wie was dit gesprek? (naam, bedrijf)`. Standaardantwoord leeg.
   → Hernoem het resultaat naar `Contact` (tik op de variabele → Hernoem).

2. **Lijst** (List) met de regels:
   `Klanten`, `Meeting`, `Bedrijf`, `Project`, `Marketing`, `Leren`, `Prive`, `Laat Claude kiezen`

3. **Kies uit lijst** (Choose from List) → invoer: de Lijst. Prompt: `Categorie`.
   → Hernoem resultaat naar `Categorie`. (De waarde "Laat Claude kiezen" laat de Worker de categorie aan Claude over.)

4. **Vraag om invoer** (Ask for Input)
   Type *Tekst*. Prompt: `Eigen notities? (optioneel)`. → Hernoem naar `Notities`.

5. **URL-codeer** (URL Encode) → invoer `Contact`. Hernoem naar `ContactEnc`.
6. **URL-codeer** → invoer `Categorie`. Hernoem naar `CategorieEnc`.
7. **URL-codeer** → invoer `Notities`. Hernoem naar `NotitiesEnc`.

8. **Tekst** (Text), met je eigen Worker-URL:
   ```
   https://call-notes-to-notion.<account>.workers.dev/ingest?contact=[ContactEnc]&categorie=[CategorieEnc]&notities=[NotitiesEnc]
   ```
   De blokjes tussen `[ ]` zijn de variabelen uit stap 5 t/m 7 (via "Selecteer variabele").
   → Hernoem naar `Endpoint`.

9. **Haal inhoud van URL op** (Get Contents of URL)
   - URL: `Endpoint`
   - Methode: **POST**
   - Kopteksten (Headers): `Authorization` = `Bearer <jouw INGEST_TOKEN>`
   - Hoofdtekst aanvragen (Request Body): **Bestand** (File) → kies **Opdrachtinvoer** (Shortcut Input)

   Kies dus *niet* "Formulier" of "JSON": de audio gaat als ruwe body, dat is het snelst en het meest betrouwbaar.

10. **Haal waarde uit woordenboek** (Get Dictionary Value) → sleutel `url` uit *Inhoud van URL*. Hernoem naar `NotionURL`.
11. **Haal waarde uit woordenboek** → sleutel `error`. Hernoem naar `Fout`.

12. **Als** (If) `Fout` *heeft een waarde* (has any value)
    - **Toon waarschuwing** (Show Alert): `Mislukt: [Fout]`
    **Anders**
    - **Toon melding** (Show Notification): `Notion-pagina staat klaar, inhoud volgt binnen enkele minuten.`
    - (optioneel) **Open URL's** → `NotionURL`
    **Einde Als**

## Gebruiken

Notities → **Gespreksopnamen** → open de notitie → tik op de opname → **Deel**-knop → **Gesprek → Notion**.
Zie je bij de opname geen deelknop, kies dan **Bewaar in Bestanden** en deel het bestand vanuit de app Bestanden.

Het werkt net zo goed op een Dictafoon-opname of een audiobestand uit Bestanden, bijvoorbeeld voor
een live meeting die je met je telefoon op tafel hebt opgenomen.

## Variant B: transcriptie op de iPhone, audio verlaat het toestel niet

Standaard is variant A (OpenAI, beste Nederlandse kwaliteit). Variant B is pas interessant als
Apple's on-device model jouw opnames in het Nederlands goed aankan. Zo test je dat in twee minuten,
los van de Worker:

1. Nieuw Shortcut "Test transcriptie": **Ontvang Audio uit Deelmenu** → **Transcribeer audio** (Opdrachtinvoer) → **Snelle blik** (Quick Look) op het resultaat.
2. Deel een echte gespreksopname uit Notities naar dit Shortcut.
3. Beoordeel: Nederlands herkend? Namen en bedrijven redelijk? Geen afgekapte tekst bij een lange opname?

Valt het mee, bouw dan variant B. Valt het tegen, dan blijft variant A de standaard.

Zelfde Shortcut als variant A, maar stap 8 en 9 worden anders.

8. **Transcribeer audio** (Transcribe Audio) → invoer: **Opdrachtinvoer**. Hernoem resultaat naar `Transcript`.
   (Lange opnames kunnen hier op een time-out lopen; dan is variant A de oplossing.)
9. **Haal inhoud van URL op** (Get Contents of URL)
   - URL: `https://call-notes-to-notion.<account>.workers.dev/ingest-text`
   - Methode: **POST**
   - Kopteksten: `Authorization` = `Bearer <jouw INGEST_TOKEN>`
   - Hoofdtekst aanvragen: **JSON** met de velden
     `transcript` = `Transcript`, `contact` = `Contact`, `categorie` = `Categorie`, `notities` = `Notities`
   De stappen 5 t/m 7 (URL-coderen) vervallen; JSON heeft dat niet nodig.

De rest (stap 10 t/m 12) blijft gelijk. De Worker slaat dan de transcriptiestap over; alleen de
samenvatting loopt nog via Claude.

## Varianten

- **Minder vragen**: haal stap 1, 4 of 2–3 weg; de Worker vult dan zelf contact en categorie via Claude.
- **Vaste categorie**: vervang stap 2–3 door een Tekst-actie met bijv. `Klanten`.
- **Grote bestanden**: zet vóór stap 9 **Codeer media** (Encode Media) met *Alleen audio* aan en gebruik dat resultaat als body; dat drukt een lange opname ruim onder de 24 MB.
- **Titel zelf opgeven**: voeg `&titel=[TitelEnc]` toe aan de URL.
