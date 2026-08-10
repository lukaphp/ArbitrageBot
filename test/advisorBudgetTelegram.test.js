/**
 * ADV-03 · `/advisorbudget` — l'unico canale che può cambiare il budget.
 * =====================================================================
 *
 * Requisito diretto del PO (refinement 10 agosto): il budget mensile del
 * consulente è «modificabile con un processo di approvazione tramite Telegram per
 * sicurezza». Il razionale è l'approvazione FUORI BANDA: chi compromette la
 * sessione web (cookie rubato, browser lasciato aperto) non deve potersi alzare
 * da solo il tetto di spesa verso un servizio a pagamento. Stessa filosofia del
 * kill-switch su Telegram (TG-01).
 *
 * Coperto qui, nello stile di test/telegramKillSwitch.test.js:
 *  - conferma a DUE PASSI: il primo messaggio propone e NON applica; solo
 *    `/advisorbudget confirm` applica;
 *  - la proposta scade (5 min) e si può annullare;
 *  - importo non valido o oltre il massimo → nulla cambia (un comando che alza
 *    una soglia di spesa non deve partire per un errore di battitura);
 *  - senza argomento è una lettura di stato;
 *  - una chat NON autorizzata non può nemmeno proporre, né confermare una
 *    proposta fatta da altri;
 *  - ogni modifica in audit con valore precedente e nuovo, e notifica sul canale.
 *
 * Seam: singleton `telegramControl` con `_send` sostituito da un collettore
 * (nessun HTTP verso Telegram), DB su file temporaneo, `notifier.notify`
 * neutralizzato. Cosa NON è coperto: il long-polling di `getUpdates` —
 * l'autorizzazione è esercitata da `_dispatchUpdate`, che è dove il loop la applica.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-advbudget-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: telegramControl } = await import('../src/perps/telegramControl.js');
const { default: advisor } = await import('../src/agents/advisor/advisor.js');
const { default: notifier } = await import('../src/perps/notifier.js');
const { default: botManager } = await import('../src/perps/botManager.js');

const AUTHORIZED = '424242';
let sent = [];
let notified = [];

const plain = (t) => String(t).replace(/<[^>]+>/g, '');
const auditFor = (action) => db.listAudit(200).filter(r => r.action === action);

beforeEach(() => {
  sent = [];
  notified = [];
  telegramControl.chatId = AUTHORIZED;
  telegramControl._send = async (text) => { sent.push(text); };
  telegramControl._pendingBudget = null;
  notifier.notify = async (text) => { notified.push(text); };
  botManager.bots.clear();
  db.db.prepare('DELETE FROM settings WHERE key = ?').run('advisor_monthly_budget_usd');
  db.db.prepare('DELETE FROM audit').run();
});

test('senza argomento: sola lettura di budget e speso, nessuna modifica', async () => {
  await telegramControl._handle('/advisorbudget');

  const msg = plain(sent[0]);
  assert.match(msg, /Budget mensile: \$10\.00/, 'mostra il default $10/mese');
  assert.match(msg, /Speso questo mese/);
  assert.match(msg, /Azzeramento/);
  assert.match(msg, /confirm/, 'spiega come si cambia');
  assert.equal(db.getSetting('advisor_monthly_budget_usd', null), null, 'nulla scritto');
  assert.equal(auditFor('advisor.budget.changed').length, 0);
});

test('primo passo: propone e NON applica', async () => {
  await telegramControl._handle('/advisorbudget 25');

  const msg = plain(sent[0]);
  assert.match(msg, /Conferma richiesta/i);
  assert.match(msg, /\$25\.00\/mese/, 'il riepilogo dice l\'importo proposto');
  assert.match(msg, /Attuale: \$10\.00/, 'e quello attuale');
  assert.match(msg, /Nulla è stato modificato/i, 'dichiara esplicitamente che non ha fatto nulla');
  assert.equal(advisor.monthlyLimitUsd(), 10, 'il budget effettivo è ancora quello di prima');
  assert.equal(auditFor('advisor.budget.changed').length, 0, 'nessun audit di modifica: non c\'è stata modifica');
  assert.equal(notified.length, 0, 'nessuna notifica per una proposta non confermata');
});

test('secondo passo: confirm applica, registra in audit e notifica', async () => {
  await telegramControl._handle('/advisorbudget 25');
  sent = [];
  await telegramControl._handle('/advisorbudget confirm');

  assert.equal(advisor.monthlyLimitUsd(), 25, 'budget applicato');
  assert.equal(db.getSetting('advisor_monthly_budget_usd'), '25', 'persistito in settings');

  const msg = plain(sent[0]);
  assert.match(msg, /aggiornato/i);
  assert.match(msg, /Da \$10\.00 a \$25\.00/, 'la risposta dice da quanto a quanto');

  const audit = auditFor('advisor.budget.changed');
  assert.equal(audit.length, 1);
  const detail = JSON.parse(audit[0].detail_json);
  assert.equal(detail.da, 10, 'valore precedente in audit');
  assert.equal(detail.a, 25, 'valore nuovo in audit');
  assert.equal(detail.via, 'telegram');
  assert.equal(audit[0].actor, 'human', 'è un atto umano, non di un agente');

  assert.equal(notified.length, 1, 'notifica sul canale principale: non è un\'azione privata');
  assert.match(plain(notified[0]), /da \$10\.00 a \$25\.00/i);
});

test('confirm senza proposta: nessuna modifica', async () => {
  await telegramControl._handle('/advisorbudget confirm');
  assert.match(plain(sent[0]), /Nessuna modifica di budget da confermare/i);
  assert.equal(advisor.monthlyLimitUsd(), 10);
  assert.equal(auditFor('advisor.budget.changed').length, 0);
});

test('la conferma scade dopo 5 minuti: non applica una proposta dimenticata', async () => {
  await telegramControl._handle('/advisorbudget 500');
  // Proposta invecchiata di 6 minuti.
  telegramControl._pendingBudget.at = Date.now() - 6 * 60 * 1000;
  sent = [];

  await telegramControl._handle('/advisorbudget confirm');

  assert.match(plain(sent[0]), /scadut/i);
  assert.equal(advisor.monthlyLimitUsd(), 10, 'nulla applicato');
  assert.equal(telegramControl._pendingBudget, null, 'la proposta scaduta viene rimossa');
  assert.equal(auditFor('advisor.budget.changed').length, 0);
});

test('cancel annulla la proposta in sospeso', async () => {
  await telegramControl._handle('/advisorbudget 42');
  await telegramControl._handle('/advisorbudget cancel');
  assert.match(plain(sent[1]), /annullata/i);
  assert.equal(telegramControl._pendingBudget, null);

  sent = [];
  await telegramControl._handle('/advisorbudget confirm');
  assert.match(plain(sent[0]), /Nessuna modifica/i);
  assert.equal(advisor.monthlyLimitUsd(), 10);
});

test('una nuova proposta sostituisce la precedente (si conferma l\'ultima, non la prima)', async () => {
  await telegramControl._handle('/advisorbudget 50');
  await telegramControl._handle('/advisorbudget 20');
  await telegramControl._handle('/advisorbudget confirm');
  assert.equal(advisor.monthlyLimitUsd(), 20, 'vale l\'ultimo importo proposto');
});

/**
 * Input che vengono REINTERPRETATI invece che rifiutati (trovati da Annie in
 * review, più altri della stessa classe).
 *
 * La classe di bug è una sola: ripulire i caratteri non numerici PRIMA di
 * validare la forma. `'1e10'` diventa `'110'`, `'50abc'` diventa `'50'`,
 * `'0x10'` diventa `'010'` — tutti numeri validi, tutti diversi da quello che
 * l'operatore ha digitato, e tutti su una soglia di SPESA. Il primo giro di fix
 * aveva chiuso i due casi che avevo in mente (`-5`, `12.5.3`) invece della
 * classe: la validazione va fatta sulla stringa GREZZA.
 *
 * Regola per distinguere un caso legittimo da uno da rifiutare: la virgola
 * decimale e il simbolo di valuta sono forme in cui un umano scrive davvero un
 * importo, e vanno normalizzate esplicitamente; tutto il resto non è "sporcizia
 * da ripulire", è un input che non si è capito.
 */
