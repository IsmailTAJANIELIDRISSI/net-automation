# Portnet DS Combiné - Playwright Automation Specification

> **Stack:** Node.js + Playwright (headless: false)
> **Target Systems:** BADR (Selenium/Edge - certificate auth) + Portnet (Playwright/Chromium)

---

## Table of Contents

1. [Workflow Overview](#1-workflow-overview)
2. [User Input Data (All Required)](#2-user-input-data-all-required)
3. [Folder Structure Convention](#3-folder-structure-convention)
4. [Phase 1 — Data Extraction & Validation](#4-phase-1--data-extraction--validation)
5. [Phase 2 — BADR: Sequence Number Lookup](#5-phase-2--badr-sequence-number-lookup)
6. [Phase 3 — BADR: Weight Verification (Préapurement DS)](#6-phase-3--badr-weight-verification-préapurement-ds)
7. [Phase 4 — Portnet: Login](#7-phase-4--portnet-login)
8. [Phase 5 — Portnet: DS Combiné Form (Entête)](#8-phase-5--portnet-ds-combiné-form-entête)
9. [Phase 6 — Portnet: Annexe (PDF Upload)](#9-phase-6--portnet-annexe-pdf-upload)
10. [Phase 7 — Portnet: Demandes Diverses (Scellés)](#10-phase-7--portnet-demandes-diverses-scellés)
11. [Phase 8 — Final Confirmation (Manual)](#11-phase-8--final-confirmation-manual)
12. [Error Handling & Email Notifications](#12-error-handling--email-notifications)
13. [Constants & Selectors Reference](#13-constants--selectors-reference)

---

## 1. Workflow Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        AUTOMATION FLOWCHART                         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   START: User selects acheminement folder                            │
│     │                                                                │
│     ▼                                                                │
│   Extract LTA Ref from MAWB filename (e.g. "607-52839835")          │
│     │                                                                │
│     ▼                                                                │
│   User inputs ALL data manually (scellés, currency, montant, etc.)  │
│     │                                                                │
│     ▼                                                                │
│   ┌─ Sequence number provided? ─┐                                   │
│   │                              │                                   │
│   │ NO                           │ YES                               │
│   ▼                              ▼                                   │
│   Go to BADR:               Skip BADR                               │
│   Search sequence            sequence lookup                         │
│   │                              │                                   │
│   ▼                              │                                   │
│   ┌─ Sequence found? ─┐         │                                   │
│   │                     │        │                                   │
│   │ NO                  │ YES    │                                   │
│   ▼                     ▼        │                                   │
│   📧 Email:           Get Lieu   │                                   │
│   "Pas encours         de        │                                   │
│    manifest"         chargement  │                                   │
│   ── STOP ──            │        │                                   │
│                         ▼        │                                   │
│                    Check weight on BADR Préapurement DS              │
│                         │                                            │
│                         ▼                                            │
│                    ┌─ Weight difference? ─┐                          │
│                    │         │             │                          │
│                    │ >20kg   │ ≤20kg       │ Match (0)               │
│                    ▼         ▼             ▼                         │
│                  ⚠️ LTA    📧 Email     Continue                    │
│                  Partiel   Abdelhak:    to Portnet                   │
│                  Skip &    "Vérifier      │                          │
│                  notify    le poid"       │                          │
│                  ─ STOP ─  ─ STOP ─       │                          │
│                                           ▼                          │
│                              Fill Portnet DS Combiné form            │
│                                           │                          │
│                                           ▼                          │
│                              Upload compressed PDFs (Annexe)         │
│                                           │                          │
│                                           ▼                          │
│                              Fill Demandes Diverses (scellés)        │
│                                           │                          │
│                                           ▼                          │
│                              ⏸️  PAUSE — User confirmation required  │
│                                           │                          │
│                                           ▼                          │
│                              Manual: Click "Envoyer"                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. User Input Data (All Required)

Every acheminement requires the following data **entered by the user** at startup. Nothing is hardcoded or auto-derived from PDFs.

### Per-Acheminement Inputs

| # | Field | Type | Example | Description |
|---|-------|------|---------|-------------|
| 1 | **Acheminement Folder** | folder path | `9eme-acheminement/` | Contains 2 PDFs (Manifeste + MAWB/LTA) |
| 2 | **Scellé Import** | number (string) | `11742811` | Numéro de scellé de conteneur (import) |
| 3 | **Scellé Export** | number (string) | `11742812` | Numéro de scellé de conteneur (export) |
| 4 | **Nombre Contenant** | integer | `2` | Number of containers for this acheminement |
| 5 | **Poids Total (Kg)** | decimal | `1250.50` | Total gross weight in kilograms |
| 6 | **Currency** | `MAD` or `USD` | `MAD` | Currency of the total value |
| 7 | **Total Value (Montant)** | decimal | `14569.98` | Monetary value from Manifeste PDF |
| 8 | **Sequence Number** | string or `null` | `3064 A` | If known; if `null` → script looks it up on BADR |
| 9 | **Is Partiel** | checkbox/boolean | `false` | If `true` → skip this LTA entirely |

### Auto-Extracted Data (from folder contents)

| Field | Source | Example |
|-------|--------|---------|
| **LTA Reference** | Extracted from MAWB filename: `MAWB 607-52839835.pdf` → `607-52839835` | `607-52839835` |
| **Manifeste PDF path** | File matching `Manifeste *.pdf` in acheminement folder | `Manifeste 607-52839835.pdf` |
| **MAWB/LTA PDF path** | File matching `MAWB *.pdf` or `LTA *.pdf` in acheminement folder | `MAWB 607-52839835.pdf` |

### Global Configuration (one-time setup via `.env`)

| Variable | Description | Example |
|----------|-------------|---------|
| `PORTNET_USERNAME` | Portnet login username | `GN41473` |
| `PORTNET_PASSWORD` | Portnet login password | `********` |
| `BADR_PASSWORD` | BADR system password | `********` |
| `EDGE_PATH` | Path to msedge.exe | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| `DRIVER_PATH` | Path to msedgedriver.exe | `C:\Users\pc\Downloads\edgedriver_win64\msedgedriver.exe` |
| `EMAIL_RECIPIENTS` | Comma-separated email list for notifications | `abdelhak@company.ma,ops@company.ma` |

---

## 3. Folder Structure Convention

```
acheminements/
├── 1er-acheminement/
│   ├── Manifeste 607-52839835.pdf
│   └── MAWB 607-52839835.pdf
├── 2eme-acheminement/
│   ├── Manifeste 235-95745543.pdf
│   └── MAWB 235-95745543.pdf
├── 9eme-acheminement/
│   ├── Manifeste 607-52839835.pdf
│   └── MAWB 607-52839835.pdf
└── ...
```

**Rules:**
- Each acheminement = 1 subfolder with exactly 2 PDFs
- MAWB filename pattern: `MAWB <reference>.pdf` (or `LTA <reference>.pdf`)
- Manifeste filename pattern: `Manifeste <reference>.pdf`
- The LTA reference is extracted from the MAWB/LTA filename (e.g. `607-52839835`)

---

## 4. Phase 1 — Data Extraction & Validation

### Step 1.1: Scan Acheminement Folders

```
For each subfolder in acheminements/:
  1. Find the MAWB/LTA PDF → extract reference from filename
  2. Find the Manifeste PDF → store path
  3. Validate both files exist
  4. If user marked "Partiel" → SKIP this folder (log: "LTA Partiel — skipped")
```

### Step 1.2: Validate User Inputs

```
For each acheminement:
  ✓ scellé_import is not empty
  ✓ scellé_export is not empty
  ✓ nombre_contenant > 0
  ✓ poids_total > 0
  ✓ currency is "MAD" or "USD"
  ✓ montant > 0
  ✓ LTA reference extracted successfully (format: XXX-XXXXXXXX)
  ✓ Both PDFs exist and are readable
```

---

## 5. Phase 2 — BADR: Sequence Number Lookup

> **Only if sequence number is NOT provided by user.**

### Step 2.1: Connect to BADR

- System: `https://badr.douane.gov.ma:40444/badr/Login`
- Browser: **Edge** (required for USB certificate authentication)
- Login: Password field `#connexionForm:pwdConnexionId` → click `#connexionForm:login`
- Handle active session: click `#connexionForm:sessionConnexionId` if present

### Step 2.2: Navigate to "Lot de dédouanement"

```
MISE EN DOUANE → Services → Recherche par référence → Lot de dédouanement
```

**Menu click path:**
1. Click `#_434` (Services)
2. Click `#_435` (Recherche par référence)
3. Click `#_437` (Lot de dédouanement)

This opens a **popup window** at:
`https://badr.douane.gov.ma:40444/badr/views/med/med_rech_ref_lot.xhtml?codeFonctionnalite=cf437&is_popup=true`

### Step 2.3: Fill Search Form

| Field | Selector | Value | Notes |
|-------|----------|-------|-------|
| Référence du Lot | `#j_id_1h:j_id_1p` | `{ltaReference}` | e.g. `607-52839835` |
| Période — du | `#j_id_1h:j_id_1v_input` | `{today - 6 days}` | Format: `dd/mm/yyyy` |
| Période — au | `#j_id_1h:j_id_1z_input` | `{today}` | Format: `dd/mm/yyyy` |
| Bureau | `#j_id_1h:burCmbId_INPUT_input` | `301` | Select: `CASA/NOUASSER-FRET(301)(301)` |
| Opérateur déclarant | `#j_id_1h:operateurCmbId_INPUT_input` | `cie national` | Select: `CIE NATIONALE ROYAL AIR MAROC(81/9667)` |
| Type de déclaration | `#j_id_1h:j_id_30_input` | `DS(01)` | Dropdown — select `data-label="DS(01)"` |
| Mode de transport | `#j_id_1h:j_id_36_input` | `AERIEN(02)` | Dropdown — select `data-label="AERIEN(02)"` |

Click **Valider**: `#j_id_1h:confirmButon`

### Step 2.4: Process Search Results

**Result table:** `#j_id_1h:ListelotdataTable`

| Scenario | Condition | Action |
|----------|-----------|--------|
| **No results** | Table not rendered or 0 rows | Send email: *"Pas encours manifest pour LTA {ref}"* → **STOP** |
| **1 row** | `Nombre d'enregistrements trouvés: 1` | **DS Combiné** → extract sequence + lieu de chargement → continue |
| **2+ rows** | `Nombre d'enregistrements trouvés: 2+` | **LTA Partiel** → skip this LTA → notify user |

### Step 2.5: Extract Data from Result Row

From the **first result row** in the declaration column:

```
Reference text: "301-000-2026-0003064-A"
                  │   │    │      │    │
                  │   │    │      │    └── Clé (key letter)
                  │   │    │      └── Sequence number (zero-padded)
                  │   │    └── Year
                  │   └── Régime
                  └── Bureau
```

**Extract:**
- **Sequence Number:** `3064` (strip leading zeros from `0003064`)
- **Clé:** `A`
- **Lieu de chargement:** from column "Lieu de (dé)chargement" (e.g. `ABOU DHABI INT`)

---

## 6. Phase 3 — BADR: Weight Verification (Préapurement DS)

### Step 3.1: Create Declaration on BADR

Navigate to: **DEDOUANEMENT → Créer une déclaration** (`#_2001`)

Fill declaration form (inside `#iframeMenu` iframe):

| Field | Value | Notes |
|-------|-------|-------|
| Bureau | `301` | Autocomplete — select suggestion |
| Régime | `010` | Autocomplete — select suggestion |
| Radio button | Formulaire vierge | `#rootForm:modeTransport_radioId1:0` (default checked) |
| Catégorie | `Normale` | Dropdown — select `data-label="Normale"` |

Click **Confirmer**: `#rootForm:btnConfirmer`

### Step 3.2: Navigate to Préapurement DS Tab

Click tab: `a[href='#mainTab:tab3']`

### Step 3.3: Fill Préapurement DS Form

Click **Nouveau**: `button[name*='btnNouveauPreap']`

| Field | Selector Pattern | Value |
|-------|-----------------|-------|
| Type DS | `div#mainTab\\:form3\\:typeDsId` dropdown | `DS(01)` |
| Bureau | `input[id*='bureauId']` | `301` |
| Régime | `input[id*='regimeId']` | `000` |
| Année | `input[id*='anneeId']` | `{current year}` |
| Série | `input[id*='serieId']` | `{sequence number}` (e.g. `3230`) |
| Clé | `input[id*='cleId']` | `{clé letter}` (e.g. `Y`) |
| Lieu de chargement | `input[id*='lieuChargCmb']` | `{lieu from BADR search}` |

Click **OK**: `button[id*='btnRefPreapOk']`

### Step 3.4: Weight Comparison Logic

After clicking OK, the system returns weight data:

- **Poids Brut (system):** `#mainTab:form3:poidLotId`
- **Nombre Contenants (system):** `#mainTab:form3:nbrContenantLotId`

Compare `poids_system` vs `poids_user` (user-entered weight):

```
difference = |poids_system - poids_user|

IF difference == 0:
    ✅ Match → Continue to Portnet (Phase 4)

ELSE IF difference ≤ 20 kg:
    📧 Email Abdelhak: "Merci de vérifier le poids total de LTA {ref}"
    ⛔ STOP processing this LTA

ELSE IF difference > 20 kg:
    ⚠️ LTA Partiel detected (first part of shipment only)
    📝 Log: "LTA {ref} is Partiel — weight diff: {difference}kg — SKIPPED"
    ⛔ STOP processing this LTA (skip until full shipment arrives)
```

---

## 7. Phase 4 — Portnet: Login

- **URL:** `https://www.portnet.ma/`
- **Browser:** Chromium via Playwright (headless: false)

### Step 4.1: Handle Popup

```javascript
// Close popup if exists
await page.locator('.closeP').click({ timeout: 5000 }).catch(() => {});
```

### Step 4.2: Fill Credentials

| Field | Selector | Value |
|-------|----------|-------|
| Username | `#j_username` | `{PORTNET_USERNAME}` |
| Password | `#j_password` | `{PORTNET_PASSWORD}` |

### Step 4.3: Manual CAPTCHA

```
⏸️ PAUSE — User must solve CAPTCHA and click LOGIN manually
```

Wait for authenticated URL:
```javascript
await page.waitForURL(url => url.toString().includes('cargo.portnet.ma/home'), { timeout: 120000 });
```

---

## 8. Phase 5 — Portnet: DS Combiné Form (Entête)

### Step 5.1: Navigate to DS Combiné Creation

```
URL: https://cargo.portnet.ma/dsCombine/nouvelle-creation
```

### Step 5.2: Fill "Numéro d'agrément" (Dialog Lookup)

1. Click the search icon on "Numéro d'agrément" field
2. In the dialog that opens:
   - Field: **Description** → type `MED AFRICA LOGISTICS`
   - Click **Rechercher** button
3. In results table, click the **Check (✓)** action button on the row with:
   - Code: `301326`
   - Description: `MEAD MED AFRICA LOGISTICS`

### Step 5.3: Fill Anticipation

| Field | Value |
|-------|-------|
| Anticipation | `Non` (select `data-value="0"`) |

### Step 5.4: Select Type DS Référence

| Field | Value |
|-------|-------|
| Type DS référence | `Maritime / Aérien` (select `data-value="01"`) |

### Step 5.5: DS de Référence Lookup (Dialog)

1. Click the **search icon** (🔍) next to DS de référence fields
2. In the dialog "Rechercher d'une DS de référence":
   - **Séquence:** `{sequence_number_zero_padded}` (e.g. `0003064`) — **numbers only, no letter**
   - **Type de DS référence:** select `Aerien`
3. Click **Rechercher**
4. In results table:
   - Navigate to the **last page** using pagination ("Go to last page" button)
   - Select the **last row** by clicking its **Check (✓)** action button

This auto-fills:
- DS de référence fields (Bureau: `301`, Régime: `000`, Année: current, Séquence, Clé)
- Bureau de départ: `CASA/NOUASSER-FRET(301)`
- Numéro de voyage (auto-populated)
- ETA (auto-populated)
- Mode de transport: `Aerien`
- Aerport (auto-populated from lieu de chargement)

### Step 5.6: Fill Remaining Fields

| Field | Selector Name | Value | Source |
|-------|--------------|-------|--------|
| Arrondissement | `idCombineArrondissement` | *(select appropriate)* | Constant |
| Lieu de stockage | `idLieuStockage` | *(select appropriate)* | Constant |
| Bureau de destination | *(read-only — auto-filled)* | — | Auto |
| Navire | *(read-only — auto-filled)* | — | Auto |
| Avec Moyen de transport | `withTransport` | `Oui` | Default (already set) |
| Pays de provenance | *(read-only — auto-filled)* | — | Auto |
| Pays de destination | *(read-only — auto-filled)* | — | Auto |
| Date Voyage | `dateVoyage` | *(auto-filled or enter)* | Auto |
| **Montant** | `montant` | `{user_entered_montant}` | **User input** |
| **Devise** | `deviseId` | `{user_entered_currency}` | **User input** (MAD or USD) |

---

## 9. Phase 6 — Portnet: Annexe (PDF Upload)

### Step 6.1: Compress PDFs

Before uploading, compress both PDFs to reduce file size.

### Step 6.2: Upload Documents

Navigate to the **Annexe** section/tab and upload:
1. Manifeste PDF (compressed)
2. MAWB/LTA PDF (compressed)

---

## 10. Phase 7 — Portnet: Demandes Diverses (Scellés)

### Step 7.1: Fill Scellés Section

Enter the container seal numbers:

| Field | Value | Source |
|-------|-------|--------|
| Scellé Import | `{scellé_import}` | **User input** (e.g. `11742811`) |
| Scellé Export | `{scellé_export}` | **User input** (e.g. `11742812`) |

---

## 11. Phase 8 — Final Confirmation (Manual)

```
┌─────────────────────────────────────────────────┐
│  ⏸️  AUTOMATION PAUSES HERE                      │
│                                                  │
│  The script has filled all forms and uploaded     │
│  all documents. The user must now:               │
│                                                  │
│  1. Review all filled data on screen             │
│  2. Manually click "Envoyer" to submit           │
│                                                  │
│  The script NEVER clicks "Envoyer" automatically │
└─────────────────────────────────────────────────┘
```

---

## 12. Error Handling & Email Notifications

### Email Templates

| Trigger | Recipients | Subject | Body |
|---------|-----------|---------|------|
| No sequence found on BADR | Operations team | `[PORTNET] Pas encours manifest — LTA {ref}` | No manifest entry found for LTA reference `{ref}`. Manual intervention required. |
| Weight diff ≤ 20kg | Abdelhak | `[PORTNET] Vérifier poids — LTA {ref}` | Merci de vérifier le poids total de LTA `{ref}`. Écart détecté: `{diff}` kg. Poids système: `{sys}`, Poids saisi: `{user}`. |
| Weight diff > 20kg (Partiel) | Operations team | `[PORTNET] LTA Partiel détecté — {ref}` | LTA `{ref}` semble être partiel (écart poids: `{diff}` kg). Traitement reporté. |

### Error Recovery

| Error | Action |
|-------|--------|
| BADR login timeout | Retry once, then stop with error log |
| Portnet CAPTCHA timeout (2 min) | Stop with message: "Authentication not detected" |
| PDF file missing | Skip acheminement, log error |
| BADR popup window fails to open | Retry with JavaScript click fallback |
| Form field not found | Log selector details, screenshot, continue to next acheminement |

---

## 13. Constants & Selectors Reference

### BADR Constants

| Constant | Value |
|----------|-------|
| Bureau code | `301` |
| Régime (search) | DS(01) |
| Régime (declaration) | `010` |
| Régime (préapurement) | `000` |
| Mode de transport | AERIEN(02) |
| Opérateur déclarant | `CIE NATIONALE ROYAL AIR MAROC(81/9667)` |
| Date range | Current date − 6 days → Current date |
| BADR URL | `https://badr.douane.gov.ma:40444/badr/Login` |

### Portnet Constants

| Constant | Value |
|----------|-------|
| Numéro d'agrément description | `MED AFRICA LOGISTICS` |
| Numéro d'agrément code | `301326` |
| Anticipation | `Non` |
| Type DS référence | `Maritime / Aérien` (value: `01`) |
| DS référence dialog — Type | `Aerien` |
| Portnet DS Combiné URL | `https://cargo.portnet.ma/dsCombine/nouvelle-creation` |

### Key Selectors — BADR

```
Login:
  Password field:        #connexionForm:pwdConnexionId
  Login button:          #connexionForm:login
  Active session link:   #connexionForm:sessionConnexionId

Menu (Lot de dédouanement):
  Services:              #_434
  Recherche par ref:     #_435
  Lot de dédouanement:   #_437

Search Form (popup):
  Référence du Lot:      #j_id_1h:j_id_1p
  Date du:               #j_id_1h:j_id_1v_input
  Date au:               #j_id_1h:j_id_1z_input
  Bureau:                #j_id_1h:burCmbId_INPUT_input
  Opérateur:             #j_id_1h:operateurCmbId_INPUT_input
  Type déclaration:      #j_id_1h:j_id_30_input
  Mode transport:        #j_id_1h:j_id_36_input
  Valider button:        #j_id_1h:confirmButon

Results:
  Data table:            #j_id_1h:ListelotdataTable
  Row link pattern:      #j_id_1h:ListelotdataTable:{index}:j_id_5v

Declaration (iframe #iframeMenu):
  Bureau autocomplete:   input.ui-autocomplete-input[role='textbox'] (1st)
  Régime autocomplete:   input.ui-autocomplete-input[role='textbox'] (2nd)
  Radio formulaire:      #rootForm:modeTransport_radioId1:0
  Confirmer button:      #rootForm:btnConfirmer

Préapurement DS:
  Tab link:              a[href='#mainTab:tab3']
  Nouveau button:        button containing 'btnNouveauPreap'
  Type DS dropdown:      div#mainTab\:form3\:typeDsId
  Bureau:                input[id*='bureauId']
  Régime:                input[id*='regimeId']
  Année:                 input[id*='anneeId']
  Série:                 input[id*='serieId']
  Clé:                   input[id*='cleId']
  Lieu chargement:       input[id*='lieuChargCmb']
  OK button:             button[id*='btnRefPreapOk']
  Poids brut (result):   #mainTab:form3:poidLotId
  Nbr contenants:        #mainTab:form3:nbrContenantLotId
```

### Key Selectors — Portnet

```
Login:
  Username:              #j_username
  Password:              #j_password
  Close popup:           .closeP

DS Combiné Form (Entête):
  Numéro d'agrément:     input#\:r2\: (readonly, click to open dialog)
  Anticipation:          [name="declarationAnticipation"] (select Non → data-value="0")
  Type DS référence:     [name="typeDSReference"] (Maritime / Aérien → data-value="01")
  DS ref search icon:    button inside .MuiGrid-grid-xs-2 with SearchOutlinedIcon
  Numéro de voyage:      input[name="numeroVoyage"]
  ETA:                   input[name="eta"]
  Arrondissement:        [name="idCombineArrondissement"]
  Lieu de stockage:      [name="idLieuStockage"]
  Mode de transport:     [name="modeTransport"]
  Avec Moyen transport:  [name="withTransport"]
  Date Voyage:           input[name="dateVoyage"]
  Montant:               input[name="montant"]
  Devise:                [name="deviseId"]

Agrement Dialog:
  Description input:     Dialog → input for "Description"
  Rechercher button:     Dialog → button containing "Rechercher"
  Result row action:     Cell data-field="action" → button with CheckIcon

DS Reference Dialog:
  Séquence:              input[name="sequence"]
  Type DS référence:     select[name="typeDsRef"] (Aerien)
  Rechercher button:     Dialog → button containing "Rechercher"
  Last page button:      button[aria-label="Go to last page"]
  Last row action:       .MuiDataGrid-row--lastVisible → action cell → button
```

---

## Processing Loop (Per Acheminement)

```
FOR each acheminement in acheminements_folder:

  1. VALIDATE inputs (all user data present)
  2. EXTRACT LTA reference from MAWB filename
  3. CHECK partiel flag → if true: SKIP

  4. IF sequence_number is NULL:
       a. LOGIN to BADR (if not already connected)
       b. SEARCH sequence on "Lot de dédouanement"
       c. IF no results → EMAIL "Pas encours manifest" → SKIP
       d. IF 2+ rows → mark as Partiel → SKIP
       e. EXTRACT sequence + clé + lieu_de_chargement

  5. VERIFY WEIGHT on BADR Préapurement DS:
       a. Create declaration (Bureau:301, Régime:010)
       b. Fill Préapurement DS form
       c. Compare weights:
          - Match     → ✅ continue
          - ≤20kg off → 📧 email Abdelhak → STOP
          - >20kg off → ⚠️ LTA Partiel → STOP

  6. LOGIN to Portnet (if not already connected)
     (Manual CAPTCHA required)

  7. FILL DS Combiné form:
       a. Numéro d'agrément lookup (MED AFRICA LOGISTICS)
       b. Anticipation → Non
       c. Type DS référence → Maritime / Aérien
       d. DS référence lookup (sequence → last page → last row)
       e. Fill Montant + Devise from user inputs

  8. UPLOAD PDFs to Annexe section

  9. FILL Demandes Diverses (scellés import + export)

  10. ⏸️ PAUSE — wait for user to review and click "Envoyer" manually

END FOR
```
