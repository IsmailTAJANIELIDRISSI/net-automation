"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
process.env.LOGS_DIR = os.tmpdir(); // keep test log lines out of logs/
const BADRLotLookup = require("../src/badr/badrLotLookup");

const ENV_KEYS = [
  "BADR_SEARCH_WINDOW_DAYS",
  "BADR_SEARCH_RETRY_ATTEMPTS",
  "BADR_SEARCH_RETRY_SHIFT_DAYS",
  "BADR_SEARCH_RETRY_START_EXTRA_DAYS",
];
for (const k of ENV_KEYS) delete process.env[k]; // test the shipped defaults

const day = (d, m, y) => new Date(y, m - 1, d, 10, 0, 0);
const parse = (s) => {
  const [d, m, y] = s.split("/").map(Number);
  return new Date(y, m - 1, d);
};
const spanDays = (w) => Math.round((parse(w.dateAu) - parse(w.dateDu)) / 86_400_000);
const contains = (w, date) => parse(w.dateDu) <= date && date <= parse(w.dateAu);

const lot = (serie, cle) => ({ serie, cle, lieu: "ISTAMBOUL ATATUR", ref: "72-74678026" });

test("every search period respects BADR's 7-day limit (E2800009)", () => {
  for (const partiel of [false, true]) {
    for (const now of [day(26, 11, 2026), day(5, 1, 2027), day(3, 3, 2028)]) {
      for (const w of BADRLotLookup.searchWindows({ partiel, now })) {
        assert.ok(spanDays(w) <= 7, `${w.dateDu} → ${w.dateAu} is ${spanDays(w)} days`);
      }
    }
  }
});

test("scenario 1: partiel, both lots found in the current week → continue", () => {
  const merged = BADRLotLookup.mergeLots([lot("15403", "R"), lot("15466", "Y")], "72-74678026");
  assert.equal(merged.rowCount, 2);
  assert.equal(BADRLotLookup.classifyPartielResult(merged), "lots_found");
});

test("scenario 2: 2nd lot in the previous week is found and combined", () => {
  const [thisWeek, prevWeek] = BADRLotLookup.searchWindows({
    partiel: true,
    now: day(26, 11, 2026),
  });
  assert.deepEqual(thisWeek, { dateDu: "20/11/2026", dateAu: "26/11/2026" });
  assert.deepEqual(prevWeek, { dateDu: "13/11/2026", dateAu: "20/11/2026" });
  assert.ok(!contains(thisWeek, day(18, 11, 2026)));
  assert.ok(contains(prevWeek, day(18, 11, 2026)));

  // Lot of 20/11 shows up in both weeks (shared boundary day): counted once.
  const merged = BADRLotLookup.mergeLots(
    [lot("15466", "Y"), lot("15466", "Y"), lot("15403", "R")],
    "72-74678026",
  );
  assert.equal(merged.rowCount, 2);
  assert.equal(BADRLotLookup.classifyPartielResult(merged), "lots_found");
});

test("scenario 3: partiel, one lot over both weeks → stop as DS combinée", () => {
  const merged = BADRLotLookup.mergeLots([lot("15403", "R")], "72-74678026");
  assert.equal(merged.isPartiel, false);
  assert.equal(BADRLotLookup.classifyPartielResult(merged), "single_lot");
  const msg = BADRLotLookup.singleLotMessage("72-74678026");
  assert.match(msg, /72-74678026/);
  assert.match(msg, /DS combinée, pas une LTA partielle/);
});

test("scenario 4: non-partiel keeps its search periods", () => {
  const now = day(26, 11, 2026);
  assert.deepEqual(BADRLotLookup.searchWindows({ now }), [
    { dateDu: "20/11/2026", dateAu: "26/11/2026" },
    { dateDu: "13/11/2026", dateAu: "20/11/2026" },
  ]);
  process.env.BADR_SEARCH_RETRY_ATTEMPTS = "1";
  try {
    assert.equal(BADRLotLookup.searchWindows({ now }).length, 1);
    // A partiel always checks both weeks.
    assert.equal(BADRLotLookup.searchWindows({ partiel: true, now }).length, 2);
  } finally {
    delete process.env.BADR_SEARCH_RETRY_ATTEMPTS;
  }
});