test('input reinterpretati: notazioni numeriche e testo attaccato vengono RIFIUTATI', async () => {
  const casi = [
    ['1e10', 'notazione esponenziale: diventava 110'],
    ['1E10', 'idem in maiuscolo'],
    ['50abc', 'testo attaccato: diventava 50'],
    ['0x10', 'esadecimale: diventava 10'],
    ['0b101', 'binario: diventava 101'],
    ['1_000', 'separatore JS delle migliaia: diventava 1000'],
    ['Infinity', 'nessuna cifra, ma parseFloat lo conosce'],
    ['+5', 'segno esplicito: non è la forma prevista'],
    ['1.2e3', 'esponenziale con decimale'],
    ['25 25', 'due importi: quale dei due?'],
    ['.5', 'senza cifra intera: si scrive 0.5'],
    ['25.555', 'più di due decimali su un importo in dollari']
  ];
  for (const [arg, perche] of casi) {
    telegramControl._pendingBudget = null;
    sent = [];
    await telegramControl._handle(`/advisorbudget ${arg}`);
    assert.match(plain(sent[0]), /non valido/i, `"${arg}" deve essere rifiutato (${perche})`);
    assert.equal(telegramControl._pendingBudget, null, `"${arg}" non deve creare una proposta`);
    assert.equal(advisor.monthlyLimitUsd(), 10, `"${arg}" non deve cambiare il budget`);
  }
});

test('input reinterpretati: nemmeno confermando si applica qualcosa', async () => {
  // Il rifiuto deve avvenire al PRIMO passo. Se un input malformato creasse una
  // proposta, il secondo passo la applicherebbe senza più guardare il testo.
  await telegramControl._handle('/advisorbudget 1e10');
  sent = [];
  await telegramControl._handle('/advisorbudget confirm');
  assert.match(plain(sent[0]), /Nessuna modifica di budget da confermare/i);
  assert.equal(advisor.monthlyLimitUsd(), 10);
});

