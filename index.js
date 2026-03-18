'use strict';
/**
 * index.js – Main orchestrator for Portnet / BADR automation.
 *
 * Execution flow:
 *
 *  1. [BADR]    Launch Edge + connect via CDP
 *  2. [BADR]    Login to BADR
 *  3. [BADR]    Open "Lot de dédouanement" popup → search → extract lot info
 *               (declarationRef, bureau, regime, annee, serie, cle, lieuChargement)
 *  4. [BADR]    Go to Préapurement DS tab → look up poids brut + nombre contenants
 *  5. [PORTNET] Launch Chromium + login to Portnet (manual CAPTCHA step)
 *  6. [PORTNET] Fill DS Combinée Entête form with data from steps 3–4
 *  7. Cleanup
 */

require('dotenv').config();

const BADRConnection    = require('./src/badr/badrConnection');
const BADRLotLookup     = require('./src/badr/badrLotLookup');
const BADRPreapurement  = require('./src/badr/badrPreapurement');
const PortnetLogin      = require('./src/portnet/portnetLogin');
const PortnetDsCombine  = require('./src/portnet/portnetDsCombine');
const { createLogger }  = require('./src/utils/logger');

const log = createLogger('Orchestrator');

// ── Configuration overrides via CLI args ─────────────────────────────────────
// Usage: node index.js --lotRef=XXX --dateDu=01/01/2026 --dateAu=28/02/2026
function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    const [key, val] = arg.replace(/^--/, '').split('=');
    if (key && val !== undefined) args[key] = val;
  });
  return args;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  log.info('Starting automation', args);

  const badrConn   = new BADRConnection();
  const portnetApp = new PortnetLogin();

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1 – BADR: connect and extract lot information
    // ─────────────────────────────────────────────────────────────────────────
    log.info('=== PHASE 1: BADR Connection ===');
    await badrConn.connect();

    // ── Open Lot de dédouanement popup ────────────────────────────────────────
    log.info('=== PHASE 2: Lot de dédouanement lookup ===');
    const lotLookup = new BADRLotLookup(badrConn.page);
    const popupPage = await lotLookup.openLotPopup();

    const lotInfo = await lotLookup.searchLot({
      lotReference: args.lotRef   || undefined,
      dateDu:       args.dateDu   || undefined,
      dateAu:       args.dateAu   || undefined,
    });

    if (!lotInfo) {
      throw new Error('No lot found in BADR. Check the search parameters.');
    }
    log.info('Lot info extracted', lotInfo);

    await lotLookup.close();

    // ── Préapurement DS ───────────────────────────────────────────────────────
    log.info('=== PHASE 3: Préapurement DS weight check ===');
    let poidsInfo = { poidsBrut: null, nombreContenants: null };
    try {
      const preap = new BADRPreapurement(badrConn.page);
      poidsInfo = await preap.getPoidsBrut(lotInfo);
      log.info('Poids brut result', poidsInfo);
    } catch (err) {
      log.warn('Préapurement step failed – continuing without weight', {
        message: err.message,
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2 – PORTNET: login and fill DS Combinée
    // ─────────────────────────────────────────────────────────────────────────
    log.info('=== PHASE 4: Portnet Login ===');
    const portnetPage = await portnetApp.login();

    log.info('=== PHASE 5: Fill DS Combinée Entête ===');
    const dsCombine = new PortnetDsCombine(portnetPage);

    await dsCombine.fillEntete({
      sequenceNum: lotInfo.sequenceNum, // e.g. '0003064'
      // montant and deviseId can be passed via args or left empty for manual fill
      montant:  args.montant  || undefined,
      deviseId: args.deviseId || undefined,
    });

    log.info('=== AUTOMATION COMPLETE ===');
    log.info('Summary', {
      declarationRef:   lotInfo.declarationRef,
      lieuChargement:   lotInfo.lieuChargement,
      poidsBrut:        poidsInfo.poidsBrut,
      nombreContenants: poidsInfo.nombreContenants,
    });

    console.log('\n========================================');
    console.log('  Entête form filled successfully!');
    console.log(`  DS Ref   : ${lotInfo.declarationRef}`);
    console.log(`  Lieu Chg : ${lotInfo.lieuChargement}`);
    console.log(`  Poids    : ${poidsInfo.poidsBrut}`);
    console.log('  Review the form, then submit manually.');
    console.log('========================================\n');

    // Keep browser open for manual review / submission
    // Press Ctrl+C to exit when done
    process.stdin.resume();

  } catch (err) {
    log.error('Automation failed', { message: err.message, stack: err.stack });
    console.error('\n[FATAL]', err.message);
    process.exit(1);
  }

  // Note: browser stays open intentionally for manual review.
  // Clean up by killing the process (Ctrl+C).
  process.on('SIGINT', async () => {
    log.info('Shutting down…');
    await portnetApp.close().catch(() => {});
    badrConn.kill();
    process.exit(0);
  });
}

main();
