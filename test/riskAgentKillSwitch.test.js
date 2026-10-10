/**
 * #73 — il kill-switch blocca l'esposizione NUOVA, non l'uscita.
 * ==============================================================
 *
 * `riskAgent._evaluate()` controllava il kill-switch per primo e respingeva
 * QUALSIASI azione con «tutte le aperture sono bloccate»: l'eccezione per le
 * azioni che riducono il rischio arrivava dopo e non veniva mai raggiunta. In
 * emergenza (kill-switch attivo) una `close` o un `tighten_sl` proposti
 * dall'agente venivano respinti proprio quando servivano.
 *
 * Classificazione inchiodata qui:
 *  - riducono il rischio (`close`, `tighten_sl`, `pause_bot`, ...) → passano;
 *  - suggerimenti (`note`, ...) → passano: non eseguono niente;
 *  - aperture e configurazioni (`open`, `tune_params`) → bloccate, ciascuna con
 *    la propria motivazione vera.
 * A kill-switch spento il comportamento è quello di prima.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Ambiente fissato PRIMA degli import: `config.js` fotografa `process.env` al
// caricamento (stesso motivo di riskAgentReservedSlots.test.js).
process.env.AGENT_MARKET_WHITELIST = '';
process.env.PERPS_MAX_LEVERAGE = '20';
process.env.PERPS_MAX_POSITION_USD = '5000';
process.env.PERPS_MAX_DAILY_LOSS_USD = '1000';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-riskagentks-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: portfolio } = await import('../src/perps/portfolio.js');
const { default: riskAgent } = await import('../src/agents/riskAgent.js');

portfolio.setLimits({ maxConcurrentPositions: 3, maxTotalExposureUsd: 1e7, maxConsecutiveLosses: 99 });

const MASTER = '0xAbC0000000000000000000000000000000000001';

/** Apertura come la costruisce `proposals._toAction()`, approvabile a kill-switch spento. */
function openAction() {
  return {
    type: 'open',
    coin: 'SOL-PERP',
    side: 'long',
    masterAddress: MASTER,
    account: { equity: 10000, accountValue: 10000, positions: [] },
    notionalUsd: 100,
    leverage: 1,
    botId: `advisory-${Math.random().toString(16).slice(2)}`,
    config: {}
  };
}

/** Esegue `fn` con il kill-switch nello stato dato, e lo spegne comunque alla fine. */
function conKillSwitch(on, fn) {
  riskAgent.setKillSwitch(on);
  try { fn(); } finally { riskAgent.setKillSwitch(false); }
}

test('kill-switch ATTIVO: close e tighten_sl passano (riducono il rischio)', () => {
  conKillSwitch(true, () => {
    for (const type of ['close', 'tighten_sl', 'pause_bot', 'reduce', 'close_suggestion']) {
      const v = riskAgent.evaluate({ type, coin: 'SOL-PERP', masterAddress: MASTER });
      assert.equal(v.ok, true, `${type} deve passare in emergenza: ${v.reason}`);
      assert.match(v.reason, /riduce il rischio/);
    }
  });
});

test('kill-switch ATTIVO: un\'apertura è respinta con la motivazione del kill-switch', () => {
  conKillSwitch(true, () => {
    const v = riskAgent.evaluate(openAction());
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'Kill-switch attivo: tutte le aperture sono bloccate.');
  });
});

test('kill-switch ATTIVO: un suggerimento passa, un tuning di config no (e lo dice)', () => {
  conKillSwitch(true, () => {
    const nota = riskAgent.evaluate({ type: 'note', coin: 'SOL-PERP' });
    assert.equal(nota.ok, true, nota.reason);
    assert.match(nota.reason, /nessuna esecuzione/);

    const tuning = riskAgent.evaluate({ type: 'tune_params', coin: 'SOL-PERP' });
    assert.equal(tuning.ok, false, 'una config può alzare leva/size delle prossime aperture');
    assert.match(tuning.reason, /Kill-switch attivo/);
    assert.match(tuning.reason, /configurazione/, 'la motivazione non deve parlare di "aperture" per una config');
  });
});

test('kill-switch SPENTO: comportamento invariato', () => {
  conKillSwitch(false, () => {
    assert.equal(riskAgent.evaluate(openAction()).ok, true, 'apertura entro i limiti approvata');
    assert.equal(riskAgent.evaluate({ type: 'close', coin: 'SOL-PERP' }).ok, true);
    assert.equal(riskAgent.evaluate({ type: 'tighten_sl', coin: 'SOL-PERP' }).ok, true);
    const tuning = riskAgent.evaluate({ type: 'tune_params', coin: 'SOL-PERP' });
    assert.equal(tuning.ok, true);
    assert.match(tuning.reason, /nessun ordine a mercato/);
    const senzaAccount = riskAgent.evaluate({ ...openAction(), account: null });
    assert.equal(senzaAccount.ok, false);
    assert.match(senzaAccount.reason, /Nessun wallet/);
  });
});