test('le forme legittime continuano a funzionare (virgola e simbolo di valuta)', async () => {
  const validi = [['25', 25], ['25.5', 25.5], ['$25', 25], ['12,50', 12.5], ['$12,50', 12.5], ['25€', 25], ['0.5', 0.5], ['1000', 1000]];
  for (const [arg, atteso] of validi) {
    telegramControl._pendingBudget = null;
    sent = [];
    await telegramControl._handle(`/advisorbudget ${arg}`);
    assert.equal(telegramControl._pendingBudget?.amount, atteso, `"${arg}" → ${atteso}`);
    assert.match(plain(sent[0]), /Conferma richiesta/i, `"${arg}" arriva alla conferma`);
  }
});

test('importo non valido: nessuna modifica, nessuna proposta in sospeso', async () => {
  for (const arg of ['abc', '-5', 'venticinque', '12.5.3']) {
    telegramControl._pendingBudget = null;
    sent = [];
    await telegramControl._handle(`/advisorbudget ${arg}`);
    assert.match(plain(sent[0]), /non valido/i, `"${arg}" rifiutato`);
    assert.equal(telegramControl._pendingBudget, null, `"${arg}" non deve creare una proposta`);
    assert.equal(advisor.monthlyLimitUsd(), 10);
  }
});

test('importo oltre il massimo consentito: rifiutato prima della conferma', async () => {
  await telegramControl._handle('/advisorbudget 5000');
  assert.match(plain(sent[0]), /massimo consentito/i);
  assert.equal(telegramControl._pendingBudget, null);
  assert.equal(advisor.monthlyLimitUsd(), 10);
});

test('importo scritto con simboli o virgola viene interpretato', async () => {
  await telegramControl._handle('/advisorbudget $12,50');
  assert.match(plain(sent[0]), /\$12\.50\/mese/);
  await telegramControl._handle('/advisorbudget confirm');
  assert.equal(advisor.monthlyLimitUsd(), 12.5);
});

test('budget a 0 è ammesso: è il modo di spegnere la chat dal canale sicuro', async () => {
  await telegramControl._handle('/advisorbudget 0');
  await telegramControl._handle('/advisorbudget confirm');
  assert.equal(advisor.monthlyLimitUsd(), 0);
  assert.equal(advisor.budget().exceeded, true, 'con tetto 0 la chat risulta bloccata');
});

test('chat NON autorizzata: non può proporre né confermare, e non riceve risposta', async () => {
  telegramControl.offset = 0;

  await telegramControl._dispatchUpdate({
    update_id: 10, message: { chat: { id: 999999 }, text: '/advisorbudget 999' }
  });
  assert.deepEqual(sent, [], 'nessuna risposta a una chat estranea');
  assert.equal(telegramControl._pendingBudget, null, 'nemmeno la proposta viene registrata');
  assert.equal(advisor.monthlyLimitUsd(), 10);
  assert.equal(telegramControl.offset, 11, 'offset avanzato: l\'update non torna in loop');

  // E non può confermare una proposta legittima fatta dalla chat autorizzata.
  await telegramControl._handle('/advisorbudget 300');
  sent = [];
  await telegramControl._dispatchUpdate({
    update_id: 11, message: { chat: { id: 999999 }, text: '/advisorbudget confirm' }
  });
  assert.deepEqual(sent, []);
  assert.equal(advisor.monthlyLimitUsd(), 10, 'la conferma di un estraneo non applica nulla');
  assert.ok(telegramControl._pendingBudget, 'la proposta legittima resta in attesa del titolare');
});

test('chat autorizzata: lo stesso comando passa dal dispatch e applica', async () => {
  telegramControl.offset = 0;
  await telegramControl._dispatchUpdate({
    update_id: 1, message: { chat: { id: Number(AUTHORIZED) }, text: '/advisorbudget 30' }
  });
  await telegramControl._dispatchUpdate({
    update_id: 2, message: { chat: { id: Number(AUTHORIZED) }, text: '/advisorbudget confirm' }
  });
  assert.equal(advisor.monthlyLimitUsd(), 30);
  assert.equal(telegramControl.offset, 3);
});

test('/help elenca il comando (scopribilità dalla chat, come per /killswitch)', async () => {
  await telegramControl._handle('/help');
  const msg = plain(sent[0]);
  assert.match(msg, /\/advisorbudget/);
  assert.match(msg, /confirm/, 'l\'aiuto dice che serve una conferma');
});

test('nuovo tetto già superato dalla spesa: lo dice invece di far finta che sia tutto ok', async () => {
  db.setSetting(`advisor_spent_${new Date().toISOString().slice(0, 7)}`, '7.5');
  await telegramControl._handle('/advisorbudget 5');
  sent = [];
  await telegramControl._handle('/advisorbudget confirm');

  assert.equal(advisor.monthlyLimitUsd(), 5);
  assert.match(plain(sent[0]), /già stato superato/i, 'la risposta è onesta sull\'effetto reale');
  assert.equal(advisor.budget().exceeded, true);
  db.db.prepare('DELETE FROM settings WHERE key = ?').run(`advisor_spent_${new Date().toISOString().slice(0, 7)}`);
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
