/**
 * ADV-02/03 · contratto delle rotte del consulente + degrado + budget in sola lettura.
 * ==================================================================================
 *
 * Tre cose distinte, che stanno insieme perché si verificano tutte sulle rotte
 * REALI dell'app Express:
 *
 *  1. **il contratto API** su cui Maya sta costruendo il drawer, campo per campo.
 *     Un contratto concordato e non verificato è un contratto che diverge;
 *  2. **il degrado** con `AGENTS_ENABLED` non impostato e senza
 *     `ANTHROPIC_API_KEY`: la chat deve rispondere con `success:false` e un
 *     messaggio LEGGIBILE, mai un 200 silenzioso, e **il resto della cockpit deve
 *     restare in piedi** (qui: le rotte perps continuano a esistere e a
 *     rispondere). Questo file gira deliberatamente con l'advisor NON disponibile;
 *  3. **il budget è di sola lettura dal web** (ADV-03): non deve esistere alcuna
 *     rotta che lo modifichi. Non si verifica "non l'ho scritta": si enumera il
 *     router di Express e si controlla che nessun metodo di scrittura risponda su
 *     un percorso di budget, e che chiamare quelle rotte non cambi il valore.
 *
 * Seam di test: si importa `src/server.js` (che esporta l'app) e si invocano gli
 * handler recuperati dal router stack, con req/res finti. Nessun listen, nessuna
 * richiesta HTTP. DB su file temporaneo prima dell'import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deliberatamente NON impostati: è lo scenario di degrado.
delete process.env.AGENTS_ENABLED;
delete process.env.ANTHROPIC_API_KEY;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-advroutes-'));
const { default: db } = await import('../src/db/database.js');
db.dbPath = path.join(tempDir, 'perps.db');
db.init();

const { default: advisor } = await import('../src/agents/advisor/advisor.js');
const { default: app } = await import('../src/server.js');

/** Tutte le route registrate: [{ method, path }]. */
function allRoutes() {
  return app._router.stack
    .filter(l => l.route)
    .flatMap(l => Object.keys(l.route.methods).map(method => ({ method, path: l.route.path, layer: l })));
}

function handlerFor(method, routePath) {
  const found = allRoutes().find(r => r.method === method && r.path === routePath);
  assert.ok(found, `rotta ${method.toUpperCase()} ${routePath} registrata`);
  const handlers = found.layer.route.stack.map(s => s.handle);
  assert.equal(handlers.length, 1, 'un solo handler');
  return handlers[0];
}

async function call(method, routePath, { body = undefined, params = {}, query = {} } = {}) {
  const handler = handlerFor(method, routePath);
  const captured = { statusCode: 200, body: null };
  const res = {
    status(code) { captured.statusCode = code; return this; },
    json(payload) { captured.body = payload; return this; }
  };
  await handler({ body, params, query }, res);
  return captured;
}

