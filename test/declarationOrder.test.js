"use strict";
// Step order of the two declaration flows, with every BADR/Portnet step stubbed:
//  - partiel: precheck declaration kept → straight to Entête, no 2nd Préapurement
//  - both: documents annexed last (partiel: before Print; non-partiel: before Envoyer)
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
process.env.LOGS_DIR = os.tmpdir(); // keep test log lines out of logs/
const BADRDumNormalPartiel = require("../src/badr/badrDumNormalPartiel");
const PortnetDsCombine = require("../src/portnet/portnetDsCombine");

const PARTIEL_STEPS = {
  _step1_openDeclaration: "open",
  _openEnteteTab: "enteteTab",
  _step2_entete: "entete",
  _step3_transport: "transport",
  _step4_caution: "caution",
  _step5_preapurement: "preapurement",
  _correctEntePoids: "correctPoids",
  _sauvegarder: "save",
  _step8_demandes: "demandes",
  _step9_articles: "articles",
  _step7_documents: "documents",
  _step10_print: "print",
};

/** BADRDumNormalPartiel with every BADR step replaced by a recorder. */
function fakeDum({ step5Result = { mismatch: false, actualPoids: 100 } } = {}) {
  const dum = new BADRDumNormalPartiel({ frameLocator: () => ({}) });
  const calls = [];
  const seen = {};
  for (const [method, name] of Object.entries(PARTIEL_STEPS)) {
    dum[method] = async (_iframe, arg) => {
      calls.push(name);
      if (method === "_step2_entete") seen.entetePoids = arg.poidTotal;
      if (method === "_step5_preapurement") return step5Result;
      if (method === "_step10_print") return { destPath: "x.pdf", serie: "1", cle: "A" };
    };
  }
  dum._checkBadrError = async () => false;
  return { dum, calls, seen };
}

async function runPartiel({ phase = "partiel_lots_found", precheck, step5Result, poidTotal = "100" } = {}) {
  const { dum, calls, seen } = fakeDum({ step5Result });
  const phases = [];
  await dum.run(
    { id: "T", poidTotal, partiels: [{}, {}], automationState: { phase } },
    {},
    (patch) => phases.push(patch.phase),
    { precheck },
  );
  return { calls, phases, seen };
}

const withoutSaves = (calls) => calls.filter((c) => c !== "save");

test("partiel, precheck OK: same declaration → Entête directly, lots not registered twice", async () => {
  const { calls } = await runPartiel({ precheck: { mismatch: false, actualPoids: 100 } });
  assert.deepEqual(withoutSaves(calls), [
    "enteteTab", "entete", "transport", "caution",
    "demandes", "articles", "documents", "print",
  ]);
  assert.ok(!calls.includes("open"), "no second 'Créer une déclaration'");
  assert.ok(!calls.includes("preapurement"), "no second Préapurement DS");
});

test("partiel, precheck OK with ≤ 1 kg rounding: Entête gets the lots' poids, no later correction", async () => {
  const { calls, seen } = await runPartiel({
    precheck: { mismatch: false, actualPoids: 100.4, poidsAdjusted: true },
  });
  assert.equal(seen.entetePoids, "100.4");
  assert.ok(!calls.includes("correctPoids"));
});

test("partiel, no usable precheck: full flow exactly as before, documents now last", async () => {
  for (const precheck of [null, { mismatch: true, kind: "waiting_vol" }]) {
    const { calls } = await runPartiel({ precheck });
    assert.deepEqual(withoutSaves(calls), [
      "open", "entete", "transport", "caution", "preapurement",
      "demandes", "articles", "documents", "print",
    ]);
  }
});

test("partiel, Step 5 rounding (no precheck): Entête still corrected after the lots", async () => {
  const { calls } = await runPartiel({
    precheck: null,
    step5Result: { mismatch: false, actualPoids: 100.4, poidsAdjusted: true },
  });
  assert.ok(calls.indexOf("correctPoids") > calls.indexOf("preapurement"));
});

test("partiel, Step 5 mismatch (no precheck): stops before demandes/articles/documents", async () => {
  await assert.rejects(
    runPartiel({
      precheck: null,
      step5Result: { mismatch: true, kind: "poids", errorMessage: "Poids différent" },
    }),
    /Poids différent/,
  );
});

test("partiel resume: a precheck is ignored when the run resumes mid-way", async () => {
  const { calls } = await runPartiel({
    phase: "partiel_caution_saved",
    precheck: { mismatch: false, actualPoids: 100 },
  });
  assert.deepEqual(withoutSaves(calls), [
    "preapurement", "demandes", "articles", "documents", "print",
  ]);
});

test("partiel resume after articles: documents then print", async () => {
  const { calls } = await runPartiel({ phase: "partiel_articles_saved" });
  assert.deepEqual(withoutSaves(calls), ["documents", "print"]);
});

test("partiel phases are saved in order, documents right before the PDF", async () => {
  const { phases } = await runPartiel({ precheck: { mismatch: false, actualPoids: 100 } });
  assert.deepEqual(phases.filter((p) => p !== "partiel_declaration_opened").slice(-4), [
    "partiel_demandes_saved",
    "partiel_articles_saved",
    "partiel_documents_saved",
    "partiel_pdf_saved",
  ]);
});

// ── Portnet DS Combinée (non-partiel) ────────────────────────────────────────

const PORTNET_STEPS = [
  "navigate", "selectAgrement", "selectAnticipationNon", "searchAndSelectDSReference",
  "selectArrondissement", "selectLieuStockage", "selectBureauDestination",
  "selectAvecMoyenTransportNon", "selectPaysProvenance", "selectPaysDestination",
  "fillDateVoyage", "fillMontant", "fillCaution", "fillConnaissement",
  "fillEquipementsMarchandises", "fillDemandesDiverses", "fillAnnexe",
];

function fakeDsCombine(annexResult = { stoppedAfterCompression: false }) {
  const ds = Object.create(PortnetDsCombine.prototype);
  const inputValue = async () => "CASABLANCA";
  const locator = () => ({ filter: () => ({ first: () => ({ locator: () => ({ inputValue }) }) }) });
  ds.page = { waitForTimeout: async () => {} };
  ds.frame = { locator };
  const calls = [];
  for (const m of PORTNET_STEPS) {
    ds[m] = async () => {
      calls.push(m);
      if (m === "fillAnnexe") return annexResult;
    };
  }
  return { ds, calls };
}

const fullForm = {
  sequenceNum: "3064", montant: "10", deviseId: "USD", refNumber: "607-123",
  nombreContenant: "2", poidsBrut: "100", folderPath: "C:/x", scelle1: "1", scelle2: "2",
};

test("non-partiel: Annexe is the last section filled, after Demandes diverses", async () => {
  const { ds, calls } = fakeDsCombine();
  const res = await ds.fillEntete(fullForm);
  assert.equal(calls.at(-1), "fillAnnexe");
  assert.equal(calls.at(-2), "fillDemandesDiverses");
  assert.deepEqual(calls.slice(0, -2), PORTNET_STEPS.slice(0, -2)); // rest unchanged
  assert.equal(res.stoppedAfterAnnexCompression, false);
});

test("non-partiel: annexe debug stop still returns its flag", async () => {
  const { ds } = fakeDsCombine({ stoppedAfterCompression: true, compressedOutputDir: "C:/x/compress" });
  const res = await ds.fillEntete(fullForm);
  assert.equal(res.stoppedAfterAnnexCompression, true);
  assert.equal(res.compressedOutputDir, "C:/x/compress");
});
