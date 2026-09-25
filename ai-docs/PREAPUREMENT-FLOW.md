# PREAPUREMENT-FLOW.md — BADR pré-apurement check: every outcome

_Source of truth: `src/badr/badrPreapurement.js` (the BADR clicks), `electron/main.js`
`prepareLotAndWeightCheck` (DS Combinée decisions), `src/badr/badrDumNormalPartiel.js`
`_step5_preapurement` + `main.js` `notifyPartielPoidsMismatch` (partiel decisions).
Last verified against the code on 2026-09-24._

## 1. What the pré-apurement check is for

Before an LTA is submitted, the app asks BADR what it actually knows about the lot: the
**Poids brut** and the **Nbre contenant(s)** of the lot found by the lot lookup. Those two
numbers are compared with what the operator/manifest declared (`poidTotal`,
`nombreContenant`). The comparison answers one business question: *has the whole shipment
arrived, and does the paperwork match it?* Depending on the answer the LTA continues
(to Portnet for a DS Combinée, to the next tab for a partiel), or it stops and an email
tells the operator exactly what to do. Everything below is the exact decision tree.

## 2. How the numbers are read from BADR (`badrPreapurement.js`)

`BADRPreapurement.getPoidsBrut(lotInfo, refNumber)` never touches a real declaration; it
opens a **throw-away "Créer une déclaration"** only to reach the *Préapurement DS* screen,
which is the only place BADR shows a lot's weight and container count. It runs four steps.
First it expands the DEDOUANEMENT menu and clicks *Créer une déclaration* (`#_2001`),
waiting for the form inside `#iframeMenu`. Second it fills Bureau (from config, 301),
Régime **010** and Catégorie **Normale** with `pressSequentially` (PrimeFaces
autocompletes ignore `fill`) and clicks *Confirmer*, which turns the iframe into the
declaration editor with its tabs. Third it opens the *Préapurement DS* tab, clicks
*Nouveau* and fills Type DS = DS(01), Bureau/Régime/Année of the lot, the série with
leading zeros stripped, the clé, the *Lieu de chargement* (autocomplete; takes the first
suggestion, or keeps the typed text with a warning if none appears) and the *Référence
lot* (the LTA reference with leading zeros normalized, e.g. `072-…` → `72-…`). Fourth it
clicks *OK*, waits 2 s and reads `#mainTab:form3:poidLotId` (weight) and
`#mainTab:form3:nbrContenantLotId` (container count). It returns
`{ poidsBrut, nombreContenants }` as trimmed strings — **no comparison happens in this
file**; it is purely a reader. If the weight element never appears it throws after the
configured timeout, which the caller reports as a generic error.

## 3. DS Combinée (non-partiel LTA): the decision tree

After the lot lookup gives one lot (an empty result becomes `waiting_manifest`; two or
more rows on a non-partiel card become the "DS Partiel détecté – ignoré" skip, before the
pré-apurement is ever reached), `prepareLotAndWeightCheck` calls the reader and parses
four numbers: BADR weight/colis and the operator's weight/colis (`poidMerged`,
`nombreMerged`, i.e. the manifest-extracted or typed values). If a value cannot be parsed
as a number, the check that needs it is skipped rather than failing.

**Colis are compared first.** The colis count decides which family of outcomes we are in.

**Case A — colis identical and weight identical.** The happy path. The log says
"Poids OK", the BADR weight is stored as `lotInfo.poidsBrut`, the LTA's `poidTotal` in
`acheminement.json` is rewritten with the BADR weight (so the card shows it), the
checkpoint moves to `badr_checked` and the run continues to Portnet submission. No email.

**Case B — colis identical, weight differs by 5 kg or less.** Treated as normal
weighing/rounding noise. The app logs "Écart de poids … (<= 5 kg) — continuation vers
Portnet", overwrites the declared weight with the **BADR weight** (BADR is authoritative
for everything downstream, including what is typed into Portnet), and continues. No email,
no stop. This is the "ignore ≤ 5 kg and take BADR's weight" rule.