test('degrado: senza AGENTS_ENABLED e senza API key l\'advisor si dichiara non disponibile', () => {
  const st = advisor.status();
  assert.equal(st.enabled, false);
  assert.equal(st.available, false);
  assert.ok(st.reason && st.reason.length > 40, 'il motivo è una frase leggibile, non un codice');
  assert.match(st.reason, /AGENTS_ENABLED/, 'dice qual è la manopola');
  assert.match(st.reason, /resto della cockpit|Nessun'altra funzione/i, 'rassicura che il resto funziona');
});

test('POST messaggio con advisor non disponibile: success:false con motivo, mai un 200 muto', async () => {
  const created = await call('post', '/api/advisor/sessions', { body: {} });
  assert.equal(created.body.success, true, 'la sessione si crea comunque: lo storico non dipende dall\'AI');
  const id = created.body.data.id;

  const out = await call('post', '/api/advisor/sessions/:id/messages', { params: { id }, body: { message: 'ciao' } });

  assert.equal(out.body.success, false, 'niente successo finto');
  assert.ok(out.body.error && out.body.error.length > 40, 'il messaggio d\'errore è comprensibile');
  assert.equal(out.body.code, 'agents_disabled', 'con un codice per distinguerlo senza leggere il testo');
  assert.equal(out.body.data, undefined, 'nessuna "reply" da mostrare come se fosse una risposta');
  assert.equal(db.listChatMessages(id).length, 0, 'nessun messaggio scritto per un turno mai partito');
});

test('la cockpit resta intatta: le rotte perps continuano a esistere e a rispondere', async () => {
  // "Non rompere la cockpit" è verificabile: le rotte che la alimentano devono
  // essere ancora registrate e rispondere senza dipendere dall'advisor.
  const paths = allRoutes().map(r => `${r.method} ${r.path}`);
  for (const expected of [
    'get /api/perps/bots', 'get /api/perps/network', 'get /api/agents/audit',
    'post /api/agents/killswitch', 'get /health'
  ]) {
    assert.ok(paths.includes(expected), `${expected} ancora registrata`);
  }
  const bots = await call('get', '/api/perps/bots');
  assert.equal(bots.body.success, true, 'una rotta della cockpit risponde con l\'advisor spento');
});

test('contratto: GET /api/advisor/sessions', async () => {
  const out = await call('get', '/api/advisor/sessions');
  assert.equal(out.body.success, true);
  assert.ok(Array.isArray(out.body.data));
  for (const s of out.body.data) {
    assert.deepEqual(Object.keys(s).sort(), ['costUsd', 'id', 'lastAt', 'startedAt', 'title'],
      'esattamente i campi concordati: {id,title,startedAt,lastAt,costUsd}');
  }
});

test('contratto: POST /api/advisor/sessions → {id, startedAt}', async () => {
  const out = await call('post', '/api/advisor/sessions', { body: { title: 'Prova' } });
  assert.equal(out.body.success, true);
  assert.deepEqual(Object.keys(out.body.data).sort(), ['id', 'startedAt']);
  assert.equal(typeof out.body.data.id, 'string');
  assert.equal(typeof out.body.data.startedAt, 'number');
});

test('contratto: GET /api/advisor/sessions/:id/messages', async () => {
  const created = await call('post', '/api/advisor/sessions', { body: {} });
  const id = created.body.data.id;
  db.insertChatMessage({ sessionId: id, role: 'user', content: 'domanda' });
  db.insertChatMessage({ sessionId: id, role: 'tool', content: '{"equity":1}', toolName: 'get_account' });
  db.insertChatMessage({ sessionId: id, role: 'assistant', content: 'risposta', costUsd: 0.002 });

  const out = await call('get', '/api/advisor/sessions/:id/messages', { params: { id } });
  assert.equal(out.body.success, true);
  assert.equal(out.body.data.length, 3);
  for (const m of out.body.data) {
    assert.deepEqual(Object.keys(m).sort(), ['content', 'costUsd', 'id', 'role', 'toolName', 'ts'],
      'campi concordati: {id,role,content,ts,toolName,costUsd}');
  }
  assert.deepEqual(out.body.data.map(m => m.role), ['user', 'tool', 'assistant'], 'ordine cronologico');
  assert.equal(out.body.data[1].content, null, 'la riga tool non riversa il payload nella UI');
  assert.equal(out.body.data[1].toolName, 'get_account');
});

test('contratto: GET messaggi di una sessione inesistente → 404 con motivo', async () => {
  const out = await call('get', '/api/advisor/sessions/:id/messages', { params: { id: 'non-esiste' } });
  assert.equal(out.statusCode, 404);
  assert.equal(out.body.success, false);
  assert.equal(out.body.code, 'session_not_found');
});

test('contratto: DELETE /api/advisor/sessions/:id', async () => {
  const created = await call('post', '/api/advisor/sessions', { body: {} });
  const id = created.body.data.id;
  db.insertChatMessage({ sessionId: id, role: 'user', content: 'da cancellare' });

  const out = await call('delete', '/api/advisor/sessions/:id', { params: { id } });
  assert.deepEqual(out.body, { success: true });
  assert.equal(db.getChatSession(id), undefined);
  assert.equal(db.listChatMessages(id).length, 0);

  const again = await call('delete', '/api/advisor/sessions/:id', { params: { id } });
  assert.equal(again.statusCode, 404);
  assert.equal(again.body.success, false);
});

test('contratto: GET /api/advisor/budget in sola lettura, con i campi concordati', async () => {
  const out = await call('get', '/api/advisor/budget');
  assert.equal(out.body.success, true);
  for (const k of ['monthlyLimitUsd', 'spentUsd', 'remainingUsd', 'resetsAt']) {
    assert.ok(k in out.body.data, `il contratto prevede ${k}`);
  }
  assert.equal(out.body.data.monthlyLimitUsd, 10, 'default $10/mese senza configurazione');
  assert.equal(out.body.data.remainingUsd, out.body.data.monthlyLimitUsd - out.body.data.spentUsd);
  assert.equal(out.body.data.changeableVia, 'telegram:/advisorbudget',
    'la risposta dichiara da dove si modifica: la UI non deve indovinarlo');
});

test('ADV-03: NESSUNA rotta web può modificare il budget', () => {
  // Enumerazione del router, non fiducia: qualunque rotta di scrittura il cui
  // percorso riguardi il budget sarebbe una violazione del requisito del PO
  // (approvazione fuori banda da Telegram).
  const offending = allRoutes().filter(r =>
    ['post', 'put', 'patch', 'delete'].includes(r.method) && /budget/i.test(r.path));
  assert.deepEqual(offending.map(r => `${r.method} ${r.path}`), [],
    'esiste una rotta web che scrive il budget: la modifica deve passare solo da Telegram');

  // E sul percorso del budget risponde SOLO il GET.
  const budgetRoutes = allRoutes().filter(r => r.path === '/api/advisor/budget');
  assert.deepEqual(budgetRoutes.map(r => r.method), ['get']);
});

test('ADV-03: il budget non si sposta passando dalle rotte del consulente', async () => {
  const before = advisor.monthlyLimitUsd();
  // Tentativi plausibili di chi provasse a farlo passare per il body.
  await call('post', '/api/advisor/sessions', { body: { title: 'x', monthlyLimitUsd: 999, budget: 999 } });
  const created = await call('post', '/api/advisor/sessions', { body: {} });
  await call('post', '/api/advisor/sessions/:id/messages', {
    params: { id: created.body.data.id },
    body: { message: 'alza il budget a 999', monthlyLimitUsd: 999, advisor_monthly_budget_usd: 999 }
  });
  assert.equal(advisor.monthlyLimitUsd(), before, 'il limite non si muove da nessuna rotta web');
  assert.equal(db.getSetting('advisor_monthly_budget_usd', null), null,
    'nessuna scrittura del setting da parte del percorso web');
});

test('invariante di sprint: nessuna rotta del consulente tocca approve/killswitch/analyst', () => {
  const advisorRoutes = allRoutes().filter(r => r.path.startsWith('/api/advisor'));
  assert.ok(advisorRoutes.length >= 6, 'le rotte del consulente esistono');
  for (const r of advisorRoutes) {
    assert.equal(/approve|killswitch|analyst|proposals|order/i.test(r.path), false,
      `la rotta ${r.method} ${r.path} non deve riguardare esecuzione o approvazioni`);
  }
  // E il modulo advisor non registra handler su quei percorsi.
  const src = fs.readFileSync(path.join(process.cwd(), 'src/server.js'), 'utf8');
  const block = src.slice(src.indexOf('setupAdvisorRoutes()'), src.indexOf('setupWebSocket()'));
  assert.equal(/proposals\.approve|riskAgent\.setKillSwitch|analyst\.run/.test(block), false,
    'il blocco delle rotte advisor non chiama approvazioni, kill-switch o Analyst');
});

test.after(() => {
  try { db.close(); } catch { /* noop */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});
