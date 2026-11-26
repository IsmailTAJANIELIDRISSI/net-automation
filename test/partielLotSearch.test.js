"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const BADRLotLookup = require("../src/badr/badrLotLookup");

const lookup = new BADRLotLookup(null);
const day = (d, m, y) => new Date(y, m - 1, d, 10, 0, 0);
const firstWindow = (partiel, today) =>
  lookup._computeDateRange(0, BADRLotLookup.searchWindowDays(partiel), 0, today);

const twoLots = {
  isEmpty: false,
  isPartiel: true,
  rowCount: 2,
  partiels: [{ serie: "15403" }, { serie: "15466" }],
};
const oneLot = { isEmpty: false, isPartiel: false, rowCount: 1 };
const noLot = { isEmpty: true, isPartiel: false, rowCount: 0 };

test("scenario 1: partiel, both lots found → continue", () => {
  assert.equal(BADRLotLookup.classifyPartielResult(twoLots), "lots_found");
});

test("scenario 2: partiel window reaches the 2nd lot of the previous week", () => {
  const today = day(26, 11, 2026);
  // Old 7-day window (20/11 → 26/11) missed a lot of 18/11 …
  assert.deepEqual(firstWindow(false, today), {
    dateDu: "20/11/2026",
    dateAu: "26/11/2026",
  });
  // … the partiel window (13/11 → 26/11, 14 days) includes it.
  assert.deepEqual(firstWindow(true, today), {
    dateDu: "13/11/2026",
    dateAu: "26/11/2026",
  });
  assert.equal(BADRLotLookup.classifyPartielResult(twoLots), "lots_found");
});

test("scenario 3: partiel, one lot over 14 days → stop as DS combinée", () => {
  assert.equal(BADRLotLookup.classifyPartielResult(oneLot), "single_lot");
  const msg = BADRLotLookup.singleLotMessage("235-98102340");
  assert.match(msg, /235-98102340/);
  assert.match(msg, /14 jours/);
  assert.match(msg, /DS combinée, pas une LTA partielle/);
});

test("scenario 4: non-partiel keeps the 7-day window", () => {
  const saved = process.env.BADR_SEARCH_WINDOW_DAYS;
  delete process.env.BADR_SEARCH_WINDOW_DAYS;
  try {
    assert.equal(BADRLotLookup.searchWindowDays(false), 6);
    assert.equal(BADRLotLookup.searchWindowDays(), 6);
    process.env.BADR_SEARCH_WINDOW_DAYS = "4";
    assert.equal(BADRLotLookup.searchWindowDays(false), 4);
    assert.equal(BADRLotLookup.searchWindowDays(true), 13);
  } finally {
    if (saved === undefined) delete process.env.BADR_SEARCH_WINDOW_DAYS;
    else process.env.BADR_SEARCH_WINDOW_DAYS = saved;
  }
});

test("manifest not in BADR yet → still waiting_manifest", () => {
  assert.equal(BADRLotLookup.classifyPartielResult(noLot), "waiting_manifest");
});

test("windows cross month and year boundaries", () => {
  assert.deepEqual(firstWindow(true, day(5, 1, 2027)), {
    dateDu: "23/12/2026",
    dateAu: "05/01/2027",
  });
  assert.deepEqual(firstWindow(false, day(5, 1, 2027)), {
    dateDu: "30/12/2026",
    dateAu: "05/01/2027",
  });
  assert.deepEqual(firstWindow(true, day(3, 3, 2028)), {
    dateDu: "19/02/2028", // 2028 is a leap year (29 days in February)
    dateAu: "03/03/2028",
  });
});