**Case C — colis identical, weight differs by more than 5 kg and up to 20 kg.** Suspicious
but not a partiel. The phase becomes `weight_mismatch` (card badge "Écart poids"),
a screenshot of the pré-apurement block is taken, and an email
*"Le poids trouvé dans le système BADR est différent du poids du manifeste / MAWB — LTA N°
…"* is sent asking the operator to fix the weight ("écart > 5 kg"). The run stops for that
LTA; it can be relaunched after the operator corrects the weight.

**Case D — colis identical, weight differs by more than 20 kg.** So far off that the
shipment is treated as a partial one. The phase becomes `partiel_skip` (card badge
"LTA Partielle"), the same weight-mismatch email is sent with "écart critique > 20 kg",
and the run stops. The operator's next step is to tick *LTA Partielle* and launch it
through the DUM Normale Partiel flow.

**Case E — colis differ AND weight differs by more than 2 kg.** Both numbers being short
means part of the shipment is not in BADR yet: this is a **partiel LTA that was wrongly
treated as a DS Combinée**. The phase becomes `partiel_skip`, the log says "LTA partielle
probable — colis et poids diffèrent", and an email
*"LTA partielle (à traiter en Partiel, pas en DS Combinée) — LTA N° …"* is sent with both
the colis and weight pairs and the screenshot. Note the tolerance here is deliberately
tight (`POIDS_MATCH_TOLERANCE = 2` kg): once the colis already disagree, even a 5 kg gap
is evidence that something is missing, unlike Case B where the colis agree.

**Case F — colis differ but weight matches within 2 kg.** The whole shipment is there but
somebody typed or extracted the wrong container count — a plain data error. The phase
becomes `error` ("Nombre de colis différent … rectification requise") and the email
*"Merci de rectifier le nombre de colis de la LTA N° …"* (same subject line as the weight
mail) states BADR's count versus the saisi count. The operator corrects *Nb. contenant*
and relaunches. If either weight is unparseable the weight cannot confirm a partial, so
this case is the fallback.

Every one of the mails above is prefixed with the acheminement ordinal
(`8éme acheminement — …`) and, when the screenshot could be taken, attaches the image of
the whole pré-apurement block (*Recherche du lot* + *Lot de dédouanement* + *Confirmer*).

## 4. Partiel LTA (DUM Normale Partiel): Step 5

**Early check (since 2026-09-25).** Finding 2 or more lots in the lot lookup does not
mean the LTA is complete — it may be a 3-, 4- or 5-vol partiel whose next flight is not
registered yet. So `runPartielDumFlow` now runs the Step 5 comparison **before** filling
the real declaration: `precheckLots` opens a throw-away partiel declaration (Step 1),
registers every lot in Préapurement DS with the exact Step 5 code, and compares the
summed colis/poids with the manifest. Nothing is saved; the real run then opens a fresh
declaration. If the totals do not match, the LTA stops immediately with the same states
and emails as Step 5 below (P1/P2 — "En attente du Nème vol" or weight mismatch), without
Entête/Transport/Caution ever being filled. If the totals match, the run continues
(and Step 5 checks again inside the real declaration, which also applies the ≤ 1 kg
rounding correction). The pre-check is **fail-open**: if it cannot run (BADR or selector
problem) it logs "pré-contrôle des lots indisponible" and the normal flow proceeds, where
Step 5 is still the safety net.

A partiel LTA has several lots (one per flight), so the reader is not used; instead
`_step5_preapurement` loops over `ach.partiels`. For each lot it clicks *Nouveau*, fills
the reference exactly as BADR listed it (série, clé, lieu, référence lot), clicks *OK*,
reads the lot's weight and container count, and clicks *Confirmer* to register that lot
on the declaration. It keeps a list of readings and, after the last lot, compares the
**sums** with the manifest.

**Case P1 — sum of colis ≠ manifest colis.** Not all flights have arrived. The result is
`kind: "waiting_vol"` with `nextVol = number of lots + 1`. The checkpoint becomes
`partiel_waiting_lots` (card badge "En attente prochain vol"), the lots screenshot is
saved, and `notifyPartielPoidsMismatch` sends *"En attente du Nème vol — LTA N° …"*
explaining that the container total of the lots does not yet match the manifest. This is
not an error: the LTA simply waits. Relaunching (per-card *Lancer* or *Tout lancer*) re-runs
the lot lookup, and once the missing flight is in BADR the flow continues.

