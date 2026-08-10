/**
 * ADV-01 · fase 0: contabilità token/costo condivisa (`src/agents/usage.js`).
 * ==========================================================================
 *
 * L'estrazione da `analyst/analyst.js` è un refactor a rischio basso, ma il suo
 * scopo — «una sola contabilità, non due che divergono» — va verificato in due
 * modi diversi, perché sono due affermazioni diverse:
 *
 *  1. la matematica è quella giusta (caching: scrittura 1.25x, rilettura 0.1x;
 *     tier di prezzo scelto per sottostringa del nome modello). Numeri calcolati
 *     a mano nel test, non ripresi dal codice sotto test;
 *  2. l'estrazione è reale e non una copia: `analyst.js` non deve più
 *     DEFINIRE `priceOf`/`simulateRun`/`moveCacheBreakpoint`, deve importarle.
 *     Un test funzionale non lo vedrebbe (due copie identiche passerebbero
 *     entrambe), quindi qui si guarda il sorgente. È la stessa classe di
 *     verifica dei test che controllano gli id in index.html.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  priceOf, simulateRun, moveCacheBreakpoint, summarizeUsage, accumulateUsage, emptyUsage,
  TOOL_RESULT_CHAR_CAP, TOOL_RESULT_TOKENS, CACHE_WRITE_MULT, CACHE_READ_MULT
} from '../src/agents/usage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANALYST_JS = path.join(HERE, '..', 'src', 'agents', 'analyst', 'analyst.js');

test('priceOf: input, output e i due moltiplicatori di cache', () => {
  // Sonnet di default: $3/1M in, $15/1M out (config.js).
  const cost = priceOf('claude-sonnet-4-6', {
    tokensIn: 1_000_000, tokensOut: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000
  });
  const expected = 3 + 15 + 3 * CACHE_WRITE_MULT + 3 * CACHE_READ_MULT;
  assert.ok(Math.abs(cost - expected) < 1e-9, `atteso ${expected}, ottenuto ${cost}`);
});

test('priceOf: il tier si scegle dal nome modello (haiku costa meno di sonnet, opus di più)', () => {
  const usage = { tokensIn: 1_000_000, tokensOut: 1_000_000 };
  const haiku = priceOf('claude-haiku-4-5', usage);
  const sonnet = priceOf('claude-sonnet-4-6', usage);
  const opus = priceOf('claude-opus-4-1', usage);
  assert.ok(haiku < sonnet && sonnet < opus, `haiku ${haiku} < sonnet ${sonnet} < opus ${opus}`);
  // È la leva di costo #1 dello spike (§4.3): Haiku come default dell'advisor.
  assert.ok(haiku * 2 < sonnet, 'Haiku deve costare almeno la metà di Sonnet, altrimenti la leva non esiste');
});

test('priceOf: modello con tier non riconoscibile → 0, non NaN', () => {
  assert.equal(priceOf('', { tokensIn: 1000 }) >= 0, true);
  assert.ok(Number.isFinite(priceOf('modello-ignoto', { tokensIn: 1000 })));
});

test('simulateRun: una sola iterazione scrive il prefisso in cache e non rilegge nulla', () => {
  const r = simulateRun({ firstInput: 2000, iterations: 1, outputPerIter: 0, finalOutput: 500, toolCallsPerIter: 0 });
  assert.equal(r.cacheWrite, 2000);
  assert.equal(r.cacheRead, 0);
  assert.equal(r.tokensOut, 500);
  assert.equal(r.promptTokens, 2000);
});

test('simulateRun: alla seconda iterazione il prefisso si RILEGGE e solo il delta si riscrive', () => {
  const delta = 100 + 1 * TOOL_RESULT_TOKENS;
  const r = simulateRun({ firstInput: 2000, iterations: 2, outputPerIter: 100, finalOutput: 500, toolCallsPerIter: 1 });
  assert.equal(r.cacheRead, 2000, 'il prefisso della prima iterazione viene riletto');
  assert.equal(r.cacheWrite, 2000 + delta, 'si riscrive solo il delta nuovo');
  assert.equal(r.tokensOut, 100 + 500);
});

test('simulateRun: toolResultTokens è parametrizzabile (default identico a prima dell\'estrazione)', () => {
  const withDefault = simulateRun({ firstInput: 1000, iterations: 2, outputPerIter: 0, finalOutput: 0, toolCallsPerIter: 1 });
  const explicit = simulateRun({ firstInput: 1000, iterations: 2, outputPerIter: 0, finalOutput: 0, toolCallsPerIter: 1, toolResultTokens: TOOL_RESULT_TOKENS });
  assert.deepEqual(withDefault, explicit);
  const smaller = simulateRun({ firstInput: 1000, iterations: 2, outputPerIter: 0, finalOutput: 0, toolCallsPerIter: 1, toolResultTokens: 10 });
  assert.ok(smaller.cacheWrite < withDefault.cacheWrite, 'un cap più basso costa meno prompt');
});

test('TOOL_RESULT_TOKENS deriva dal cap in caratteri (6.000 char ≈ 1.800 token)', () => {
  assert.equal(TOOL_RESULT_CHAR_CAP, 6000);
  assert.ok(TOOL_RESULT_TOKENS > 1700 && TOOL_RESULT_TOKENS < 1900, `token stimati fuori scala: ${TOOL_RESULT_TOKENS}`);
});

test('moveCacheBreakpoint: marca la coda e non accumula più di due breakpoint mobili', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] }
  ];
  const markedTexts = () => messages.flatMap(m => m.content).filter(b => b.cache_control).map(b => b.text);

  moveCacheBreakpoint(messages);
  assert.deepEqual(markedTexts(), ['b'], 'il blocco in coda è marcato');

  messages.push({ role: 'user', content: [{ type: 'text', text: 'c' }] });
  moveCacheBreakpoint(messages);
  // Due breakpoint mobili sono VOLUTI: il precedente serve ancora come prefisso
  // rileggibile mentre il nuovo si scrive. Il limite API è 4 e uno è del system,
  // quindi il tetto è 2 e va rispettato girando.
  assert.deepEqual(markedTexts(), ['b', 'c']);

  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'd' }] });
  moveCacheBreakpoint(messages);
  assert.deepEqual(markedTexts(), ['c', 'd'],
    'il più vecchio viene rilasciato: mai più di due, e sempre i due più recenti');

  messages.push({ role: 'user', content: [{ type: 'text', text: 'e' }] });
  moveCacheBreakpoint(messages);
  assert.deepEqual(markedTexts(), ['d', 'e']);
});

test('moveCacheBreakpoint: contenuto stringa o vuoto non fa esplodere nulla', () => {
  assert.doesNotThrow(() => moveCacheBreakpoint([]));
  assert.doesNotThrow(() => moveCacheBreakpoint([{ role: 'user', content: 'testo semplice' }]));
  assert.doesNotThrow(() => moveCacheBreakpoint([{ role: 'user', content: [] }]));
});

test('summarizeUsage: tokensIn è il TOTALE del prompt fatturato a qualsiasi tariffa', () => {
  const acc = accumulateUsage(emptyUsage(), {
    input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700, output_tokens: 50
  });
  const s = summarizeUsage('claude-haiku-4-5', acc);
  assert.equal(s.tokensIn, 1000, 'input + cache_creation + cache_read');
  assert.equal(s.tokensOut, 50);
  assert.ok(Math.abs(s.cacheHitRate - 0.7) < 1e-9, 'quota di prompt riletta da cache');
  assert.ok(s.cost > 0);
});

test('nessuna doppia contabilità: analyst.js importa da usage.js e non ridefinisce nulla', () => {
  const src = fs.readFileSync(ANALYST_JS, 'utf8');
  assert.match(src, /from '\.\.\/usage\.js'/, 'analyst.js importa la contabilità condivisa');
  for (const fn of ['priceOf', 'simulateRun', 'moveCacheBreakpoint']) {
    assert.equal(new RegExp(`function\\s+${fn}\\s*\\(`).test(src), false,
      `analyst.js ridefinisce ${fn}: sarebbe la seconda contabilità che l'estrazione doveva evitare`);
  }
  // Il cap dei tool_result non deve tornare a essere un numero magico locale.
  assert.equal(/slice\(0,\s*6000\)/.test(src), false, 'il cap va letto da TOOL_RESULT_CHAR_CAP, non riscritto a mano');
  assert.match(src, /TOOL_RESULT_CHAR_CAP/);
});