test("nothing in either week → still waiting for the manifest", () => {
  const merged = BADRLotLookup.mergeLots([], "72-74678026");
  assert.equal(BADRLotLookup.classifyPartielResult(merged), "waiting_manifest");
});

test("periods cross month, year and leap-year boundaries", () => {
  assert.deepEqual(BADRLotLookup.searchWindows({ partiel: true, now: day(5, 1, 2027) }), [
    { dateDu: "30/12/2026", dateAu: "05/01/2027" },
    { dateDu: "23/12/2026", dateAu: "30/12/2026" },
  ]);
  assert.deepEqual(BADRLotLookup.searchWindows({ partiel: true, now: day(3, 3, 2028) }), [
    { dateDu: "26/02/2028", dateAu: "03/03/2028" },
    { dateDu: "19/02/2028", dateAu: "26/02/2028" }, // 2028: 29 days in February
  ]);
});

// ── searchLot() loop, against a fake BADR popup ──────────────────────────────

/** Page stand-in: every call succeeds; date fills and BADR's error text are scripted. */
function fakePopup({ errorText = "" } = {}) {
  const dates = [];
  const chain = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === "then") return undefined;
      return (...args) => {
        if (prop === "fill" && /j_id_1[vz]_input/.test(args[0])) dates.push(args[1]);
        if (prop === "textContent") return Promise.resolve(errorText);
        return chain;
      };
    },
  });
  return { page: chain, dates };
}

/** Runs searchLot with one scripted _parseResults answer per search. */
async function runSearch({ partiel, answers, errorText }) {
  const { page, dates } = fakePopup({ errorText });
  const lookup = new BADRLotLookup(null);
  lookup.popupPage = page;
  lookup._selectOperateur = async () => {};
  const emailFlags = [];
  let i = 0;
  lookup._parseResults = async (_ref, { sendNoResultEmail }) => {
    emailFlags.push(sendNoResultEmail);
    return answers[i++] ?? { isEmpty: true, isPartiel: false, rowCount: 0 };
  };
  const result = await lookup.searchLot("72-74678026", { partiel, emailOnEmpty: true });
  return { result, searches: i, dates, emailFlags };
}

const single = (serie, cle) => ({
  isEmpty: false,
  isPartiel: false,
  rowCount: 1,
  serie: serie.padStart(7, "0"),
  cle,
  lieuChargement: "ISTAMBOUL ATATUR",
});
const empty = { isEmpty: true, isPartiel: false, rowCount: 0 };

test("searchLot partiel: one lot per week → 2 lots combined, both weeks searched", async () => {
  const { result, searches, dates } = await runSearch({
    partiel: true,
    answers: [single("15466", "Y"), single("15403", "R")],
  });
  assert.equal(searches, 2);
  assert.equal(dates.length, 4); // du + au for each week
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.partiels.map((l) => `${l.serie} ${l.cle}`), ["15466 Y", "15403 R"]);
  assert.equal(BADRLotLookup.classifyPartielResult(result), "lots_found");
});

test("searchLot partiel: same lot seen in both weeks → still one lot", async () => {
  const { result } = await runSearch({
    partiel: true,
    answers: [single("15466", "Y"), single("15466", "Y")],
  });
  assert.equal(BADRLotLookup.classifyPartielResult(result), "single_lot");
});

test("searchLot partiel: lot found → no 'pas encore manifest' email", async () => {
  const { emailFlags } = await runSearch({ partiel: true, answers: [single("15466", "Y"), empty] });
  assert.ok(emailFlags.every((f) => f === false));
});

test("searchLot non-partiel: stops at the first week that finds a lot", async () => {
  const { result, searches } = await runSearch({
    partiel: false,
    answers: [single("3064", "A"), single("9999", "Z")],
  });
  assert.equal(searches, 1);
  assert.equal(result.serie, "0003064");
});

test("searchLot: BADR refuses the period → clear error, no 30 s timeout", async () => {
  await assert.rejects(
    runSearch({
      partiel: true,
      answers: [],
      errorText: "Erreur : E2800009-La période ne doit pas excéder [7] jours !",
    }),
    /BADR a refusé la recherche .*E2800009/,
  );
});