**Case P2 — colis sum matches, weight sum differs by more than 1 kg.** All flights are
there but the weight disagrees, so it is reported as `kind: "poids"`: checkpoint
`partiel_poids_mismatch`, badge "Écart poids", and the email *"Le poids trouvé dans le
système BADR est différent du poids du manifeste / MAWB — LTA N° …"* with BADR's summed
weight and the manifest weight. The operator fixes the weight and relaunches.

**Case P3 — colis sum matches, weight differs by 1 kg or less (but not 0).** Rounding.
The lots' total weight becomes authoritative: `poidTotal` is rewritten in
`acheminement.json`, the *Entête* tab weight is corrected (`_correctEntePoids`), and the
flow continues with the corrected value.

**Case P4 — everything matches.** The declaration is saved (*Sauvegarder*), the phase
becomes `partiel_preapurement_done`, and the flow proceeds to Documents → Demandes →
Articles → Print. A colis expectation of 0 (manifest colis missing) skips the colis
check and falls through to the weight comparison.

## 5. Quick reference

| Flow | Colis | Poids gap | Result | Phase / badge | Email |
|---|---|---|---|---|---|
| DS Combinée | same | 0 | continue, BADR weight stored | `badr_checked` | none |
| DS Combinée | same | ≤ 5 kg | continue, BADR weight stored | `badr_checked` | none |
| DS Combinée | same | 5–20 kg | stop | `weight_mismatch` / "Écart poids" | poids différent (> 5 kg) |
| DS Combinée | same | > 20 kg | stop, go partiel | `partiel_skip` / "LTA Partielle" | poids différent (critique) |
| DS Combinée | differ | > 2 kg | stop, it is a partiel | `partiel_skip` / "LTA Partielle" | LTA partielle (pas DS Combinée) |
| DS Combinée | differ | ≤ 2 kg | stop, fix colis | `error` | rectifier le nombre de colis |
| Partiel | sum ≠ manifest | any | wait for next vol | `partiel_waiting_lots` | En attente du Nème vol |
| Partiel | sum = manifest | > 1 kg | stop, fix weight | `partiel_poids_mismatch` | poids différent |
| Partiel | sum = manifest | ≤ 1 kg | continue, lot weight stored | `partiel_preapurement_done` | none |
| Partiel | sum = manifest | 0 | continue | `partiel_preapurement_done` | none |

## 6. Constants and where to change them

`POIDS_MATCH_TOLERANCE = 2` kg (colis differ: weight "matches" up to here) and the `5` /
`20` kg thresholds for the colis-identical weight check live in
`prepareLotAndWeightCheck` in `electron/main.js`. The partiel weight tolerance (`1` kg) and
the `waiting_vol` rule (`nextVol = lots + 1`) live in `_step5_preapurement` in
`src/badr/badrDumNormalPartiel.js`. Regime 010 / Normale (the throw-away declaration) and
the lot form selectors are in `badrPreapurement.js`.

## 7. Things worth knowing when debugging

The tolerances are intentionally **not** the same everywhere: 5 kg (colis identical,
DS Combinée), 2 kg (colis differ, DS Combinée) and 1 kg (partiel, summed over lots).
The DS Combinée screenshot targets the whole `#mainTab:form3:preap_details` block
(`captureBadrPreapShot` in `main.js`, falling back to narrower panels, then the iframe),
whereas the partiel's `_screenshotLots` still captures the whole `#iframeMenu` element.
The reader always opens a fresh "Créer une déclaration" (Régime 010) just to reach the
Préapurement screen; this app never submits it. In the partiel loop the lot's **année is
hard-coded to `"2026"`** (`referencePreap_anneeId` in `_step5_preapurement`) and the
bureau/régime to `301`/`000`, unlike the DS Combinée reader which uses the year returned
by the lot lookup — a partiel lot registered in another year would be looked up with the
wrong année. Finally, a relaunch of any LTA sitting at `partiel_waiting_lots` deliberately
re-checks BADR (there is no early return), so the "waiting" state heals itself as soon as
the next flight is registered.
