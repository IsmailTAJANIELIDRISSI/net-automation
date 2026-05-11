# DUM Normale Partiel — Automation Spec

> **Scope:** BADR-only. No Portnet interaction. This handles LTAs marked as `partiel: true` in `acheminement.json`.
> **Integration point:** After `badrLotLookup` finds ≥2 rows, a new class `BADRDumNormalPartiel` drives the full BADR declaration flow.
> **Reference codebase:** `src/badr/`, `src/utils/manifestPdfExtract.js`, `src/ui/components/AcheminementCard.jsx`, `electron/main.js`, `index.js`

---

## 1. Business Process Overview

When an LTA is flagged as partiel (multiple flight legs for the same shipment), the standard DS Combinée Portnet flow is skipped. Instead we create a **DUM Normale (Régime 085 — Transit à l'import)** declaration directly in BADR and fill it with data from all partial lots. The process requires:

1. User marks the LTA `partiel` in the UI and provides extra fields.
2. App extracts shipper name from MAWB PDF + quantité facturée from manifest PDF.
3. App fetches the exchange rate to convert MAWB fret value to MAD.
4. App opens BADR → creates a new DUM 085 declaration → fills all tabs → saves → prints.

---

## 2. New User-Facing Inputs (AcheminementCard)

These inputs appear **only when `partiel: true`** is checked. They are persisted in `acheminement.json` via the existing `acheminement:save` IPC channel.

| Field key | Label | Source | User can edit? |
|---|---|---|---|
| `shipperName` | Expéditeur (nom société) | Auto-extracted from MAWB PDF via `know_companies.json` | Yes |
| `fretValue` | Valeur fret MAWB | Manual entry | Yes |
| `mawbCurrency` | Devise MAWB | Select: USD / EUR / HKD / CNY / GBP / AED / ... | Yes |
| `qteFacturee` | Quantité facturée | Auto-extracted from manifest PDF footer (1st number of the triplet) | Yes |

Add all four to `SAVED_FIELDS` in `electron/main.js`. Render them in `AcheminementCard.jsx` inside a conditional block `{ach.partiel && (...)}`.

**Extraction triggers:**
- `shipperName`: extracted when the MAWB PDF is detected in the folder scan (before user clicks Lancer). Use `know_companies.json` lookup described in §4.
- `qteFacturee`: extracted by `manifestPdfExtract.js` from the manifest footer triplet (1st number = qteFacturee, 2nd = totalValue, 3rd = totalPoids). Add `qteFacturee` to the returned `manifestPdfExtract` object and wire it to the card.

---

## 3. manifestPdfExtract.js — Add `qteFacturee` Extraction

The manifest footer line has the form: `<qteFacturee> <totalValue> <totalPoids>`

Example: `1618 144501,97 1275` → qteFacturee=1618, totalValue=144501.97, poidTotal=1275.

**Change:** In `extractManifestMetricsFromPdfFile`, when the footer triplet regex matches, also capture group 1 (qteFacturee) and include it in the returned object:

```js
// Add to returned object:
qteFacturee: parseInt(match[1], 10).toString(),
```

Wire this in `electron/main.js` when it processes the PDF extraction result: store `qteFacturee` into `acheminement.json` as `ach.qteFacturee` (same pattern as `poidTotal`, `totalValue`).

---

## 4. Shipper Name Extraction from MAWB PDF

Create `src/utils/mawbShipperExtract.js`. Logic (convert from existing Python):

1. Parse MAWB PDF text using `pdf-parse`.
2. Locate the "Shipper's Name and Address" section (search for that label or look between known anchors in the MAWB structure).
3. Extract the text block immediately following that label (1–3 lines).
4. Load `know_companies.json` (located at root or `src/config/`). This file maps raw PDF text fragments to canonical company names.
5. Iterate entries; if any key appears (case-insensitive) in the extracted block → return the canonical name.
6. Fallback: return the raw first line of the extracted block cleaned of special chars.

Export a single function: `async function extractShipperName(pdfPath, knowCompaniesPath)`.

Call this function in the folder-scan phase in `electron/main.js` when `ach.partiel === true` and `ach.shipperName` is not yet set. Save result to `acheminement.json`.

---

## 5. Exchange Rate Endpoint

Add to `index.js` (Express server):

```js
const OXR_APP_ID = "2da90db00995499ea8ff537a94caf80c";

app.get("/exchange-rate", async (req, res) => {
  const { from } = req.query;
  if (!from) return res.status(400).json({ error: "from is required" });
  const currency = from.toUpperCase().trim();
  try {
    // 1st: BAM (official Moroccan customs rate)
    let r = await fetch(`https://api.frankfurter.dev/v2/rate/${encodeURIComponent(currency)}/MAD?providers=BAM`);
    let data = r.ok ? await r.json() : null;
    if (data?.rate) return res.json({ rates: { MAD: data.rate } });

    // 2nd: frankfurter.dev blended
    r = await fetch(`https://api.frankfurter.dev/v2/rate/${encodeURIComponent(currency)}/MAD`);
    data = r.ok ? await r.json() : null;
    if (data?.rate) return res.json({ rates: { MAD: data.rate } });

    // 3rd: openexchangerates cross-rate via USD
    r = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${OXR_APP_ID}&symbols=${encodeURIComponent(currency)},MAD`);
    if (r.ok) {
      const oxr = await r.json();
      const fromRate = oxr.rates?.[currency];
      const madRate = oxr.rates?.MAD;
      if (fromRate && madRate) return res.json({ rates: { MAD: madRate / fromRate } });
    }
    res.status(502).json({ error: `MAD rate not found for ${currency}` });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
```

**Rounding rule** (used for Montant total and Valeur déclarée):
- Decimal part ≥ 0.5 → round up (Math.ceil)
- Decimal part < 0.5 → truncate (Math.floor)

---

## 6. BADR Lot Lookup — Partiel Mode

**File:** `src/badr/badrLotLookup.js`

When the result table has ≥2 rows and `partiel: true`, collect ALL rows into an array:

```js
partiels: [
  { serie: "5406", cle: "X", lieu: "RYAD K.KHALED", ref: "65-46143985" },
  { serie: "5675", cle: "K", lieu: "RYAD K.KHALED", ref: "65-46143985" },
]
```

- **Série** = last 4 digits + letter of the declaration ref (e.g. `301-000-2026-0005406-X` → `5406`, `X`)
- **Lieu** = the "Lieu de (dé)chargement" column text
- **Ref** = the lot reference (first column link text)

If only 1 row is found → log warning and return `{ waitForMoreLots: true }`. The orchestrator in `main.js` must halt this LTA and not proceed until a subsequent scan finds ≥2 rows.

Save the `partiels` array into `acheminement.json` at phase `partiel_lots_found`.

---

## 7. New File: `src/badr/badrDumNormalPartiel.js`

Create class `BADRDumNormalPartiel` with constructor `(page)`. Expose one public method:

```js
async run(ach, badrConn)
```

Where `ach` is the full acheminement object (from `acheminement.json`) and `badrConn` is the `BADRConnection` instance.

Internally structured as sequential steps, each guarded by a checkpoint phase check so the flow resumes from the last saved phase on restart.

### Step-by-step flow (iframe = `page.frameLocator("#iframeMenu")`)

---

### STEP 1 — Open Create Declaration (phase: `partiel_declaration_opened`)

Navigate: DEDOUANEMENT → Créer une déclaration (`#_2001`).

Inside `#iframeMenu`, fill the creation form:
- Bureau: `301` (PrimeFaces autocomplete, `pressSequentially`)
- Régime: `085` → select `085(TRANSIT A L'IMPORT)` from the dropdown suggestion
- Catégorie: `Normale` (selectonemenu, `li[data-label="Normale"]`)
- Mode: **"Création à partir d'une déclaration existante"** radio (`#rootForm:modeTransport_radioId1:1` or the radio at index 1)
- Then fill the reference fields: Bureau=`301`, Régime=`085`, Année=`2026`, Série=`0001`, Clé=`F`
- Check "Déclaration enregistrée" checkbox
- Click `#rootForm:btnConfirmer`

Wait for the declaration tabs to appear: `a[href='#mainTab:tab3']`.

---

### STEP 2 — Entête Tab (phase: `partiel_entete_saved`)

Tab is active by default after declaration opens.

Fill fields in the "Expéditeur / Exportateur / Cédant" section:
- `#mainTab:form0:nomOperateurExpediteur` ← `ach.shipperName`

Fill "Totaux" section:
- `#mainTab:form0:poidBrutTotal_input` ← `ach.poidTotal` (total kg from manifest)
- Read exchange rate: `GET /exchange-rate?from=USD` → take `rates.MAD` as `tauxChange`
  (always use USD rate from the page span `#mainTab:form0:id_tauxChange` if visible — read it directly from the DOM, it's more accurate than the API for this field)
- `Montant total` = `ach.totalValue / tauxChange` → round per §5 rule → fill `#mainTab:form0:montTotalNumber_input`
- `Date de voyage` = current date as `DD/MM/YYYY` → fill `#mainTab:form0:dateVoyage_input`

Click menu item **SAUVEGARDER** (`a#secure__2002`).

---

### STEP 3 — Moyen de Transport Tab (phase: `partiel_transport_saved`)

Click `a[href='#mainTab:tab11']`.

Check the "Sans moyen de transport" checkbox:
- Click `div#mainTab:form11:checkBoxSansMTId div.ui-chkbox-box` (PrimeFaces checkbox)

Click **SAUVEGARDER** (`a#secure__2002`).

---

### STEP 4 — Caution Tab (phase: `partiel_caution_saved`)

Click `a[href='#mainTab:tab2']`.

Open the "Numéro décision" selectonemenu → select `S2021000002`:
- Click `div#mainTab:form2:numDecisionId div.ui-selectonemenu-trigger`
- Click `li[data-label="S2021000002"]`

Click **SAUVEGARDER** (`a#secure__2002`).

---

### STEP 5 — Préapurement DS Tab — Add All Partial Lots (phase: `partiel_preapurement_done`)

Click `a[href='#mainTab:tab3']`.

**Loop over `ach.partiels` array** (N iterations, one per partial vol):

For each partial `p` at index `i`:

1. Click **Nouveau** button: `button[name*="btnNouveauPreap"]`
2. Select Type DS = `DS(01)`:
   - `div#mainTab:form3:typeDsId div.ui-selectonemenu-trigger` → `li[data-label='DS(01)']`
3. Fill reference fields:
   - Bureau: `input[id*='referencePreap_bureauId']` ← `"301"`
   - Régime: `input[id*='referencePreap_regimeId']` ← `"000"`
   - Année: `input[id*='referencePreap_anneeId']` ← `"2026"`
   - Série: `input[id*='referencePreap_serieId']` ← `p.serie` (e.g. `"0005406"` or `"5406"` — fill as provided, BADR normalizes)
   - Clé: `input[id*='referencePreap_cleId']` ← `p.cle`
4. Fill Lieu de chargement autocomplete: `input[id*='lieuChargCmb_INPUT_input']` ← `p.lieu` (pressSequentially, select first suggestion)
5. Fill Référence lot: `input[id*='preapurement_ref_lot']` ← `p.ref`
6. Click **OK**: `button[id*='btnRefPreapOk']`
7. Wait 2s → read poidsBrut (`#mainTab:form3:poidLotId`) and nbrContenant (`#mainTab:form3:nbrContenantLotId`) — log them
8. Click **Confirmer**: `button#mainTab:form3:btnConfirmerPreap`
9. Wait for the preapurement summary table to update (check `Nombre total des préapurements` span shows `i+1`)

After all loops, **verify data consistency**:
- Sum of all `poidsBrut` values read from each Confirmer result == `ach.poidTotal` (tolerance ±5 kg)
- Sum of all `nbrContenant` == `ach.nombreContenant`
- If mismatch → save error to `acheminement.json` as `phase: "partiel_poids_mismatch"` with a clear message. Log the discrepancy. Skip to next LTA.

---

### STEP 6 — Sauvegarder after Préapurement

Click **SAUVEGARDER** (`a#secure__2002`).

---

### STEP 7 — Documents Tab — Annex Manifest + MAWB (phase: `partiel_documents_saved`)

Click `a[href='#mainTab:tab7']`.

**Document 1 — FACTURE (Manifest PDF):**

1. Open Type selectonemenu: `div#mainTab:form7:comp1 div.ui-selectonemenu-trigger` → click `li[data-label="FACTURE"]` (value=`A0006`)
2. Fill Référence: enable input first if disabled, then `#mainTab:form7:j_id_3p_25r_2_2m_b` ← `"fac"`
3. Fill Date: `#mainTab:form7:dateannexe_input` ← current date `DD/MM/YYYY`
4. Compress manifest PDF using `compressPdfChain.js` if size > 2 MB. Sanitize filename: alphanumeric + dash/underscore only (strip accents, spaces → `_`).
5. Upload via `input#mainTab:form7:comp2_input` using `page.setInputFiles()`
6. Verify upload: wait for a row in `#mainTab:form7:listFichiersAnnexeDT_data` with `FACTURE` text

**Document 2 — TITRE DE TRANSPORT (MAWB PDF):**

1. Open Type selectonemenu → click `li[data-label="TITRE DE PROPRIÉTÉ ET/OU DE TRANSPORT"]` (value=`A0004`)
2. Fill Référence: `"LTA"`
3. Fill Date: current date
4. Compress MAWB PDF if size > 2 MB using `compressPdfChain.js`. Sanitize filename.
5. Upload via `input#mainTab:form7:comp2_input`
6. Verify upload: wait for row with `TITRE DE PROPRIÉTÉ` text in the list

Click **SAUVEGARDER** (`a#secure__2002`).

---

### STEP 8 — Demandes Diverses Tab — Update Scellés (phase: `partiel_demandes_saved`)

Click `a[href='#mainTab:tab4']`.

Click the **Autre(01)** link in the table:
```
a#mainTab:form4:j_id_3p_1km:0:j_id_3p_1ko
```

Wait for `#mainTab:form4:dmd_details` to become visible.

Edit the textarea `#mainTab:form4:j_id_3p_1ll`:
- Current text format: `NS SOLL ACH. DE RAM A MEAD MED AFRICA  / Scellés N°XXXXXXXX-YYYYYYYY`
- Replace only the scellés numbers at the end: `N°${ach.scelle1}-${ach.scelle2}`
- Keep the prefix `NS SOLL ACH. DE RAM A MEAD MED AFRICA  / Scellés N°` unchanged

Click **Confirmer** `button#mainTab:form4:btnConfirmerDmd`.

Click **SAUVEGARDER** (`a#secure__2002`).

---

### STEP 9 — Articles Tab — Fill Article #1 (phase: `partiel_articles_saved`)

Click `a[href='#mainTab:tab1']`.

Click article link **"1"**: `a#mainTab:form1:j_id_3p_zn:0:cmdLinkEditArticle`

Wait for the article detail panel (`#mainTab:form1:j_id_3p_10n`) to appear.

Fill fields:
- **Nombre (contenants)**: `#mainTab:form1:nbrContenantsId` ← `ach.nombreContenant`
- **Marques**: `#mainTab:form1:marqueContenants` ← `"LTA " + ach.refNumber`
- **Poids net (en kg)**: `#mainTab:form1:poidNetNumber_input` ← `ach.poidTotal`
- **Quantité normalisée**: `#mainTab:form1:qteNormaliseeNumber_input` ← `ach.poidTotal`
- **Quantité facturée**: `#mainTab:form1:qteNumber_input` ← `ach.qteFacturee`
- **Valeur déclarée (en Dhs)**:
  1. Fetch exchange rate: `GET http://localhost:<port>/exchange-rate?from=${ach.mawbCurrency}`
  2. Convert: `fretValueMAD = ach.fretValue * rates.MAD`
  3. `valDecMAD = fretValueMAD + parseFloat(ach.totalValue)` (totalValue is manifest value in MAD)
  4. Round per §5 rule → fill `#mainTab:form1:valDecNumber_input`

Click **Confirmer**: `button#mainTab:form1:btnConfirmerArticle`

Click **SAUVEGARDER** (`a#secure__2002`).

---

### STEP 10 — Print / Download Declaration (phase: `partiel_done`)

After SAUVEGARDER, wait for `a#secure_imprimer` to become visible.

Set up a download handler:
```js
const [download] = await Promise.all([
  page.waitForEvent("download"),
  iframe.locator("a#secure_imprimer").click(),
]);
```

Save the file as:
`${ach.name.replace(/\s+/g, "-")}-DUM-NORMAL-${ach.refNumber}.pdf`

into the LTA folder (`ach.folderPath`).

Save phase `partiel_done` to `acheminement.json`. Log completion.

---

## 8. Checkpoint / State Machine for Partiel LTAs

Add these phases to the existing state machine in `electron/main.js`:

| Phase | Meaning |
|---|---|
| `partiel_lots_found` | Lot lookup returned ≥2 rows, partiels array saved |
| `partiel_waiting_lots` | Only 1 lot found — waiting for 2nd flight |
| `partiel_declaration_opened` | DUM 085 declaration created in BADR |
| `partiel_entete_saved` | Entête tab filled and saved |
| `partiel_transport_saved` | Moyen de transport tab done |
| `partiel_caution_saved` | Caution tab done |
| `partiel_preapurement_done` | All N lots added to Préapurement DS |
| `partiel_documents_saved` | Manifest + MAWB uploaded |
| `partiel_demandes_saved` | Scellés updated |
| `partiel_articles_saved` | Article #1 filled |
| `partiel_done` | Declaration printed — LTA complete |
| `partiel_poids_mismatch` | Sum of lots ≠ total weight — halted, needs review |

**Resume logic:** In `runAllAutomationTasks`, when `ach.partiel === true`:
- If `phase === "partiel_done"` → skip (already complete)
- If `phase === "partiel_waiting_lots"` → re-run lot lookup, check row count, proceed or wait again
- Otherwise → instantiate `BADRDumNormalPartiel` and call `run(ach, badrConn)`. The class reads `phase` from `ach.automationState` and skips completed steps internally.

---

## 9. Files to Create / Modify

| File | Action | What |
|---|---|---|
| `src/badr/badrDumNormalPartiel.js` | **CREATE** | Full DUM 085 BADR automation class (§7) |
| `src/utils/mawbShipperExtract.js` | **CREATE** | Shipper name extraction from MAWB PDF (§4) |
| `index.js` | **MODIFY** | Add `/exchange-rate` endpoint (§5) |
| `src/utils/manifestPdfExtract.js` | **MODIFY** | Add `qteFacturee` to footer triplet extraction (§3) |
| `src/badr/badrLotLookup.js` | **MODIFY** | Collect all rows when partiel, return `partiels[]` array (§6) |
| `src/ui/components/AcheminementCard.jsx` | **MODIFY** | Add 4 new conditional inputs for partiel (§2) |
| `electron/main.js` | **MODIFY** | New phases, SAVED_FIELDS, orchestration path for partiel (§8) |

---

## 10. Error Handling & Guards

- **Poids mismatch** (§5 post-loop check): save `partiel_poids_mismatch` phase + `errorMessage` field, log clearly, skip LTA — do NOT retry automatically.
- **Only 1 lot found**: save `partiel_waiting_lots` phase. Next scheduled scan will retry lot lookup.
- **File upload failure** (document not visible in list after 10s): throw error, save `phase: "error"` with message.
- **Exchange rate API unreachable**: throw error with clear message — do not silently use 0.
- **Shipper not found in know_companies.json**: warn in log, save raw extracted text so user can correct it in the UI.
- **All errors**: use existing `updateAutomationState` + logger pattern. Never halt the entire process — mark the LTA as error and move to next.

---

## 11. Data Flow Summary

```
Email (Abdelhak) → User checks partiel checkbox
       ↓
Folder scan → manifestPdfExtract (qteFacturee + poidTotal + totalValue)
            → mawbShipperExtract (shipperName)
       ↓
User fills: fretValue + mawbCurrency + scelle1 + scelle2 + nombreContenant
User verifies: shipperName + qteFacturee (editable)
       ↓
Lancer → badrLotLookup (partiel mode) → partiels[]
       ↓
BADRDumNormalPartiel.run():
  Entête → Moyen transport → Caution → Préapurement (N lots) → Vérif poids
  → Documents → Demandes diverses → Articles → Sauvegarder → Imprimer
       ↓
Download PDF → phase = partiel_done
```

---

now for dum normal which is partiel we have a manual process that we wanna automate it. so the process focus only in system badr this time we dont need to portnet

first step when we ve got email freom abdelhak mentioning that this dum is normal "partiel" with two piece joint "Manifest pdf and MAWB pdf" like this :
1er Acheminement Express (TM Spdf) DUM Normale
MAWB 065-46143963.pdf ; Manifest 065-46143963.pdf

but in this app the user specify checkbox of LTA if its partiel and also the could detect it if it go to badr lookup and find more rows on ds reference

so what we do is we connect to system badr and same process of "badrLotLookup.js" : but when we search and find two rows for example : "we should found minimum 2 rows if not we should stop and wait untill second vol arrived so 2 rows and more because it could be a partial with 3 or 4 vols"

so click MISE EN DOUANE -> SERVICES -> Recherche par reference -> Lot de dedouanement then fill form and click on valider we should got two rows or more
so like this "in this prompt we gonna take as example an LTA partiel with 2 vols so the app when load this folder LTA do this : 15:57:02
info
[Manifeste]
[2eme LTA] PDF "Manifeste 065-46143985.pdf" — extrait: réf 65-46143985, 76 colis, 1275 kg, devise MAD, valeur 144501.97":

Nombre d'enregistrements trouvés : 2
Lot (Référence, Etat) Lieu de (dé)chargement Déclaration(Référence, Date d'enregistrement, Type, Opérateur, Statut)
65-46143985

ETAT : - RYAD K.KHALED
301-000-2026-0005406-X16/04/2026 12:46

DS (AERIEN)

CIE NATIONALE ROYAL AIR MAROC

Statut : Acceptee
65-46143985

ETAT : - RYAD K.KHALED
301-000-2026-0005675-K21/04/2026 12:31

DS (AERIEN)

CIE NATIONALE ROYAL AIR MAROC

Statut : Acceptee

---

<table id="j_id_1h:j_id_5g" class="ui-panelgrid ui-widget width100" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell"><span id="j_id_1h:resultPanel">
	<br><span> La Date d'enregistrement d'une
							Déclaration est celle de sa Version Initiale (N : 0).<br>
								Les Déclarations sont triées par ordre décroissant de Date
								d'enregistrement. 
					</span><br><div id="j_id_1h:ListelotdataTable" class="ui-datatable ui-widget"><div class="ui-datatable-header ui-widget-header ui-corner-top">  
             Nombre d'enregistrements trouvés :  2
         </div><div class="ui-datatable-tablewrapper"><table role="grid"><thead id="j_id_1h:ListelotdataTable_head"><tr role="row"><th id="j_id_1h:ListelotdataTable:j_id_5n" class="ui-state-default" role="columnheader" style="width:150px"><span>Lot (Référence, Etat)</span></th><th id="j_id_1h:ListelotdataTable:j_id_5r" class="ui-state-default" role="columnheader" style="width:156px"><span>Lieu de (dé)chargement</span></th><th id="j_id_1h:ListelotdataTable:j_id_5t" class="ui-state-default" role="columnheader" style="width:280px"><span>Déclaration(Référence, Date d'enregistrement, Type, Opérateur, Statut)</span></th></tr></thead><tfoot></tfoot><tbody id="j_id_1h:ListelotdataTable_data" class="ui-datatable-data ui-widget-content"><tr data-ri="0" class="ui-widget-content ui-datatable-even" role="row"><td role="gridcell"><a id="j_id_1h:ListelotdataTable:0:j_id_5o" href="#" class="ui-commandlink ui-widget" onclick="PrimeFaces.ab({source:'j_id_1h:ListelotdataTable:0:j_id_5o',process:'j_id_1h:ListelotdataTable:0:j_id_5o',update:'@none'});return false;">65-46143985</a>
			
			<br>
			ETAT : -</td><td role="gridcell">RYAD K.KHALED</td><td role="gridcell">
			<div><a id="j_id_1h:ListelotdataTable:0:j_id_5v" href="#" class="ui-commandlink ui-widget" onclick="PrimeFaces.ab({source:'j_id_1h:ListelotdataTable:0:j_id_5v',process:'j_id_1h:ListelotdataTable:0:j_id_5v',update:'@none'});return false;">301-000-2026-0005406-X</a><span class="float-right">16/04/2026 12:46</span>
			</div>
			
			<br>DS (AERIEN)
			<br>CIE NATIONALE ROYAL AIR MAROC
			<br>
			Statut :  Acceptee</td></tr><tr data-ri="1" class="ui-widget-content ui-datatable-odd" role="row"><td role="gridcell"><a id="j_id_1h:ListelotdataTable:1:j_id_5o" href="#" class="ui-commandlink ui-widget" onclick="PrimeFaces.ab({source:'j_id_1h:ListelotdataTable:1:j_id_5o',process:'j_id_1h:ListelotdataTable:1:j_id_5o',update:'@none'});return false;">65-46143985</a>
			
			<br>
			ETAT : -</td><td role="gridcell">RYAD K.KHALED</td><td role="gridcell">
			<div><a id="j_id_1h:ListelotdataTable:1:j_id_5v" href="#" class="ui-commandlink ui-widget" onclick="PrimeFaces.ab({source:'j_id_1h:ListelotdataTable:1:j_id_5v',process:'j_id_1h:ListelotdataTable:1:j_id_5v',update:'@none'});return false;">301-000-2026-0005675-K</a><span class="float-right">21/04/2026 12:31</span>
			</div>
			
			<br>DS (AERIEN)
			<br>CIE NATIONALE ROYAL AIR MAROC
			<br>
			Statut :  Acceptee</td></tr></tbody></table></div><div id="j_id_1h:ListelotdataTable_paginator_bottom" class="ui-paginator ui-paginator-bottom ui-widget-header ui-corner-bottom"><span class="ui-paginator-first ui-state-default ui-corner-all ui-state-disabled"><span class="ui-icon ui-icon-seek-first">p</span></span><span class="ui-paginator-prev ui-state-default ui-corner-all ui-state-disabled"><span class="ui-icon ui-icon-seek-prev">p</span></span><span class="ui-paginator-pages"><span class="ui-paginator-page ui-state-default ui-state-active ui-corner-all">1</span></span><span class="ui-paginator-next ui-state-default ui-corner-all ui-state-disabled"><span class="ui-icon ui-icon-seek-next">p</span></span><span class="ui-paginator-last ui-state-default ui-corner-all ui-state-disabled"><span class="ui-icon ui-icon-seek-end">p</span></span></div></div></span></td></tr></tbody></table>

---

if u see this html content of a table result when badrLotLookup for partiel LTA so we should save the "Lieu de (dé)chargement" and Séquence"as the app do now" of each partiel
like the example above the partiel 1 got "RYAD K.KHALED" as Lieu de (dé)chargement and for Séquence "301-000-2026-0005406-X" so we take only "5406-X"
and Partiel 2 got : RYAD K.KHALED 301-000-2026-0005675-K (which is 5675-K)

when store this info in acheminement json "as the app do for non partiel LTA" we go back to home badr and create declaration on "Dedouanement" like "badrPreapurement.js" do first it Click on Dedouanement -> Créer une déclaration and enter this data :
Bureau : 301
Régime : 085 and select : <div id="rootForm:cmbRegimeSelected_INPUT_panel" class="ui-autocomplete-panel ui-widget-content ui-corner-all ui-helper-hidden ui-shadow" style="height: auto; visibility: visible; width: 154px; z-index: 1002; display: block; top: 170.86px; left: 136.12px;"><ul class="ui-autocomplete-items ui-autocomplete-list ui-widget-content ui-widget ui-corner-all ui-helper-reset"><li class="ui-autocomplete-item ui-autocomplete-list-item ui-corner-all ui-state-highlight" data-item-value="085#~#085(TRANSIT A L'IMPORT)" data-item-label="085(TRANSIT A L'IMPORT)"><span class="ui-autocomplete-query">085</span>(TRANSIT A L'IMPORT)</li></ul></div>
Catégorie : Normal
then choose Création à partir d'une déclaration existante
then
Bureau : 301 ; Régime : 085 ; Année : 2026 ; Série : 0001 ; Clé : F
and check "Déclaration enregistrée" and click on Confirmer
look at badrPreapurement.js to know html structure

so when click on Confirmer and enter to declaration page "Entete" tabs by default
we fill this info
in "Expéditeur/ Exportateur / Cédant" part :
and in this input "Nom ou raison sociale": <input id="mainTab:form0:nomOperateurExpediteur" name="mainTab:form0:nomOperateurExpediteur" type="text" value="FOSHAN DUGE TRADING CO LTD" maxlength="50" style="width:400px;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false">
we should do a process to extract mawb shipper name from pdf and put it into a input in the card of acheminement after checking checkbox "LTA partiel" so the app will extract shipper name based on a script and a know_companies.json given and put it into the input so the user will check it if its wrong he will update it if correct he could start the process "this process of extracting should be before starting process and after checking checkbox of partiel"
my old example in python u can convert it to js "you will find an existing functions in python on how another app extract shipper name and just convert to js and adapt it in our case (because the other app use bloc note but here we use json to store LTAs data)":

so when user start app process the app should go to
in "Totaux" part :
for this input Poids brut total": <input id="mainTab:form0:poidBrutTotal_input" name="mainTab:form0:poidBrutTotal_input" type="text" maxlength="14" style="width:85" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all">
the poid total extracted from manifest by the app "Poids total (kg)" "as the app do now for NON PARTIEL LTA" which is here : 1275
THEN TAKE THE "Taux de change" of USD which always here : <span id="mainTab:form0:id_tauxChange">: 9.26400</span>
and take initially the "valeur" "Valeur totale" which is in this LTA "144501.97" and do this calcule "total valeur"/"taux de change taken from span" so here its : 144501.97/9.26400 so the result of this calcule will be putted in this input of "Montant total" :<span id="mainTab:form0:montTotalNumber" class="ui-inputNum ui-widget"><input id="mainTab:form0:montTotalNumber_input" name="mainTab:form0:montTotalNumber_input" type="text" maxlength="14" style="width:85" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all"><input id="mainTab:form0:montTotalNumber_hinput" name="mainTab:form0:montTotalNumber_hinput" type="hidden" autocomplete="off" value="22041.153"></span>
so if result are **\*\***.5 ann more we add 1 "majorate" and if after virgule number is smaller than 5 we let it without . for ex if result are 21345.6 it will be 21346 if 21346.3 or 21346.4 it stay 21346

in this date input "Date de voyage" : <span id="mainTab:form0:dateVoyage" class="validerDate"><input id="mainTab:form0:dateVoyage_input" name="mainTab:form0:dateVoyage_input" type="text" value="27/12/2025" class="ui-inputfield ui-widget ui-state-default ui-corner-all hasDatepicker" maxlength="10" size="11" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></span>
we do the current date

the we click in "Sauvegarder" : <li class="ui-menuitem ui-widget ui-corner-all" role="menuitem"><a id="secure__2002" class="ui-menuitem-link ui-corner-all" href="javascript:void(0)" onclick="PrimeFaces.ab({source:'secure__2002',process:'mainTab:form0:content_tab0',update:'leftMenuPanel',partialSubmit:true,oncomplete:function(xhr,status,args){moveToTargetSection(xhr, status, args, section_widget , 0, true , changerSection_ded_sect_handler_id , 'niveau1' ,'tab0');;},formId:'j_id_1g'});return false;"><span class="ui-menuitem-icon ui-icon ui-icon-triangle-1-e"></span><span class="ui-menuitem-text">SAUVEGARDER</span></a></li>

we navigate to "Moyen de transport" tab : <a href="#mainTab:tab11">Moyen de transport</a>
and check this checkbox : <tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique" colspan="2"><label>Sans moyen de transport ? : </label><div id="mainTab:form11:checkBoxSansMTId" class="ui-chkbox ui-widget"><div class="ui-helper-hidden-accessible"><input id="mainTab:form11:checkBoxSansMTId_input" name="mainTab:form11:checkBoxSansMTId_input" type="checkbox"></div><div class="ui-chkbox-box ui-widget ui-corner-all ui-state-default"><span class="ui-chkbox-icon ui-c"></span></div></div></td></tr>

and navigate to "Caution" tab : <a href="#mainTab:tab2">Caution</a>
and for select of "Numéro décision" : <div id="mainTab:form2:numDecisionId" class="ui-selectonemenu ui-widget ui-state-default ui-corner-all ui-helper-clearfix" style="width: 190px;"><div class="ui-helper-hidden"><select id="mainTab:form2:numDecisionId_input" name="mainTab:form2:numDecisionId_input"><option value="">Choisir un numéro de décision</option><option value="S2021000002">S2021000002</option></select></div><div class="ui-helper-hidden-accessible"><input id="mainTab:form2:numDecisionId_focus" name="mainTab:form2:numDecisionId_focus" type="text"></div><label id="mainTab:form2:numDecisionId_label" class="ui-selectonemenu-label ui-inputfield ui-corner-all" style="width: 159.72px;" title=" Choisir un numéro de décision">Choisir un numéro de décision</label><div class="ui-selectonemenu-trigger ui-state-default ui-corner-right"><span class="ui-icon ui-icon-triangle-1-s"></span></div></div>

we choose always this option of "S2021000002" : <div id="mainTab:form2:numDecisionId_panel" class="ui-selectonemenu-panel ui-widget-content ui-corner-all ui-helper-hidden ui-shadow" style="width: 400px; top: 318.32px; left: 444.75px; z-index: 1003; display: block;"><div class="ui-selectonemenu-items-wrapper" style="height:auto"><ul class="ui-selectonemenu-items ui-selectonemenu-list ui-widget-content ui-widget ui-corner-all ui-helper-reset"><li class="ui-selectonemenu-item ui-selectonemenu-list-item ui-corner-all ui-state-highlight" data-label="Choisir un numéro de décision">Choisir un numéro de décision</li><li class="ui-selectonemenu-item ui-selectonemenu-list-item ui-corner-all" data-label="S2021000002">S2021000002</li></ul></div></div>

and click on "Sauvegarder" again

then navigate to "Prepurement DS" tab : <a href="#mainTab:tab3">Preapurement DS</a>

exactly form like this badrPreapurement.js process

"use strict";
/\*\*

- BADRPreapurement – full flow:
- 1.  Expand DEDOUANEMENT panel → click Créer une déclaration (#\_2001)
- 2.  Fill Bureau/Régime/Catégorie form inside #iframeMenu → Confirmer
- 3.  Click "Préapurement DS" tab (still inside iframe) → Nouveau
- 4.  Fill Type DS / Bureau / Régime / Année / Série / Clé / Lieu chargement → OK
- 5.  Read poids_brut + nombre_contenants → return them
-
- Returns: { poidsBrut: '12345.67', nombreContenants: '1' }
  \*/

const config = require("../config/config");
const { createLogger } = require("../utils/logger");

const log = createLogger("BADRPreapurement");

const TIMEOUT = config.timeout;

class BADRPreapurement {
constructor(page) {
this.page = page;
}

// ──────────────────────────────────────────────────────────────────────────
// PUBLIC API — called from main.js
// ──────────────────────────────────────────────────────────────────────────

/\*\*

- Complete weight-check flow.
- @param {object} lotInfo — from BADRLotLookup (has .serie .cle .annee .lieuChargement)
- @returns {{ poidsBrut: string, nombreContenants: string }}
  \*/
  async getPoidsBrut(lotInfo, refNumber) {
  log.info("Starting Préapurement DS flow…", {
  ref: lotInfo.declarationRef,
  mawb: refNumber,
  });

  // Step 1 — DEDOUANEMENT → Créer une déclaration → loads form in #iframeMenu
  const iframe = await this.\_openCreateDeclaration();

  // Step 2 — Fill Bureau/Régime/Catégorie inside iframe and confirm
  await this.\_fillCreateDeclarationForm(iframe);

  // Step 3 — Navigate to Préapurement DS tab (still in iframe after confirm)
  // Step 4 — Fill form and click OK
  return await this.\_fillPreapurementAndRead(iframe, lotInfo, refNumber);

}

// ──────────────────────────────────────────────────────────────────────────
// STEP 1 — DEDOUANEMENT → Créer une déclaration
// ──────────────────────────────────────────────────────────────────────────

async \_openCreateDeclaration() {
const page = this.page;
log.info("Expanding DEDOUANEMENT panel…");

    // The panel header is <h3> containing <a>DEDOUANEMENT</a>
    // Clicking the <a> link inside the header toggles the panel
    const dedouanementHeader = page
      .locator("#leftMenuId .ui-panelmenu-header a")
      .filter({ hasText: "DEDOUANEMENT" });
    const dedouanementContent = page.locator("#_2000");

    const isOpen = await dedouanementContent.isVisible().catch(() => false);
    if (!isOpen) {
      await dedouanementHeader.click();
      await page.waitForSelector("#_2000", {
        state: "visible",
        timeout: 10000,
      });
      await page.waitForTimeout(400);
    }

    log.info("Clicking Créer une déclaration (#_2001)…");
    await page.click("#_2001");

    // Wait for the iframe to load the creation form
    const iframe = page.frameLocator("#iframeMenu");
    await iframe
      .locator("#rootForm\\:btnConfirmer")
      .waitFor({ timeout: TIMEOUT });
    log.info("Create declaration form loaded in iframe");
    return iframe;

}

// ──────────────────────────────────────────────────────────────────────────
// STEP 2 — Fill Bureau + Régime + Catégorie inside iframe → Confirmer
// ──────────────────────────────────────────────────────────────────────────

async \_fillCreateDeclarationForm(iframe) {
log.info(
"Filling create declaration form (Bureau=301, Régime=010, Normale)…",
);

    // PrimeFaces autocomplete REQUIRES pressSequentially — fill() doesn't fire keydown
    const inputs = iframe.locator(
      'input.ui-autocomplete-input[role="textbox"]',
    );

    // Bureau: 301
    const bureauInput = inputs.nth(0);
    await bureauInput.click();
    await bureauInput.pressSequentially(config.badr.bureauCode, { delay: 80 });
    await iframe
      .locator("li.ui-autocomplete-item")
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    await iframe.locator("li.ui-autocomplete-item").first().click();
    await iframe.locator("body").click(); // dismiss
    await this.page.waitForTimeout(300);

    // Régime: 010
    const regimeInput = inputs.nth(1);
    await regimeInput.click();
    await regimeInput.pressSequentially("010", { delay: 80 });
    await iframe
      .locator("li.ui-autocomplete-item")
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    await iframe.locator("li.ui-autocomplete-item").first().click();
    await this.page.waitForTimeout(300);

    // Radio: formulaire vierge (usually already selected by default)
    await iframe
      .locator("#rootForm\\:modeTransport_radioId1\\:0")
      .check()
      .catch(() => {});

    // Catégorie: Normale
    await iframe.locator("div.ui-selectonemenu-trigger").first().click();
    await iframe
      .locator('li[data-label="Normale"]')
      .waitFor({ state: "visible", timeout: 5000 });
    await iframe.locator('li[data-label="Normale"]').click();
    await this.page.waitForTimeout(300);

    // Confirm — this navigates the iframe to the declaration editing form
    log.info("Clicking Confirmer…");
    await iframe.locator("#rootForm\\:btnConfirmer").click();

    // Wait for the declaration tabs to appear inside the iframe
    await iframe
      .locator("a[href='#mainTab\\:tab3']")
      .waitFor({ timeout: TIMEOUT });
    log.info("Declaration created — tabs visible");

}

// ──────────────────────────────────────────────────────────────────────────
// STEP 3+4 — Préapurement DS tab → Nouveau → fill form → OK → read result
// ──────────────────────────────────────────────────────────────────────────

async \_fillPreapurementAndRead(iframe, lotInfo, refNumber) {
const normalizedRefNumber = this.\_normalizeLotReference(refNumber);

    log.info("Clicking Préapurement DS tab…");
    await iframe.locator("a[href='#mainTab\\:tab3']").click();
    await this.page.waitForTimeout(800);

    // Click "Nouveau"
    const btnNouveau = iframe.locator('button[name*="btnNouveauPreap"]');
    await btnNouveau.waitFor({ timeout: TIMEOUT });
    await btnNouveau.click();
    await this.page.waitForTimeout(500);
    log.info("Préapurement DS form opened");

    // Type DS: DS(01)
    await iframe
      .locator("div#mainTab\\:form3\\:typeDsId div.ui-selectonemenu-trigger")
      .click();
    await iframe
      .locator("li[data-label='DS(01)']")
      .waitFor({ state: "visible", timeout: 5000 });
    await iframe.locator("li[data-label='DS(01)']").click();
    await this.page.waitForTimeout(200);

    // Bureau / Régime / Année / Série / Clé
    await iframe.locator("input[id*='bureauId']").fill(lotInfo.bureau);
    await iframe.locator("input[id*='regimeId']").fill(lotInfo.regime);
    await iframe.locator("input[id*='anneeId']").fill(lotInfo.annee);

    // Série: strip leading zeros → plain number (e.g. '0003064' → '3064')
    const serieNum = String(parseInt(lotInfo.serie, 10));
    await iframe.locator("input[id*='serieId']").fill(serieNum);
    await iframe.locator("input[id*='cleId']").fill(lotInfo.cle);

    // Lieu de chargement — autocomplete; type the value from the lot search result
    if (lotInfo.lieuChargement) {
      const lieuInput = iframe.locator(
        "input[id*='lieuChargCmb'][role='textbox']",
      );
      await lieuInput.click();
      await lieuInput.pressSequentially(lotInfo.lieuChargement, { delay: 60 });
      // wait for suggestion and select first match
      const suggPanel = iframe.locator(
        ".ui-autocomplete-panel li.ui-autocomplete-item",
      );
      const hasSugg = await suggPanel
        .first()
        .waitFor({ timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (hasSugg) {
        await suggPanel.first().click();
        log.info(`Lieu de chargement selected: ${lotInfo.lieuChargement}`);
      } else {
        log.warn(
          `No autocomplete suggestion for lieu "${lotInfo.lieuChargement}" — leaving typed value`,
        );
      }
      await this.page.waitForTimeout(300);
    }

    // Référence lot — the MAWB/LTA reference number
    // Field id: mainTab:form3:preapurement_ref_lot
    if (normalizedRefNumber) {
      const refLotInput = iframe.locator("input[id*='preapurement_ref_lot']");
      const refLotExists = await refLotInput
        .count()
        .then((n) => n > 0)
        .catch(() => false);
      if (refLotExists) {
        await refLotInput.click();
        await refLotInput.fill(normalizedRefNumber);
        log.info(`Référence lot filled: ${normalizedRefNumber}`);
        await this.page.waitForTimeout(300);
      } else {
        log.warn(
          `Référence lot field not found — skipping (MAWB: ${normalizedRefNumber})`,
        );
      }
    }

    // Click OK
    log.info("Clicking OK to load poids brut…");
    await iframe.locator("button[id*='btnRefPreapOk']").click();
    await this.page.waitForTimeout(2000);

    // Read results
    const poidsBrutEl = iframe.locator("#mainTab\\:form3\\:poidLotId");
    const nombreContenantsEl = iframe.locator(
      "#mainTab\\:form3\\:nbrContenantLotId",
    );

    await poidsBrutEl.waitFor({ timeout: TIMEOUT });

    const poidsBrut = (await poidsBrutEl.textContent()).trim();
    const nombreContenants = (
      await nombreContenantsEl.textContent().catch(() => "")
    ).trim();

    log.info("Préapurement result", { poidsBrut, nombreContenants });
    return { poidsBrut, nombreContenants };

}

\_normalizeLotReference(lotReference) {
const ref = String(lotReference || "").trim();
const match = ref.match(/^(0+)(\d+)(-.+)$/);

    if (!match) return ref;

    const normalizedPrefix = String(parseInt(match[2], 10));
    return `${normalizedPrefix}${match[3]}`;

}
}

module.exports = BADRPreapurement;

---

but in this partiel case we dont check and go no we add Lot for each partiel
when filling form with 1st partiel info "serie,clé,lieu,ref"

for ex in this example and based on badrLotLookup : Nombre d'enregistrements trouvés : 2
Lot (Référence, Etat) Lieu de (dé)chargement Déclaration(Référence, Date d'enregistrement, Type, Opérateur, Statut)
65-46143985

ETAT : - RYAD K.KHALED
301-000-2026-0005406-X

DS (AERIEN)

CIE NATIONALE ROYAL AIR MAROC

Statut : Acceptee
65-46143985

ETAT : - RYAD K.KHALED
301-000-2026-0005675-K

DS (AERIEN)

CIE NATIONALE ROYAL AIR MAROC

Statut : Acceptee

---

based on this 2 partial vol in "Preapurement ds" tab we gonna add 2 lots and in each lot we should click on "Confirmer" after clicking on "Ok"
like this form : <table id="mainTab:form3:panelDecExistante" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell"><div id="mainTab:form3:j_id_3p_1fd" class="ui-panel ui-widget ui-widget-content ui-corner-all ui-widget-header-2"><div id="mainTab:form3:j_id_3p_1fd_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Recherche du lot</span></div><div id="mainTab:form3:j_id_3p_1fd_content" class="ui-panel-content ui-widget-content"><span id="mainTab:form3:panelReferencePreap"><table id="mainTab:form3:j_id_3p_1ff" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 20%" class="rubrique">
Type DS

</td><td role="gridcell"><div id="mainTab:form3:typeDsId" class="ui-selectonemenu ui-widget ui-state-default ui-corner-all ui-helper-clearfix" style="width: 152px;"><div class="ui-helper-hidden"><select id="mainTab:form3:typeDsId_input" name="mainTab:form3:typeDsId_input"><option value="">Choisir un type de DS</option><option value="05">Depotage(05)</option><option value="01" selected="selected">DS(01)</option><option value="03">DS MEAD(03)</option><option value="08">DS MEAD combinee(08)</option><option value="02">DS Pool(02)</option><option value="06">Eclatement TT(06)</option><option value="04">EPCST(04)</option><option value="07">PEC TIR(07)</option></select></div><div class="ui-helper-hidden-accessible"><input id="mainTab:form3:typeDsId_focus" name="mainTab:form3:typeDsId_focus" type="text"></div><label id="mainTab:form3:typeDsId_label" class="ui-selectonemenu-label ui-inputfield ui-corner-all" style="width: 135.545px;">DS(01)</label><div class="ui-selectonemenu-trigger ui-state-default ui-corner-right"><span class="ui-icon ui-icon-triangle-1-s"></span></div></div></td></tr></tbody></table><table id="mainTab:form3:j_id_3p_1fn" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 20%" class="rubrique">
Référence DS
</td><td role="gridcell">
<div><table id="mainTab:form3:j_id_3p_1ft" class="ui-panelgrid ui-widget" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="text-align : center;" class="rubrique">
Bureau
</td><td role="gridcell" style="text-align : center" class="rubrique">
Régime
</td><td role="gridcell" style="text-align : center" class="rubrique">
Année
</td><td role="gridcell" style="text-align : center" class="rubrique">
Série
</td><td role="gridcell" style="text-align : center" class="rubrique">
Clé
</td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" style="text-align : center"><input id="mainTab:form3:referencePreap_bureauId" name="mainTab:form3:referencePreap_bureauId" type="text" value="301" maxlength="3" size="3" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all " role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td><td role="gridcell" style="text-align : center"><input id="mainTab:form3:referencePreap_regimeId" name="mainTab:form3:referencePreap_regimeId" type="text" value="000" maxlength="3" size="3" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all " role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td><td role="gridcell" style="text-align : center"><input id="mainTab:form3:referencePreap_anneeId" name="mainTab:form3:referencePreap_anneeId" type="text" value="2026" maxlength="4" size="4" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all " role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td><td role="gridcell" style="text-align : center"><input id="mainTab:form3:referencePreap_serieId" name="mainTab:form3:referencePreap_serieId" type="text" value="0005406" maxlength="7" size="7" style="border-color: #aed0ea;width: 55px;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all " role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td><td role="gridcell" style="text-align : center"><input id="mainTab:form3:referencePreap_cleId" name="mainTab:form3:referencePreap_cleId" type="text" value="X" maxlength="1" size="1" onkeyup="this.value = this.value.toUpperCase();" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all " role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td></tr></tbody></table>
</div></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 20%" class="rubrique">
Lieu de chargement
</td><td role="gridcell">
<span id="cmb_lieuchargement"><span id="mainTab:form3:lieuChargCmb_FOCUS"></span><span id="mainTab:form3:lieuChargCmb_PANEL"><span id="mainTab:form3:lieuChargCmb"><span id="mainTab:form3:lieuChargCmb_INPUT" class="ui-autocomplete " style=""><input id="mainTab:form3:lieuChargCmb_INPUT_input" name="mainTab:form3:lieuChargCmb_INPUT_input" type="text" class="ui-autocomplete-input ui-inputfield ui-widget ui-state-default ui-corner-all" autocomplete="off" value="RYAD K.KHALED(RUH)" size="20" onkeydown="return disableCtrlKeyCombination(this,event);" onkeypress="return disableCtrlKeyCombination(this,event);" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"><input id="mainTab:form3:lieuChargCmb_INPUT_hinput" name="mainTab:form3:lieuChargCmb_INPUT_hinput" type="hidden" autocomplete="off" value="RUH#~#RYAD K.KHALED(RUH)"></span></span>
<div style="display: inline-block;vertical-align: center">
<span id="supprimer"><a id="mainTab:form3:lieuChargCmb_supprimer" href="#" class="ui-commandlink ui-widget " onclick="PrimeFaces.ab({source:'mainTab:form3:lieuChargCmb_supprimer',process:'mainTab:form3:lieuChargCmb_supprimer',update:'mainTab:form3:lieuChargCmb rapportMsg mainTab:form3:nbrContenantLotId mainTab:form3:poidLotId',global:false,onsuccess:function(data,status,xhr){disableInput();},oncomplete:function(xhr,status,args){disableInput();}});return false;" style="display : inline-block">
<span class="ui-icon ui-icon-closethick"></span></a>
</span>
</div></span>

    									</span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique">
                                   Référence lot
                                </td><td role="gridcell"><input id="mainTab:form3:preapurement_ref_lot" name="mainTab:form3:preapurement_ref_lot" type="text" value="65-46143985" maxlength="17" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all toUpperCase" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" style="text-align : center" colspan="2"><button id="mainTab:form3:btnRefPreapOk" name="mainTab:form3:btnRefPreapOk" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only " onclick="PrimeFaces.ab({source:'mainTab:form3:btnRefPreapOk',process:'mainTab:form3:panelReferencePreap',update:'mainTab:form3:infos_ds mainTab:form3:panelDecExistante mainTab:form3:nbrContenantLotId mainTab:form3:poidLotId mainTab:form3:declarationExistante mainTab:form3:tareLotId',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c"> OK</span></button>
    											&nbsp;
    									 <button id="mainTab:form3:btnRetablirPreap" name="mainTab:form3:btnRetablirPreap" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only " onclick="PrimeFaces.ab({source:'mainTab:form3:btnRetablirPreap',process:'mainTab:form3:btnRetablirPreap',update:'mainTab:form3:panelDecExistante',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Rétablir</span></button></td></tr></tbody></table></span></div></div><div id="mainTab:form3:declarationExistante" class="ui-panel ui-widget ui-widget-content ui-corner-all ui-widget-header-2"><div id="mainTab:form3:declarationExistante_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Lot de dédouanement</span></div><div id="mainTab:form3:declarationExistante_content" class="ui-panel-content ui-widget-content"><table id="mainTab:form3:infos_ds" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 20%" class="rubrique">
                                    Mode de transport :
                                    </td><td role="gridcell">AERIEN</td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique">
                                    Moyen de transport :
                                </td><td role="gridcell"></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique">
                                    Date d'arrivée :
                                </td><td role="gridcell">16/04/2026</td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique">
                                   Poids brut
                                   </td><td role="gridcell"><span id="mainTab:form3:poidLotId">27</span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique">
    								Nbre contenant(s)
    								</td><td role="gridcell"><span id="mainTab:form3:nbrContenantLotId">2</span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique">
    								Tare
    								</td><td role="gridcell"><span id="mainTab:form3:tareLotId">0</span></td></tr></tbody></table></div></div>
    						<div align="center"><button id="mainTab:form3:btnConfirmerPreap" name="mainTab:form3:btnConfirmerPreap" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only " onclick="PrimeFaces.ab({source:'mainTab:form3:btnConfirmerPreap',process:'mainTab:form3:preap_details',update:'mainTab:form3:preap_section_body',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Confirmer</span></button>
    						</div></td></tr></tbody></table>

we should click on "Confirmer" : <button id="mainTab:form3:btnConfirmerPreap" name="mainTab:form3:btnConfirmerPreap" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" onclick="PrimeFaces.ab({source:'mainTab:form3:btnConfirmerPreap',process:'mainTab:form3:preap_details',update:'mainTab:form3:preap_section_body',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Confirmer</span></button>

and again do that for second vol partial until we got this table :

<tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique">
					<span class="rubrique">Nombre total des préapurements :</span>
					<span>2</span></td></tr>
<tr class="ui-widget-content" role="row"><td role="gridcell"><div id="mainTab:form3:table_preap" class="ui-datatable ui-widget"><div class="ui-datatable-tablewrapper"><table role="grid"><thead id="mainTab:form3:table_preap_head"><tr role="row"><th id="mainTab:form3:table_preap:j_id_3p_1ds" class="ui-state-default" role="columnheader"><span>N°</span></th><th id="mainTab:form3:table_preap:j_id_3p_1du" class="ui-state-default" role="columnheader"><span>Type DS</span></th><th id="mainTab:form3:table_preap:j_id_3p_1dw" class="ui-state-default" role="columnheader"><span>Référence DS</span></th><th id="mainTab:form3:table_preap:j_id_3p_1e7" class="ui-state-default" role="columnheader"><span>Lieu de chargement</span></th><th id="mainTab:form3:table_preap:j_id_3p_1e9" class="ui-state-default" role="columnheader"><span>Référence lot</span></th><th id="mainTab:form3:table_preap:j_id_3p_1eh" class="ui-state-default" role="columnheader"><span>Poids brut</span></th><th id="mainTab:form3:table_preap:j_id_3p_1ej" class="ui-state-default" role="columnheader"><span>Nbre contenant</span></th><th id="mainTab:form3:table_preap:j_id_3p_1el" class="ui-state-default" role="columnheader"><span>Tare</span></th><th id="mainTab:form3:table_preap:j_id_3p_1en" class="ui-state-default" role="columnheader"><span>BAD</span></th></tr></thead><tfoot></tfoot><tbody id="mainTab:form3:table_preap_data" class="ui-datatable-data ui-widget-content"><tr data-ri="0" class="ui-widget-content ui-datatable-even" role="row"><td role="gridcell"><a id="mainTab:form3:table_preap:0:j_id_3p_1dt" href="#" class="ui-commandlink ui-widget notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form3:table_preap:0:j_id_3p_1dt',process:'mainTab:form3:table_preap:0:j_id_3p_1dt',update:'mainTab:form3:preap_section_body'});return false;">1</a></td><td role="gridcell">01</td><td role="gridcell">
							<div align="left"><a id="mainTab:form3:table_preap:0:j_id_3p_1e4" href="#" class="ui-commandlink ui-widget notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form3:table_preap:0:j_id_3p_1e4',process:'mainTab:form3:table_preap:0:j_id_3p_1e4',update:'@none'});return false;">301-000-2026-0005406-X</a>
							</div></td><td role="gridcell">RUH</td><td role="gridcell">65-46143985</td><td role="gridcell">27</td><td role="gridcell">2</td><td role="gridcell">0</td><td role="gridcell"><a id="mainTab:form3:table_preap:0:j_id_3p_1eo" href="#" class="ui-commandlink ui-widget notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form3:table_preap:0:j_id_3p_1eo',process:'mainTab:form3:table_preap:0:j_id_3p_1eo',update:'@none'});return false;"></a></td></tr><tr data-ri="1" class="ui-widget-content ui-datatable-odd" role="row"><td role="gridcell"><a id="mainTab:form3:table_preap:1:j_id_3p_1dt" href="#" class="ui-commandlink ui-widget notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form3:table_preap:1:j_id_3p_1dt',process:'mainTab:form3:table_preap:1:j_id_3p_1dt',update:'mainTab:form3:preap_section_body'});return false;">2</a></td><td role="gridcell">01</td><td role="gridcell">
							<div align="left"><a id="mainTab:form3:table_preap:1:j_id_3p_1e4" href="#" class="ui-commandlink ui-widget notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form3:table_preap:1:j_id_3p_1e4',process:'mainTab:form3:table_preap:1:j_id_3p_1e4',update:'@none'});return false;">301-000-2026-0005675-K</a>
							</div></td><td role="gridcell">RUH</td><td role="gridcell">65-46143985</td><td role="gridcell">1222</td><td role="gridcell">72</td><td role="gridcell">0</td><td role="gridcell"><a id="mainTab:form3:table_preap:1:j_id_3p_1eo" href="#" class="ui-commandlink ui-widget notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form3:table_preap:1:j_id_3p_1eo',process:'mainTab:form3:table_preap:1:j_id_3p_1eo',update:'@none'});return false;"></a></td></tr></tbody></table></div><div id="mainTab:form3:table_preap_paginator_bottom" class="ui-paginator ui-paginator-bottom ui-widget-header ui-corner-bottom"><span class="ui-paginator-first ui-state-default ui-corner-all ui-state-disabled"><span class="ui-icon ui-icon-seek-first">p</span></span><span class="ui-paginator-prev ui-state-default ui-corner-all ui-state-disabled"><span class="ui-icon ui-icon-seek-prev">p</span></span><span class="ui-paginator-pages"><span class="ui-paginator-page ui-state-default ui-state-active ui-corner-all">1</span></span><span class="ui-paginator-next ui-state-default ui-corner-all ui-state-disabled"><span class="ui-icon ui-icon-seek-next">p</span></span><span class="ui-paginator-last ui-state-default ui-corner-all ui-state-disabled"><span class="ui-icon ui-icon-seek-end">p</span></span></div></div></td></tr>

---

we should make sure that
Poids brut Nbre contenant "sum of two partials weight is the total poid of LTA and also for nbr contenant" (Lot 1 + Lot 2 + Lot 3 + Lot \* "if we have more than 2 partials" should be consistant data info "weight and nbr contenant")
if all partials weights and nbr contenant are not equal to global total poid of LTA and nbr .. mark error mismatch "TODO MAIL" and ignore this LTA and go to next LTA by letting error msg in json file clear with checkpoints mark in every step to avoid redoing all process

then we click on "Sauvegarder" : <li class="ui-menuitem ui-widget ui-corner-all" role="menuitem"><a id="secure__2002" class="ui-menuitem-link ui-corner-all" href="javascript:void(0)" onclick="PrimeFaces.ab({source:'secure__2002',process:'mainTab:form0:content_tab0',update:'leftMenuPanel',partialSubmit:true,oncomplete:function(xhr,status,args){moveToTargetSection(xhr, status, args, section_widget , 0, true , changerSection_ded_sect_handler_id , 'niveau1' ,'tab0');;},formId:'j_id_1g'});return false;"><span class="ui-menuitem-icon ui-icon ui-icon-triangle-1-e"></span><span class="ui-menuitem-text">SAUVEGARDER</span></a></li>

then navigate to "Documents" tab : <a href="#mainTab:tab7">Documents</a>
in the documents tab form we should annexe two docs "Facture" and "TITRE DE TRANSPORT" but now :<div id="mainTab:form7:j_id_3p_25r_2_2l" class="ui-panel ui-widget ui-widget-content ui-corner-all panelDoc"><div id="mainTab:form7:j_id_3p_25r_2_2l_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Documents Annexes</span></div><div id="mainTab:form7:j_id_3p_25r_2_2l_content" class="ui-panel-content ui-widget-content"><table id="mainTab:form7:fichierAnnexe" class="ui-panelgrid ui-widget" style="width:100%;" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell"><label id="mainTab:form7:j_id_3p_25r_2_2m_3" class="ui-outputlabel">Type</label></td><td role="gridcell"><div id="mainTab:form7:comp1" class="ui-selectonemenu ui-widget ui-state-default ui-corner-all ui-helper-clearfix" style="width:400px;"><div class="ui-helper-hidden"><select id="mainTab:form7:comp1_input" name="mainTab:form7:comp1_input"><option value="">Choisir un type de document</option><option value="A0002">AUTORISATIONS DE LA DOUANE</option><option value="A0003">DOCUMENTS TECHNIQUES</option><option value="A0004">TITRE DE PROPRIÉTÉ ET/OU DE TRANSPORT</option><option value="VAL_ARBI">Demande de consignation valeur</option><option value="VAL_CONS">Demande d'arbitrage valeur</option><option value="A0006">FACTURE</option><option value="A0001">DOCUMENTS COMMERCIAUX</option><option value="A0005">AUTRES AUTORISATIONS ADMINISTRATIVES</option></select></div><div class="ui-helper-hidden-accessible"><input id="mainTab:form7:comp1_focus" name="mainTab:form7:comp1_focus" type="text"></div><label id="mainTab:form7:comp1_label" class="ui-selectonemenu-label ui-inputfield ui-corner-all" style="width: 305.222px;">Choisir un type de document</label><div class="ui-selectonemenu-trigger ui-state-default ui-corner-right"><span class="ui-icon ui-icon-triangle-1-s"></span></div></div></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell"><label id="mainTab:form7:j_id_3p_25r_2_2m_9" class="ui-outputlabel">Référence</label></td><td role="gridcell"><input id="mainTab:form7:j_id_3p_25r_2_2m_b" name="mainTab:form7:j_id_3p_25r_2_2m_b" type="text" maxlength="10" disabled="disabled" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all ui-state-disabled" role="textbox" aria-disabled="true" aria-readonly="false" aria-multiline="false"></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell"><label id="mainTab:form7:j_id_3p_25r_2_2m_e" class="ui-outputlabel">Date</label></td><td role="gridcell"><span id="mainTab:form7:dateannexe" class="calendar-font-normal validerDate"><input id="mainTab:form7:dateannexe_input" name="mainTab:form7:dateannexe_input" type="text" class="ui-inputfield ui-widget ui-state-default ui-corner-all ui-state-disabled" maxlength="10" size="10" disabled="disabled" role="textbox" aria-disabled="true" aria-readonly="false" aria-multiline="false"></span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell"><label id="mainTab:form7:j_id_3p_25r_2_2m_i" class="ui-outputlabel">Commentaire</label></td><td role="gridcell"><textarea id="mainTab:form7:j_id_3p_25r_2_2m_l" name="mainTab:form7:j_id_3p_25r_2_2m_l" cols="50" rows="3" disabled="disabled" class="ui-inputfield ui-inputtextarea ui-widget ui-state-default ui-corner-all ui-state-disabled ui-inputtextarea-resizable" role="textbox" aria-disabled="true" aria-readonly="false" aria-multiline="true"></textarea></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell"><div id="mainTab:form7:j_id_3p_25r_2_2m_n" class="ui-panel ui-widget ui-widget-content ui-corner-all panelWithSimpleTitle" style="width:100%;"><div id="mainTab:form7:j_id_3p_25r_2_2m_n_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Sélectionnez le(s) fichier(s) à charger pour le document</span></div><div id="mainTab:form7:j_id_3p_25r_2_2m_n_content" class="ui-panel-content ui-widget-content"><table id="mainTab:form7:fichierDocAnnexe" class="ui-panelgrid ui-widget" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell"><div id="mainTab:form7:comp2" class="ui-fileupload ui-widget" style="display: block;"><div class="fileupload-buttonbar ui-widget-header ui-corner-top"><label class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-icon-left fileinput-button" role="button" aria-disabled="false"><span class="ui-button-icon-left ui-icon ui-c ui-icon-plusthick"></span><span class="ui-button-text ui-c">Sélectionner un fichier</span><input type="file" id="mainTab:form7:comp2_input" name="mainTab:form7:comp2_input"></label></div><div class="fileupload-content ui-widget-content ui-corner-bottom"><table class="files"></table></div></div></td></tr></tbody></table></div></div></td></tr></tbody></table><div id="mainTab:form7:j_id_3p_25r_2_2m_u" class="ui-panel ui-widget ui-widget-content ui-corner-all panelWithSimpleTitle"><div id="mainTab:form7:j_id_3p_25r_2_2m_u_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Liste des fichiers chargés</span></div><div id="mainTab:form7:j_id_3p_25r_2_2m_u_content" class="ui-panel-content ui-widget-content"><div id="mainTab:form7:listFichiersAnnexeDT" class="ui-datatable ui-widget"><div class="ui-datatable-tablewrapper"><table role="grid"><thead id="mainTab:form7:listFichiersAnnexeDT_head"><tr role="row"><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_w" class="ui-state-default" role="columnheader"><span></span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_z" class="ui-state-default" role="columnheader"><span>Nom du fichier</span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_11" class="ui-state-default" role="columnheader"><span>Document</span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_13" class="ui-state-default" role="columnheader"><span>Fournisseur / Clients</span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_15" class="ui-state-default" role="columnheader"><span>Référence</span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_17" class="ui-state-default" role="columnheader"><span>Date</span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_19" class="ui-state-default" role="columnheader"><span>Commentaire</span></th></tr></thead><tfoot></tfoot><tbody id="mainTab:form7:listFichiersAnnexeDT_data" class="ui-datatable-data ui-widget-content"><tr class="ui-widget-content ui-datatable-empty-message"><td colspan="7"> </td></tr></tbody></table></div></div></div></div></div></div>

on "Type" select input : <div id="mainTab:form7:comp1" class="ui-selectonemenu ui-widget ui-state-default ui-corner-all ui-helper-clearfix" style="width:400px;"><div class="ui-helper-hidden"><select id="mainTab:form7:comp1_input" name="mainTab:form7:comp1_input"><option value="">Choisir un type de document</option><option value="A0002">AUTORISATIONS DE LA DOUANE</option><option value="A0003">DOCUMENTS TECHNIQUES</option><option value="A0004">TITRE DE PROPRIÉTÉ ET/OU DE TRANSPORT</option><option value="VAL_ARBI">Demande de consignation valeur</option><option value="VAL_CONS">Demande d'arbitrage valeur</option><option value="A0006">FACTURE</option><option value="A0001">DOCUMENTS COMMERCIAUX</option><option value="A0005">AUTRES AUTORISATIONS ADMINISTRATIVES</option></select></div><div class="ui-helper-hidden-accessible"><input id="mainTab:form7:comp1_focus" name="mainTab:form7:comp1_focus" type="text"></div><label id="mainTab:form7:comp1_label" class="ui-selectonemenu-label ui-inputfield ui-corner-all" style="width: 305.222px;" title=" Choisir un type de document">Choisir un type de document</label><div class="ui-selectonemenu-trigger ui-state-default ui-corner-right"><span class="ui-icon ui-icon-triangle-1-s"></span></div></div>
we select "FACTURE" and in Référence input :<input id="mainTab:form7:j_id_3p_25r_2_2m_b" name="mainTab:form7:j_id_3p_25r_2_2m_b" type="text" maxlength="10" disabled="disabled" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all ui-state-disabled" role="textbox" aria-disabled="true" aria-readonly="false" aria-multiline="false">
we type "fac"
and for "Date" input we select current date : <td role="gridcell"><span id="mainTab:form7:dateannexe" class="calendar-font-normal validerDate"><input id="mainTab:form7:dateannexe_input" name="mainTab:form7:dateannexe_input" type="text" class="ui-inputfield ui-widget ui-state-default ui-corner-all hasDatepicker" maxlength="10" size="10" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"><button type="button" class="ui-datepicker-trigger ui-button ui-widget ui-state-default ui-corner-all ui-button-icon-only" title="" role="button" aria-disabled="false"><span class="ui-button-icon-left ui-icon ui-icon-calendar"></span><span class="ui-button-text">ui-button</span></button></span></td>

and we upload the compressed Manifest \*.pdf after compressing it with process of compressPdfChain.js and make sure name of pdf file only "alphanumerique"
and upload it in here : <div id="mainTab:form7:comp2" class="ui-fileupload ui-widget" style="display: block;"><div class="fileupload-buttonbar ui-widget-header ui-corner-top"><label class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-icon-left fileinput-button" role="button" aria-disabled="false"><span class="ui-button-icon-left ui-icon ui-c ui-icon-plusthick"></span><span class="ui-button-text ui-c">Sélectionner un fichier</span><input type="file" id="mainTab:form7:comp2_input" name="mainTab:form7:comp2_input"></label></div><div class="fileupload-content ui-widget-content ui-corner-bottom"><table class="files"></table></div></div>

and make sure its annexed by seeing this list like this ex :<div id="mainTab:form7:j_id_3p_25r_2_2m_u" class="ui-panel ui-widget ui-widget-content ui-corner-all panelWithSimpleTitle"><div id="mainTab:form7:j_id_3p_25r_2_2m_u_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Liste des fichiers chargés</span></div><div id="mainTab:form7:j_id_3p_25r_2_2m_u_content" class="ui-panel-content ui-widget-content"><div id="mainTab:form7:listFichiersAnnexeDT" class="ui-datatable ui-widget"><div class="ui-datatable-tablewrapper"><table role="grid"><thead id="mainTab:form7:listFichiersAnnexeDT_head"><tr role="row"><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_w" class="ui-state-default" role="columnheader"><span></span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_z" class="ui-state-default" role="columnheader"><span>Nom du fichier</span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_11" class="ui-state-default" role="columnheader"><span>Document</span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_13" class="ui-state-default" role="columnheader"><span>Fournisseur / Clients</span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_15" class="ui-state-default" role="columnheader"><span>Référence</span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_17" class="ui-state-default" role="columnheader"><span>Date</span></th><th id="mainTab:form7:listFichiersAnnexeDT:j_id_3p_25r_2_2m_19" class="ui-state-default" role="columnheader"><span>Commentaire</span></th></tr></thead><tfoot></tfoot><tbody id="mainTab:form7:listFichiersAnnexeDT_data" class="ui-datatable-data ui-widget-content"><tr data-ri="0" class="ui-widget-content ui-datatable-even" role="row"><td role="gridcell"><a id="mainTab:form7:listFichiersAnnexeDT:0:j_id_3p_25r_2_2m_x" href="#" class="ui-commandlink ui-widget" onclick="onFileExport();;PrimeFaces.addSubmitParam('mainTab:form7',{'mainTab:form7:listFichiersAnnexeDT:0:j_id_3p_25r_2_2m_x':'mainTab:form7:listFichiersAnnexeDT:0:j_id_3p_25r_2_2m_x'}).submit('mainTab:form7');"><img id="mainTab:form7:listFichiersAnnexeDT:0:j_id_3p_25r_2_2m_y" src="/badr/resources/images/pdf.gif" alt="" class="float-right border-none"></a></td><td role="gridcell">manifeste 065-46143985_compressed.pdf</td><td role="gridcell">FACTURE</td><td role="gridcell"></td><td role="gridcell">fac</td><td role="gridcell">07/05/2026</td><td role="gridcell"><textarea name="mainTab:form7:listFichiersAnnexeDT:0:j_id_3p_25r_2_2m_1a" cols="60" readonly="readonly" rows="3"></textarea></td></tr></tbody></table></div></div></div></div>

when annexe facture now we should annexe the MAWB pdf but we should select in type input "TITRE DE PROPRIÉTÉ ET/OU DE TRANSPORT"
and type "LTA" in Référence input and select current date and upload mawb file after compressing it if its upper than 2MO see and use compressPdfChain.js

then click on "Sauvegarder" : <li class="ui-menuitem ui-widget ui-corner-all" role="menuitem"><a id="secure__2002" class="ui-menuitem-link ui-corner-all" href="javascript:void(0)" onclick="PrimeFaces.ab({source:'secure__2002',process:'mainTab:form0:content_tab0',update:'leftMenuPanel',partialSubmit:true,oncomplete:function(xhr,status,args){moveToTargetSection(xhr, status, args, section_widget , 0, true , changerSection_ded_sect_handler_id , 'niveau1' ,'tab0');;},formId:'j_id_1g'});return false;"><span class="ui-menuitem-icon ui-icon ui-icon-triangle-1-e"></span><span class="ui-menuitem-text">SAUVEGARDER</span></a></li>

the we navigate to "Demandes diverses" : <a href="#mainTab:tab4">Demandes diverses</a>
so we find this : <div id="mainTab:form4:j_id_3p_1km" class="ui-datatable ui-widget"><div class="ui-datatable-tablewrapper"><table role="grid"><thead id="mainTab:form4:j_id_3p_1km_head"><tr role="row"><th id="mainTab:form4:j_id_3p_1km:j_id_3p_1kn" class="ui-state-default" role="columnheader"><span>Demande</span></th><th id="mainTab:form4:j_id_3p_1km:j_id_3p_1kp" class="ui-state-default" role="columnheader"><span>Données paramètres</span></th></tr></thead><tfoot></tfoot><tbody id="mainTab:form4:j_id_3p_1km_data" class="ui-datatable-data ui-widget-content"><tr data-ri="0" class="ui-widget-content ui-datatable-even" role="row"><td role="gridcell"><a id="mainTab:form4:j_id_3p_1km:0:j_id_3p_1ko" href="#" class="ui-commandlink ui-widget notDisabled tableScroll" onclick="PrimeFaces.ab({source:'mainTab:form4:j_id_3p_1km:0:j_id_3p_1ko',process:'mainTab:form4:j_id_3p_1km:0:j_id_3p_1ko',update:'mainTab:form4:dmd_section_body'});return false;">Autre(01)</a></td><td role="gridcell"><span class="tableScroll&gt;">NS SOLL ACH. DE RAM A MEAD MED AFRICA / Scellés N°09199433-09199434</span></td></tr></tbody></table></div></div>

we should edit the Scellés with current given scellés initially by user in acheminement
so we click on "Autre(01)" LINK : <a id="mainTab:form4:j_id_3p_1km:0:j_id_3p_1ko" href="#" class="ui-commandlink ui-widget notDisabled tableScroll" onclick="PrimeFaces.ab({source:'mainTab:form4:j_id_3p_1km:0:j_id_3p_1ko',process:'mainTab:form4:j_id_3p_1km:0:j_id_3p_1ko',update:'mainTab:form4:dmd_section_body'});return false;">Autre(01)</a>

so we got this appear visible : <span id="mainTab:form4:dmd_details"><div id="mainTab:form4:j_id_3p_1l8" class="ui-panel ui-widget ui-widget-content ui-corner-all ui-widget-header-3"><div id="mainTab:form4:j_id_3p_1l8_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">&nbsp;</span></div><div id="mainTab:form4:j_id_3p_1l8_content" class="ui-panel-content ui-widget-content"><table id="mainTab:form4:j_id_3p_1l9" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 20%" class="rubrique">
Demande

</td><td role="gridcell"><div id="mainTab:form4:demandeSelectId" class="ui-selectonemenu ui-widget ui-state-default ui-corner-all ui-helper-clearfix" style="width:150px"><div class="ui-helper-hidden"><select id="mainTab:form4:demandeSelectId_input" name="mainTab:form4:demandeSelectId_input"><option value="">Choisir une demande</option><option value="01#~#Autre(01)" selected="selected">Autre(01)</option></select></div><div class="ui-helper-hidden-accessible"><input id="mainTab:form4:demandeSelectId_focus" name="mainTab:form4:demandeSelectId_focus" type="text"></div><label id="mainTab:form4:demandeSelectId_label" class="ui-selectonemenu-label ui-inputfield ui-corner-all" style="width: 134.222px;">Autre(01)</label><div class="ui-selectonemenu-trigger ui-state-default ui-corner-right"><span class="ui-icon ui-icon-triangle-1-s"></span></div></div></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique">
Données paramètres
</td><td role="gridcell"><textarea id="mainTab:form4:j_id_3p_1ll" name="mainTab:form4:j_id_3p_1ll" cols="41" rows="4" class="ui-inputfield ui-inputtextarea ui-widget ui-state-default ui-corner-all ui-inputtextarea-resizable" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="true">NS SOLL ACH. DE RAM A MEAD MED AFRICA  / Scellés N°09199433-09199434</textarea></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" style="text-align : center" colspan="2">
				<div align="center">
					<br><button id="mainTab:form4:btnConfirmerDmd" name="mainTab:form4:btnConfirmerDmd" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" onclick="PrimeFaces.ab({source:'mainTab:form4:btnConfirmerDmd',process:'mainTab:form4:btnConfirmerDmd mainTab:form4:dmd_details',update:'mainTab:form4:dmd_section_body',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Confirmer</span></button>
					&nbsp;
					<button id="mainTab:form4:j_id_3p_1lr" name="mainTab:form4:j_id_3p_1lr" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" onclick="PrimeFaces.ab({source:'mainTab:form4:j_id_3p_1lr',process:'mainTab:form4:j_id_3p_1lr',update:'mainTab:form4:dmd_details'});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Rétablir</span></button>
					<br>
				</div></td></tr></tbody></table></div></div></span>

here exactly in this input : <textarea id="mainTab:form4:j_id_3p_1ll" name="mainTab:form4:j_id_3p_1ll" cols="41" rows="4" class="ui-inputfield ui-inputtextarea ui-widget ui-state-default ui-corner-all ui-inputtextarea-resizable" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="true">NS SOLL ACH. DE RAM A MEAD MED AFRICA / Scellés N°09199433-09199434</textarea>

we edit the scellés by our current LTA scéllés by letting also the text edit only scelles number
then click on "Confirmer" :<button id="mainTab:form4:btnConfirmerDmd" name="mainTab:form4:btnConfirmerDmd" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" onclick="PrimeFaces.ab({source:'mainTab:form4:btnConfirmerDmd',process:'mainTab:form4:btnConfirmerDmd mainTab:form4:dmd_details',update:'mainTab:form4:dmd_section_body',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Confirmer</span></button>

then click on Sauvegarder again

now we navigate to "Articles" tab :<a href="#mainTab:tab1">Articles</a>
so we got this :

<div class="ui-datatable-tablewrapper"><table role="grid"><thead id="mainTab:form1:j_id_3p_zn_head"><tr role="row"><th id="mainTab:form1:j_id_3p_zn:j_id_3p_zo" class="ui-state-default" role="columnheader"><span>N°</span></th><th id="mainTab:form1:j_id_3p_zn:j_id_3p_zq" class="ui-state-default" role="columnheader"><span>Code cont.</span></th><th id="mainTab:form1:j_id_3p_zn:j_id_3p_zs" class="ui-state-default" role="columnheader"><span>Nb. cont.</span></th><th id="mainTab:form1:j_id_3p_zn:j_id_3p_zu" class="ui-state-default" role="columnheader"><span>Code NGP</span></th><th id="mainTab:form1:j_id_3p_zn:j_id_3p_zw" class="ui-state-default" role="columnheader"><span>Val. déclarée</span></th><th id="mainTab:form1:j_id_3p_zn:j_id_3p_zy" class="ui-state-default" role="columnheader"><span>Qté facturée</span></th><th id="mainTab:form1:j_id_3p_zn:j_id_3p_100" class="ui-state-default" role="columnheader"><span>Unité</span></th><th id="mainTab:form1:j_id_3p_zn:j_id_3p_102" class="ui-state-default" role="columnheader"><span>issu ATPA</span></th></tr></thead><tfoot></tfoot><tbody id="mainTab:form1:j_id_3p_zn_data" class="ui-datatable-data ui-widget-content"><tr data-ri="0" class="ui-widget-content ui-datatable-even" role="row"><td role="gridcell"><a id="mainTab:form1:j_id_3p_zn:0:cmdLinkEditArticle" href="#" class="ui-commandlink ui-widget tableScroll notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form1:j_id_3p_zn:0:cmdLinkEditArticle',process:'mainTab:form1:j_id_3p_zn:0:cmdLinkEditArticle',update:'mainTab:form1:article_details mainTab:form1:actionsPanelArticles'});return false;">1</a></td><td role="gridcell"><span class="tableScroll">216</span></td><td role="gridcell"><span class="tableScroll">83</span></td><td role="gridcell"><span class="tableScroll">9999999999</span></td><td role="gridcell"><span class="tableScroll">343645.000</span></td><td role="gridcell"><span class="tableScroll">2083.000</span></td><td role="gridcell"><span class="tableScroll">002</span></td><td role="gridcell"><span class="tableScroll">Non</span></td></tr></tbody></table></div>

we click on link "1" N° :<a id="mainTab:form1:j_id_3p_zn:0:cmdLinkEditArticle" href="#" class="ui-commandlink ui-widget tableScroll notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form1:j_id_3p_zn:0:cmdLinkEditArticle',process:'mainTab:form1:j_id_3p_zn:0:cmdLinkEditArticle',update:'mainTab:form1:article_details mainTab:form1:actionsPanelArticles'});return false;">1</a>
so when we click we got appear a form in bottom :

<div id="mainTab:form1:j_id_3p_10n" class="ui-panel ui-widget ui-widget-content ui-corner-all ui-widget-header-3"><div id="mainTab:form1:j_id_3p_10n_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">
	N° Ordre de l'article : 
					1</span></div><div id="mainTab:form1:j_id_3p_10n_content" class="ui-panel-content ui-widget-content"><table id="mainTab:form1:j_id_3p_10q" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell"><div id="mainTab:form1:j_id_3p_10t" class="ui-panel ui-widget ui-widget-content ui-corner-all ui-widget-header-2"><div id="mainTab:form1:j_id_3p_10t_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Contenant</span></div><div id="mainTab:form1:j_id_3p_10t_content" class="ui-panel-content ui-widget-content"><span id="mainTab:form1:typeContenantPanel"><table id="mainTab:form1:j_id_3p_10v" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell"><table id="mainTab:form1:j_id_3p_10y" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 20%" class="rubrique rubrique">
								Nature
								</td><td role="gridcell"><span id="mainTab:form1:typeContenantId_FOCUS"></span><span id="mainTab:form1:typeContenantId_PANEL"><span id="mainTab:form1:typeContenantId"><span id="mainTab:form1:typeContenantId_INPUT" class="ui-autocomplete " style=""><input id="mainTab:form1:typeContenantId_INPUT_input" name="mainTab:form1:typeContenantId_INPUT_input" type="text" class="ui-autocomplete-input ui-inputfield ui-widget ui-state-default ui-corner-all" autocomplete="off" value="COLIS(216)" size="20" onkeydown="return disableCtrlKeyCombination(this,event);" onkeypress="return disableCtrlKeyCombination(this,event);" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"><input id="mainTab:form1:typeContenantId_INPUT_hinput" name="mainTab:form1:typeContenantId_INPUT_hinput" type="hidden" autocomplete="off" value="216#~#COLIS(216)"></span></span>
		
				
				<div style="display: inline-block;vertical-align: center">
				<span id="supprimer"><a id="mainTab:form1:typeContenantId_supprimer" href="#" class="ui-commandlink ui-widget " onclick="PrimeFaces.ab({source:'mainTab:form1:typeContenantId_supprimer',process:'mainTab:form1:typeContenantId_supprimer',update:'mainTab:form1:typeContenantId mainTab:form1:typeContenantPanel',global:false,onsuccess:function(data,status,xhr){disableInput();},oncomplete:function(xhr,status,args){disableInput();}});return false;" style="display : inline-block">
			
					 <span class="ui-icon ui-icon-closethick"></span></a>
				
				</span>
				</div></span></td><td role="gridcell" class="rubrique rubrique">
								Nombre
								</td><td role="gridcell"><input id="mainTab:form1:nbrContenantsId" name="mainTab:form1:nbrContenantsId" type="text" value="83" maxlength="6" size="9" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td></tr></tbody></table></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell"><table id="mainTab:form1:panelContenants" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 20%" class="rubrique rubrique">
													Marques
													</td><td role="gridcell"><input id="mainTab:form1:marqueContenants" name="mainTab:form1:marqueContenants" type="text" value="LTA 607-52061450" maxlength="64" style="width:458px" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td></tr></tbody></table></td></tr></tbody></table></span></div></div><div id="mainTab:form1:j_id_3p_122" class="ui-panel ui-widget ui-widget-content ui-corner-all ui-widget-header-2"><div id="mainTab:form1:j_id_3p_122_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Marchandise</span></div><div id="mainTab:form1:j_id_3p_122_content" class="ui-panel-content ui-widget-content"><table id="mainTab:form1:j_id_3p_123" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 56px" class="rubrique rubrique">
							Code NGP
							</td><td role="gridcell"><table id="mainTab:form1:j_id_3p_128" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell"><input id="mainTab:form1:refNgpId" name="mainTab:form1:refNgpId" type="text" value="9999999999" maxlength="10" size="14" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false">

    											&nbsp;
    											<button id="mainTab:form1:btnOkNgp" name="mainTab:form1:btnOkNgp" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" onclick="PrimeFaces.ab({source:'mainTab:form1:btnOkNgp',process:'mainTab:form1:btnOkNgp mainTab:form1:refNgpId',update:'mainTab:form1:libelleNgpId mainTab:form1:uniteNormaliseeId mainTab:form1:libelleUniteNormaliseeId',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">OK</span></button></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell">
    											<span class="tableScroll" style="Height: 60px;"><span id="mainTab:form1:libelleNgpId">-Pour des besoins spécifiques.

</span>
												</span></td></tr></tbody></table></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique rubrique" colspan="2">
						Désignation Commerciale
						</td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique" colspan="2">
									<div align="center"><textarea id="mainTab:form1:desCommerciale" name="mainTab:form1:desCommerciale" cols="100" rows="2" class="ui-inputfield ui-inputtextarea ui-widget ui-state-default ui-corner-all ui-inputtextarea-resizable" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="true">COURIERE EXPRESSE</textarea>
									</div></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique rubrique">
							pays d'origine
							</td><td role="gridcell">
									<span id="combo_paysOrigine"><span id="mainTab:form1:combo_paysOrigine_ac_FOCUS"></span><span id="mainTab:form1:combo_paysOrigine_ac_PANEL"><span id="mainTab:form1:combo_paysOrigine_ac"><span id="mainTab:form1:combo_paysOrigine_ac_INPUT" class="ui-autocomplete " style=""><input id="mainTab:form1:combo_paysOrigine_ac_INPUT_input" name="mainTab:form1:combo_paysOrigine_ac_INPUT_input" type="text" class="ui-autocomplete-input ui-inputfield ui-widget ui-state-default ui-corner-all ui-state-disabled" autocomplete="off" value="CHINE(CN)" disabled="disabled" size="20" onkeydown="return disableCtrlKeyCombination(this,event);" onkeypress="return disableCtrlKeyCombination(this,event);"><input id="mainTab:form1:combo_paysOrigine_ac_INPUT_hinput" name="mainTab:form1:combo_paysOrigine_ac_INPUT_hinput" type="hidden" autocomplete="off" value="CN#~#CHINE(CN)"><div id="mainTab:form1:combo_paysOrigine_ac_INPUT_panel" class="ui-autocomplete-panel ui-widget-content ui-corner-all ui-helper-hidden ui-shadow"></div></span></span>
		
				
				<div style="display: inline-block;vertical-align: center">
				<span id="supprimer">
				
				</span>
				</div></span>

    								</span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique rubrique">
    						Paiement
    						</td><td role="gridcell"><table id="mainTab:form1:paiement_radio_id1" class="ui-selectoneradio ui-widget"><tbody><tr><td><div class="ui-radiobutton ui-widget"><div class="ui-helper-hidden-accessible"><input id="mainTab:form1:paiement_radio_id1:0" name="mainTab:form1:paiement_radio_id1" type="radio" value="true"></div><div class="ui-radiobutton-box ui-widget ui-corner-all ui-state-default"><span class="ui-radiobutton-icon"></span></div></div></td><td><label for="mainTab:form1:paiement_radio_id1:0">Avec</label></td><td><div class="ui-radiobutton ui-widget"><div class="ui-helper-hidden-accessible"><input id="mainTab:form1:paiement_radio_id1:1" name="mainTab:form1:paiement_radio_id1" type="radio" value="false" checked="checked"></div><div class="ui-radiobutton-box ui-widget ui-corner-all ui-state-default ui-state-active"><span class="ui-radiobutton-icon ui-icon ui-icon-bullet"></span></div></div></td><td><label for="mainTab:form1:paiement_radio_id1:1">Sans</label></td></tr></tbody></table></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique">
    						Occasion
    						</td><td role="gridcell"><div id="mainTab:form1:j_id_3p_13k" class="ui-chkbox ui-widget"><div class="ui-helper-hidden-accessible"><input id="mainTab:form1:j_id_3p_13k_input" name="mainTab:form1:j_id_3p_13k_input" type="checkbox"></div><div class="ui-chkbox-box ui-widget ui-corner-all ui-state-default"><span class="ui-chkbox-icon ui-c"></span></div></div></td></tr></tbody></table></div></div><div id="mainTab:form1:j_id_3p_13l" class="ui-panel ui-widget ui-widget-content ui-corner-all ui-widget-header-2"><div id="mainTab:form1:j_id_3p_13l_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Valeur et Quantités</span></div><div id="mainTab:form1:j_id_3p_13l_content" class="ui-panel-content ui-widget-content"><table id="mainTab:form1:j_id_3p_13m" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 50%"><table id="mainTab:form1:j_id_3p_13p" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 40%" class="rubrique"><label class="rubrique">Valeur déclarée(en Dhs)</label></td><td role="gridcell"><span id="mainTab:form1:valDecNumber" class="ui-inputNum ui-widget"><input id="mainTab:form1:valDecNumber_input" name="mainTab:form1:valDecNumber_input" type="text" maxlength="14" style="width:90" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all"><input id="mainTab:form1:valDecNumber_hinput" name="mainTab:form1:valDecNumber_hinput" type="hidden" autocomplete="off" value="343645"></span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique"><label class="rubrique">Quantité facturée</label></td><td role="gridcell"><span id="mainTab:form1:qteNumber" class="ui-inputNum ui-widget"><input id="mainTab:form1:qteNumber_input" name="mainTab:form1:qteNumber_input" type="text" maxlength="14" style="width:90" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all"><input id="mainTab:form1:qteNumber_hinput" name="mainTab:form1:qteNumber_hinput" type="hidden" autocomplete="off" value="2083"></span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique"><span class="rubrique">Poids net (en kg)</span></td><td role="gridcell"><span id="mainTab:form1:poidNetNumber" class="ui-inputNum ui-widget"><input id="mainTab:form1:poidNetNumber_input" name="mainTab:form1:poidNetNumber_input" type="text" maxlength="14" style="width:90" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all"><input id="mainTab:form1:poidNetNumber_hinput" name="mainTab:form1:poidNetNumber_hinput" type="hidden" autocomplete="off" value="1603"></span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique"><span class="rubrique">Quantité normalisée</span></td><td role="gridcell"><span id="mainTab:form1:qteNormaliseeNumber" class="ui-inputNum ui-widget"><input id="mainTab:form1:qteNormaliseeNumber_input" name="mainTab:form1:qteNormaliseeNumber_input" type="text" maxlength="14" style="width:90" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all"><input id="mainTab:form1:qteNormaliseeNumber_hinput" name="mainTab:form1:qteNormaliseeNumber_hinput" type="hidden" autocomplete="off" value="1603"></span></td></tr></tbody></table></td><td role="gridcell"><table id="mainTab:form1:j_id_3p_14b" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="height:30px;" colspan="2"></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique"><label class="rubrique">Unité de quantité</label></td><td role="gridcell"><span id="mainTab:form1:id_uniteQteAC_FOCUS"></span><span id="mainTab:form1:id_uniteQteAC_PANEL"><span id="mainTab:form1:id_uniteQteAC"><span id="mainTab:form1:id_uniteQteAC_INPUT" class="ui-autocomplete " style=""><input id="mainTab:form1:id_uniteQteAC_INPUT_input" name="mainTab:form1:id_uniteQteAC_INPUT_input" type="text" class="ui-autocomplete-input ui-inputfield ui-widget ui-state-default ui-corner-all" autocomplete="off" value="NOMBRE(002)" size="20" onkeydown="return disableCtrlKeyCombination(this,event);" onkeypress="return disableCtrlKeyCombination(this,event);" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"><input id="mainTab:form1:id_uniteQteAC_INPUT_hinput" name="mainTab:form1:id_uniteQteAC_INPUT_hinput" type="hidden" autocomplete="off" value="002#~#NOMBRE(002)"></span></span>


    			<div style="display: inline-block;vertical-align: center">
    			<span id="supprimer"><a id="mainTab:form1:id_uniteQteAC_supprimer" href="#" class="ui-commandlink ui-widget " onclick="PrimeFaces.ab({source:'mainTab:form1:id_uniteQteAC_supprimer',process:'mainTab:form1:id_uniteQteAC_supprimer',update:'mainTab:form1:id_uniteQteAC',global:false,onsuccess:function(data,status,xhr){disableInput();},oncomplete:function(xhr,status,args){disableInput();}});return false;" style="display : inline-block">

    				 <span class="ui-icon ui-icon-closethick"></span></a>

    			</span>
    			</div></span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" style="height:30px;" colspan="2"></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique"><span class="rubrique">Unité de quantité normalisée</span></td><td role="gridcell"><span id="mainTab:form1:uniteNormaliseeId">: </span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique" colspan="2"><span id="mainTab:form1:libelleUniteNormaliseeId"></span></td></tr></tbody></table></td></tr></tbody></table><table id="mainTab:form1:j_id_3p_152" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width: 17%;" class="rubrique">CIN Destinataire</td><td role="gridcell" style="width: 33%;"><input id="mainTab:form1:cinDestID" name="mainTab:form1:cinDestID" type="text" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td><td role="gridcell" style="width: 17%;" class="rubrique">Nom et Prénom Destinataire</td><td role="gridcell" style="width: 33%;"><input id="mainTab:form1:nomPrenomDestID" name="mainTab:form1:nomPrenomDestID" type="text" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td></tr></tbody></table></div></div><div id="mainTab:form1:franchisePanel" class="ui-panel ui-widget ui-widget-content ui-corner-all ui-widget-header-2"><div id="mainTab:form1:franchisePanel_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Accord et Franchise</span></div><div id="mainTab:form1:franchisePanel_content" class="ui-panel-content ui-widget-content"><table id="mainTab:form1:j_id_3p_15d" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 20%" class="rubrique rubrique">
    						Code Accord
    						</td><td role="gridcell"><div id="mainTab:form1:selectAccord" class="ui-selectonemenu ui-widget ui-state-default ui-corner-all ui-helper-clearfix" style="width: 220px;"><div class="ui-helper-hidden"><select id="mainTab:form1:selectAccord_input" name="mainTab:form1:selectAccord_input"><option value="">Choisir un code accord</option><option value="USA">MAROC - ETATS-UNIS(USA)</option><option value="QUAD">MAROC - QUAD(QUAD)</option><option value="SPCOCI">MAROC - SPC-OCI(SPCOCI)</option><option value="TR">MAROC - TURQUIE(TR)</option><option value="ZLECAF">MAROC - ZLECAF(ZLECAF)</option><option value="AELE">MAROC-AELE(AELE)</option><option value="DZ">MAROC-ALGERIE(DZ)</option><option value="SA">MAROC-ARABIE SAOUDITE(SA)</option><option value="EG">MAROC-EGYPTE(EG)</option><option value="AE">MAROC-EMIRATS ARABES UNIS(AE)</option><option value="GN">MAROC-GUINEE(GN)</option><option value="IQ">MAROC-IRAQ(IQ)</option><option value="JO">MAROC-JORDANIE(JO)</option><option value="LY">MAROC-LIBYE(LY)</option><option value="LA">MAROC-LIGUE ARABE(LA)</option><option value="MR">MAROC-MAURITANIE(MR)</option><option value="PMA">MAROC-PAYS MOINS AVANCES(PMA)</option><option value="QA">MAROC-QATAR(QA)</option><option value="SN">MAROC-SENEGAL(SN)</option><option value="TN">MAROC-TUNISIE(TN)</option><option value="UE">MAROC-UE(UE)</option><option value="UK">MAROC-UK(UK)</option></select></div><div class="ui-helper-hidden-accessible"><input id="mainTab:form1:selectAccord_focus" name="mainTab:form1:selectAccord_focus" type="text"></div><label id="mainTab:form1:selectAccord_label" class="ui-selectonemenu-label ui-inputfield ui-corner-all" style="width: 204.222px;">Choisir un code accord</label><div class="ui-selectonemenu-trigger ui-state-default ui-corner-right"><span class="ui-icon ui-icon-triangle-1-s"></span></div></div></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique rubrique">
    						Franchise et exonération
    						</td><td role="gridcell"><div id="mainTab:form1:selectFranchise" class="ui-selectonemenu ui-widget ui-state-default ui-corner-all ui-helper-clearfix select-one-menu-over-flow" style="width : 400px"><div class="ui-helper-hidden"><select id="mainTab:form1:selectFranchise_input" name="mainTab:form1:selectFranchise_input"><option value="">Choisir un code franchise</option><option value="1056">1056(Aéronefs destinés à être utilisés pour effectuer des services publics par des entreprises de transport aérien ainsi que leurs matériels et pièces de rechange)</option><option value="1089">1089(Aéronefs d'une capacité supérieure à cent (100) places, destinés à être utilisés pour effectuer des services publics par des entreprises de transport aérien , ainsi que leurs matériels et pièces de rechange)</option><option value="2019">2019(Aéronefs réservés au transport commercial aérien international régulier, ainsi que le matériel et les pièces de rechange destinés à la réparation de ces aéronefs)</option><option value="0021">0021(Aides financières non remboursables)</option><option value="1086">1086(Aliments de poissons importés par les professionnels du secteur de lélevage de poissons)</option><option value="2024">2024(Aliments et animaux destinés à usage exclusif aquacole : aliments destinés à l’alimentation des poissons et autres animaux aquatiques,alevins de poissons et larves des autres animaux aquatiques et les naissains de coquillage)</option><option value="1076">1076(Aliments pour bétails)</option><option value="1054">1054(Animaux vivants de l’espèce des camélidés)</option><option value="1053">1053(Animaux vivants des espèces bovine, ovine, caprine et chevaline, reproducteurs de races pures)</option><option value="1088">1088(Application du droit dimportation de 10% aux ufs de consommation (0407.21.00))</option><option value="0001">0001(Articles d’édition (cf. V.02.01 de la RDII))</option><option value="2004">2004(Autocars, camions et leurs biens d'équipement importés par les entreprises TIR)</option><option value="0034">0034(Bank Al Maghreb, hors monnaies ayant cours légal et tous métaux précieux)</option><option value="0035">0035(Bank Al Maghreb: monnaies ayant cours légal et tous métaux précieux)</option><option value="2029">2029(Bateaux de toute tonnage servant à la pêche maritime)</option><option value="1038">1038(Bateaux et matériels y afférent NON soumis à l’article 126-15-a du livre d’ass. et de recouv.)</option><option value="1039">1039(Bateaux et matériels y afférent soumis à l’article 126-15-a du livre d’ass. et de recouv.)</option><option value="1046">1046(Biens d’équipement acquis en exonération du Droit d’importation, de la TVA, la TPI et la TIC pour les importations réalisées dans le cadre d’une convention d’investissement, pendant 36 mois à compter de la première importation)</option><option value="1078">1078(Biens d'équipement acquis en exonération du Droit d’importation, la TPI et la TIC pour les importations réalisées dans le cadre d’une convention d’investissement, mais exclus de l'exonération de la TVA)</option><option value="2003">2003(Biens d'équipement destinés à l'enseignement privé ou à la formation professionnelle)</option><option value="2005">2005(Biens d'équipement importés par des ABNL pour personnes handicapées)</option><option value="1095">1095(Biens d’équipement, matériels et outillages importés dans le cadre du projet « Gazoduc Africain-Atlantique », ainsi que des parties, pièces détachées et accessoires destinés à ces biens d’équipement, matériels et outillages)</option><option value="2002">2002(Biens d'investissement)</option><option value="2018">2018(Biens, matériels et marchandises acquis par la Fondation Lalla Salma de prévention et traitement des cancers)</option><option value="2022">2022(Biens, matériels et marchandises acquis par la Fondation Mohamed V pour la solidarité)</option><option value="2020">2020(Biens, matériels et marchandises acquis par la Fondation Mohamed VI pour la protection de l’environnement)</option><option value="2021">2021(Biens, matériels et marchandises acquis par la Ligue marocaine pour la protection de l’enfance)</option><option value="2023">2023(Biens, matériels et marchandises importés par l’Institut de Recherche sur le Cancer)</option><option value="1096">1096(Biens, matériels et marchandises importés par ou pour le compte des Représentations de la Fédération Internationale de Football Association (FIFA) au Maroc et les organismes qui leurs sont affiliés)</option><option value="2008">2008(Biens, matériels importés par la BID)</option><option value="2007">2007(Biens mobiliers ou immobiliers pour Agence Bayt Mal Al Qods Acharif)</option><option value="1093">1093(Bureau programme pour la lutte contre le terrorisme et la formation en Afrique de l'UNOCT)</option><option value="1065">1065(Carburants, combusti. et lubrif pour la navig marit. intér. par les unités de la marine et de la gendar. royale, des douanes, de la sûr. nationale, les bat. de pêche artisanale, les eng de servitudes portuaires et les unit. de transp. maritime int.)</option><option value="1044">1044(Carburants, combustibles et lubrifiants pour navigation maritime)</option><option value="1080">1080(Carburants, combustibles et lubrifiants utilisés par les bateau de pêche côtière et hauturière)</option><option value="0024">0024(Cercueil et urnes (cf. V.02.31))</option><option value="1055">1055(Certains produits et matériels destinés à l’agriculture , exonérés de TVA (cf. la liste de la circulaire de la loi de finances pour l'année 2020))</option><option value="1085">1085(Certains produits et matériels destinés à l’agriculture, TVA de 10% (cf. la liste de la circulaire de la loi de finances pour l'année 2020))</option><option value="0016">0016(Changement de résidence)</option><option value="3001">3001(Combustibles (fuel oil lourd (FO n°2), houilles, coke de pétrole et gaz naturel), utilisés par l'ONE et destinés à la production de lénergie électrique dune puissance supérieure à 10 MW)</option><option value="0033">0033(Croissant rouge: biens d?équipement matériels et outillages)</option><option value="0032">0032(Croissant rouge, hors biens d?équipement matériels et outillages)</option><option value="1052">1052(Décortiqueuse de céréales et leurs parties et pièces détachées)</option><option value="1001">1001(Des huiles brutes de pétrole ou de minéraux bitumineux destinées au raffinage)</option><option value="2027">2027(Des viandes de bovins et de camélidés congelées importées par les Forces Armées Royales)</option><option value="1083">1083(DI minimum applicable aux produits relevant des positions tarifaires n°s 0402.10.12.00, 0402.21.19.00, Ex1001.90.90.10 (blé tendre biscuitier) et 1701.99.91.99)</option><option value="0020">0020(Dons)</option><option value="0015">0015(Dons reçus par les oeuvres de bienfaisance  (cf.V.02.27))</option><option value="0022">0022(Echantillons sans valeur marchande ainsi que les envois exceptionnels dépourvus de tout caractère commercial)</option><option value="1091">1091(Écoles américaines)</option><option value="0026">0026(Effets et objets mobiliers importés en suite d'un divorce)</option><option value="1033">1033(Engrais du chapitre 31- nitrate de potassium à usage d'engrais, phosphates de potassium à usage d'engrais, polyphosphates de potassium à usage d'engrais, salins de betterave, autres nitrates, matières fertilisantes et supports de culture)</option><option value="0031">0031(Entraide nationale)</option><option value="0014">0014(Envois destinés aux organismes internationaux siégeant au Maroc (cf. V.02.26))</option><option value="0006">0006(Equipements et matériel importés par les associations de Micro crédit, repris sur une liste dûment visée par la Direction du Trésor et des Finances Extérieures (cf. V.02.19 de la RDII))</option><option value="0002">0002(Films documentaires ou éducatifs (cf. V.02.04.03))</option><option value="1072">1072(Fioul lourd pour provinces sahariennes)</option><option value="0037">0037(Fondation Cheikh Khalifa Ibn Zaïd)</option><option value="0028">0028(Fondation Chekh Zaid Ibn Soltan)</option><option value="0009">0009(Fondation Hassan II pour la lutte contre le cancer)</option><option value="0040">0040(Fondation Mohammed VI des sciences et de la santé)</option><option value="2016">2016(Fondation Mohammed VI pour la promotion des uvres sociales des préposés religieux)</option><option value="2013">2013(fournitures scolaires, ainsi que les produits et matières entrant dans leur composition)</option><option value="0027">0027(Franchise royales ( cf art 164 a code))</option><option value="0003">0003(Franchise UNESCO (cf.V.02.06))</option><option value="0013">0013(Franchises diplomatiques (cf. V.02.26))</option><option value="1002">1002(Graines de betteraves à sucre)</option><option value="1031">1031(Graines de semences)</option><option value="0017">0017(Héritage)</option><option value="1070">1070(Huile d'olive vierge pour FAR)</option><option value="1079">1079(Importations dans le cadre de la convention Gazoduc)</option><option value="1069">1069(Importations Société Phosboucraâ)</option><option value="2030">2030(La Fondation Mohammed VI de promotion des œuvres sociales de l'éducation-formation  )</option><option value="1011">1011(Les aliments destinés à l'alimentation du bétail et des animaux de basse-cour)</option><option value="0010">0010(les armes et munitions et leurs parties et accessoires ainsi que les engins et les équipements militaires et leurs parties et accessoires importés par l'administration de la Défense Nationale ainsi que par administrations de la sécurité publique)</option><option value="2017">2017(Les biens, matériels et marchandises acquis par la Fondation Mohammed VI pour l'Edition du Saint Coran)</option><option value="1005">1005(Les billets de banque étrangers ainsi que les biens et matériels destinés à Bank Al Maghreb conformément aux missions qui lui sont dévolues)</option><option value="1043">1043(Les carburants, combustibles et lubrifiants devant être consommés au cours de navigations maritimes par les vedettes et canots de sauvetage de vie humaine relevant du Ministère Chargé des Pêches Maritimes)</option><option value="1064">1064(Les carburants, combustibles et lubrifiants, les vivres et provisions de bord nécessaires aux navigations maritimes et aériennes à destination de l’étranger)</option><option value="1063">1063(Les carburants, combustibles et lubrifiants utilisés par les navires et embarcations exploités par les madragues et les fermes aquacoles)</option><option value="0039">0039(Les chaises, les motocycles, les voitures ainsi que les outils et équipements automatiques, spécialement aménagées pour les personnes en situation de handicap tel que prévu par l’article 164-r du CDII)</option><option value="1092">1092(LES ECOLES BRITANIQUES)</option><option value="1062">1062(Les parties,produits, matières, accessoires et assortiments nécessaires à la fabrication des engins économiques suivants : voitures de tourisme, véhicules utilitaires légers, cyclomoteurs et vélos)</option><option value="2026">2026(Les œuvres et les objet d’art)</option><option value="1040">1040(Les viandes de volailles, de bovins, d’ovins et de camélidés importées pour le compte des Forces Armées Royales (FAR))</option><option value="0008">0008(Ligue Nationale de lutte contre les maladies cardio-vasculaires)</option><option value="1084">1084(MAC de certaines marchandises en provenance des ZFE)</option><option value="1090">1090(MAC de la voiture économique en provenance des Zones d'Accélération Industrielle)</option><option value="0012">0012(Marchandises en retour sur le territoire assujetti)</option><option value="1061">1061(Matériels, articles et documents importés par les entreprise d'assistance en escale)</option><option value="1042">1042(Matériels au sol et matériels d’instruction importés par certaines entreprises nationales de transport aérien)</option><option value="1068">1068(Matériels et autres pour entreprises étrangères de transport aérien)</option><option value="0011">0011(Matériels et équipements spéciaux ainsi que leurs parties et accessoires, importés par l’Administration de Défense Nationale et les administrations chargées de la sécurité publique)</option><option value="1050">1050(Matériels et matériaux destinés à l’irrigation (cf. la liste de la circulaire de la loi de finances pour l’année 2020))</option><option value="1057">1057(Matériels et matières premières destinés à une unité de production de farine alimentaire)</option><option value="1066">1066(Matériels et produits destinés à la lutte anti-acridienne)</option><option value="1041">1041(Matériels, matériaux et produits consommables destinés à la reconnaissance, à la recherche et à l’exploitation des hydrocarbures ainsi qu’aux activités annexes à celle-ci)</option><option value="1047">1047(Matériels, mobiliers et biens d’équipement nécessaires à l’exploitation normale des banques offshore et des sociétés holding offshore)</option><option value="1048">1048(Matériels, outillages et biens d’équipement neufs ou d’occasion dont l’importation par l’administration, importés au profit des lauréats de la formation professionnelle)</option><option value="0025">0025(Médicaments importés par des non résidents (cf. Note n° 19763/311 du 26/10/01))</option><option value="0023">0023(Objets d'art, trophées, médailles, insignes commémoratifs, obtenus par des résidents)</option><option value="1023">1023(Préparations utilisées dans l’alimentation des veaux)</option><option value="1024">1024(Produits, articles et appareils destinés à l’hémodialyse)</option><option value="2001">2001(Produits de la pêche maritime marocaine)</option><option value="1073">1073(Produits et matières pour la fabrication de la voiture économique)</option><option value="1074">1074(Produits et matières pour la fabrication de véhicules utilitaires légers)</option><option value="1075">1075(Produits et matières pour la fabrication des cyclomoteurs économiques)</option><option value="1077">1077(Produits pétroliers)</option><option value="1071">1071(Produits pétroliers pour provinces sahariennes)</option><option value="2015">2015(Produits pharmaceutiques, sang et ses dérivés)</option><option value="4012">4012(Réimportation de Marchandises initialement exportées après avoir acquis l'origine marocaine suite à leur transformation sous RED)</option><option value="1045">1045(rejets d'hydrocarbures)</option><option value="1049">1049(Rogues de morues et appâts, filets et engins de pêche et moteurs marins)</option><option value="1087">1087(Suspension de la perception du DI applicable aux lentilles (0713.40.90.10) et aux pois chiches (0713.20.90.10))</option><option value="0018">0018(Trousseaux élèves (cf. V.02.30))</option><option value="0019">0019(Trousseaux mariage (cf. V.02.30))</option><option value="0029">0029(Université Al Akhawayn d?Ifrane)</option><option value="1037">1037(Véhicules affectés à des transports touristiques)</option><option value="2014">2014(Voiture dite économique)</option></select></div><div class="ui-helper-hidden-accessible"><input id="mainTab:form1:selectFranchise_focus" name="mainTab:form1:selectFranchise_focus" type="text"></div><label id="mainTab:form1:selectFranchise_label" class="ui-selectonemenu-label ui-inputfield ui-corner-all" style="width: 384.222px;">Choisir un code franchise</label><div class="ui-selectonemenu-trigger ui-state-default ui-corner-right"><span class="ui-icon ui-icon-triangle-1-s"></span></div></div></td></tr></tbody></table></div></div><div id="mainTab:form1:controleOnssaId" class="ui-panel ui-widget ui-widget-content ui-corner-all ui-widget-header-2"><div id="mainTab:form1:controleOnssaId_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Produit soumis au contrôle de l’ONSSA</span></div><div id="mainTab:form1:controleOnssaId_content" class="ui-panel-content ui-widget-content"><table id="mainTab:form1:j_id_3p_15s_2" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 20%" class="rubrique">
    						Produit soumis au contrôle de l’ONSSA
    						</td><td role="gridcell"><table id="mainTab:form1:controleOnssaRadio" class="ui-selectoneradio ui-widget" style="margin-left:-8px"><tbody><tr><td><div class="ui-radiobutton ui-widget"><div class="ui-helper-hidden-accessible"><input id="mainTab:form1:controleOnssaRadio:0" name="mainTab:form1:controleOnssaRadio" type="radio" value="true"></div><div class="ui-radiobutton-box ui-widget ui-corner-all ui-state-default"><span class="ui-radiobutton-icon"></span></div></div></td><td><label for="mainTab:form1:controleOnssaRadio:0">Oui</label></td><td><div class="ui-radiobutton ui-widget"><div class="ui-helper-hidden-accessible"><input id="mainTab:form1:controleOnssaRadio:1" name="mainTab:form1:controleOnssaRadio" type="radio" value="false" checked="checked"></div><div class="ui-radiobutton-box ui-widget ui-corner-all ui-state-default ui-state-active"><span class="ui-radiobutton-icon ui-icon ui-icon-bullet"></span></div></div></td><td><label for="mainTab:form1:controleOnssaRadio:1">Non</label></td></tr></tbody></table></td></tr></tbody></table></div></div><span id="mainTab:form1:panelAglaci_articles"></span><div id="mainTab:form1:j_id_3p_1a1" class="ui-panel ui-widget ui-widget-content ui-corner-all ui-widget-header-2"><div id="mainTab:form1:j_id_3p_1a1_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Origine</span></div><div id="mainTab:form1:j_id_3p_1a1_content" class="ui-panel-content ui-widget-content"><table id="mainTab:form1:j_id_3p_1a2" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="width : 20%" class="rubrique rubrique">
    								Issu ATPA
    								</td><td role="gridcell"><div id="mainTab:form1:j_id_3p_1a7" class="ui-chkbox ui-widget"><div class="ui-helper-hidden-accessible"><input id="mainTab:form1:j_id_3p_1a7_input" name="mainTab:form1:j_id_3p_1a7_input" type="checkbox" disabled="disabled"></div><div class="ui-chkbox-box ui-widget ui-corner-all ui-state-default ui-state-disabled"><span class="ui-chkbox-icon ui-c"></span></div></div></td></tr></tbody></table></div></div><table id="mainTab:form1:j_id_3p_1a9" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique rubrique">
    						Propriété T.I.
    							<button id="mainTab:form1:btnOkTI" name="mainTab:form1:btnOkTI" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only " onclick="PrimeFaces.ab({source:'mainTab:form1:btnOkTI',process:'mainTab:form1:btnOkTI mainTab:form1:article_details',update:'mainTab:form1:panelListPTI mainTab:form1:libelleNgpId',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">OK</span></button><span id="mainTab:form1:j_id_3p_1ae">

    								<span class="color-red">(*)
    									Cette action sauvegarde l'article avant de calculer les P. TI</span></span></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell"><span id="mainTab:form1:panelListPTI"></span></td></tr></tbody></table><table id="mainTab:form1:j_id_3p_1bm" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="text-align : center"><button id="mainTab:form1:btnConfirmerArticle" name="mainTab:form1:btnConfirmerArticle" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only " onclick="PrimeFaces.ab({source:'mainTab:form1:btnConfirmerArticle',process:'mainTab:form1:btnConfirmerArticle mainTab:form1:article_details',update:'mainTab:form1:articles_section_body',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Confirmer</span></button>
    							    &nbsp;

    							    <button id="mainTab:form1:btnRetablirArticles" name="mainTab:form1:btnRetablirArticles" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" onclick="PrimeFaces.ab({source:'mainTab:form1:btnRetablirArticles',process:'mainTab:form1:btnRetablirArticles',update:'mainTab:form1:articles_section_body',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Rétablir</span></button></td></tr></tbody></table></td></tr></tbody></table></div></div>

in this form we start edit info with current LTA info :
for this input "Nombre" : <input id="mainTab:form1:nbrContenantsId" name="mainTab:form1:nbrContenantsId" type="text" value="83" maxlength="6" size="9" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false">
we enter the nbr contenant "nombreContenant" in our example its 76 "nombreContenant"

in this input "Marques" :<input id="mainTab:form1:marqueContenants" name="mainTab:form1:marqueContenants" type="text" value="LTA 607-52061450" maxlength="64" style="width:458px" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false">

we type LTA 65-46143985 "current ref"
and for this two inputs "Poids net (en kg)" and "Quantité normalisée" : <input id="mainTab:form1:poidNetNumber_input" name="mainTab:form1:poidNetNumber_input" type="text" maxlength="14" style="width:90" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all">
<input id="mainTab:form1:qteNormaliseeNumber_input" name="mainTab:form1:qteNormaliseeNumber_input" type="text" maxlength="14" style="width:90" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all">

wy enter our Total poid which is here "1275" based on our example : [Manifeste]
[2eme LTA] PDF "Manifeste 065-46143985.pdf" — extrait: réf 65-46143985, 76 colis, 1275 kg, devise MAD, valeur 144501.97":

and for this input "Quantité facturée" : <input id="mainTab:form1:qteNumber_input" name="mainTab:form1:qteNumber_input" type="text" maxlength="14" style="width:90" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all">
we enter the quantité facturé i will show you from where you can got it. if u see manifestPdfExtract.js and how it extract the valeur 144501.97 the quantité facturé is before this value its the first value for example nin this manifest Manifeste 065-46143985.pdf the bottom values are :
1618 144501,97 1275
so the script got this value 144501.97 as total value but 1618 this is the Quantité facturée
so the manifestPdfExtract.js should also extract "Quantité facturée" and put it in a input of the acheminement card so user could check it and correct it if script made mistake extracting

and for this input "Valeur déclarée(en Dhs)" : <span id="mainTab:form1:valDecNumber" class="ui-inputNum ui-widget"><input id="mainTab:form1:valDecNumber_input" name="mainTab:form1:valDecNumber_input" type="text" maxlength="14" style="width:90" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all"><input id="mainTab:form1:valDecNumber_hinput" name="mainTab:form1:valDecNumber_hinput" type="hidden" autocomplete="off" value="343645"></span>

we take a value entred by user initially "Fret value" its always in mawb file pdf "we could extratc it but the mawb LTA sometimes like its scaned not correct visually and not clear so we make an input on acheminement card called "Fret value" and let user enter it"
so we take this value in this example its : 10025.21
and we check currency "also for currency of MAWB sometimes not clear so user must select or type currency in new input called "MAWB Currency" not this devise MAD this is manifest currency not like mawb currency"
so we take 10025.21 and convert it from choosen currency (HKD, CNY, USD, ...) to MAD using api like this example in other app : // Exchange rate proxy (avoids CORS when fetching from browser)
// Priority: 1) BAM (Bank Al-Maghrib, official ADII rate)
// 2) frankfurter.dev blended (covers most major currencies)
// 3) openexchangerates.org cross-rate via USD (covers everything else)
const OXR_APP_ID = "2da90db00995499ea8ff537a94caf80c";
app.get("/exchange-rate", async (req, res) => {
const { from } = req.query;
if (!from) return res.status(400).json({ error: "from is required" });
const currency = from.toUpperCase().trim();
try {
const base = encodeURIComponent(currency);

    // 1st attempt: BAM (official Moroccan customs rate)
    let r = await fetch(
      `https://api.frankfurter.dev/v2/rate/${base}/MAD?providers=BAM`,
    );
    let data = r.ok ? await r.json() : null;
    if (data?.rate) return res.json({ rates: { MAD: data.rate } });

    // 2nd attempt: frankfurter.dev blended
    r = await fetch(`https://api.frankfurter.dev/v2/rate/${base}/MAD`);
    data = r.ok ? await r.json() : null;
    if (data?.rate) return res.json({ rates: { MAD: data.rate } });

    // 3rd attempt: openexchangerates.org cross-rate (USD base → FROM + MAD)
    r = await fetch(
      `https://openexchangerates.org/api/latest.json?app_id=${OXR_APP_ID}&symbols=${encodeURIComponent(currency)},MAD`,
    );
    if (r.ok) {
      const oxr = await r.json();
      const fromRate = oxr.rates?.[currency];
      const madRate = oxr.rates?.MAD;
      if (fromRate && madRate) {
        return res.json({ rates: { MAD: madRate / fromRate } });
      }
    }

    res.status(502).json({ error: `MAD rate not found for ${currency}` });

} catch (e) {
res.status(502).json({ error: e.message });
}
});

so we exchange the fret value "10025.21" from selected currency by user to MAD
so for example LTA MAWB currency is HKD and 1 HKD = 1,170766 MAD
so its 10025.21 \* 1,170766 = 11737.1750108
so we take 11737.1750108 and add it to the extracted valeur total by script initially which is valeur 144501.97
so 11737.1750108 + 144501.97 = 156239.14501
so put this result 156239 "if we have .5 or .[5-9] we majorate to 156240 if its 156239.1 or .2 or .3 or .4 we let it 156239" into this input "Valeur déclarée(en Dhs)" : <span id="mainTab:form1:valDecNumber" class="ui-inputNum ui-widget"><input id="mainTab:form1:valDecNumber_input" name="mainTab:form1:valDecNumber_input" type="text" maxlength="14" style="width:90" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all"><input id="mainTab:form1:valDecNumber_hinput" name="mainTab:form1:valDecNumber_hinput" type="hidden" autocomplete="off" value="343645"></span>

the we click on "Confimer" : <button id="mainTab:form1:btnConfirmerArticle" name="mainTab:form1:btnConfirmerArticle" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" onclick="PrimeFaces.ab({source:'mainTab:form1:btnConfirmerArticle',process:'mainTab:form1:btnConfirmerArticle mainTab:form1:article_details',update:'mainTab:form1:articles_section_body',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Confirmer</span></button>

then click on "Sauvegarder" again
after saving a link of print is visible "or wait until visible"

then click on "imprimer" : <a id="secure_imprimer" class="ui-menuitem-link ui-corner-all" href="javascript:void(0)" onclick="closeWindow = true;closeWindow = true;closeWindow = true;closeWindow = true;$('#secure_imprimer').hide(); onFileExport();;PrimeFaces.addSubmitParam('j_id_1g',{'secure_imprimer':'secure_imprimer'}).submit('j_id_1g');"><span class="ui-menuitem-icon ui-icon ui-icon-triangle-1-e"></span><span class="ui-menuitem-text">IMPRIMER</span></a>

and make it in downloads with name of "[12eme-acheminement|*eme-acheminement]-DUM-NORMAL-065-46143985"

all this should be same as ds combiné int term of logging checkpoints "data consistancy" if mismatch poid or something let error clear and go to next LTA
every info entred by user should be stored in json so user wont again enter it in each restart
for this Partiel LTA user will enter as data "Fret value", "LTA MAWB Currency"
script should iniialy extract "Quantité facturée" so edit also manifestPdfExtract.js to extract also the quantité facturé "because now it extract only total value "Valeur"" and put it in input in acheminement card "Quantité facturée" so user could check it if correct
"do fallbacks and tentative if some error not business error happened"
for compression use also this : compressPdfChain.js
