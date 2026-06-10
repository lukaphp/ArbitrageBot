import { test } from 'node:test';
import assert from 'node:assert/strict';
import execQueue from '../src/perps/execQueue.js';

test('serializza FIFO le azioni dello stesso master', async () => {
  const order = [];
  const mk = (id, ms) => () => new Promise(r => setTimeout(() => { order.push(id); r(id); }, ms));
  const M = '0xMASTER';
  await Promise.all([
    execQueue.run(M, mk('A', 30)),
    execQueue.run(M, mk('B', 5)),
    execQueue.run(M, mk('C', 1))
  ]);
  assert.deepEqual(order, ['A', 'B', 'C']); // ordine di accodamento, non di durata
});

test('master diversi non si bloccano a vicenda', async () => {
  const order = [];
  await Promise.all([
    execQueue.run('0xX', () => new Promise(r => setTimeout(() => { order.push('X'); r(); }, 20))),
    execQueue.run('0xY', () => new Promise(r => setTimeout(() => { order.push('Y'); r(); }, 5)))
  ]);
  assert.deepEqual(order, ['Y', 'X']); // Y più veloce finisce prima
});

test('un errore in coda non blocca le azioni successive', async () => {
  const M = '0xERR';
  const results = [];
  const p1 = execQueue.run(M, async () => { throw new Error('boom'); }).catch(e => e.message);
  const p2 = execQueue.run(M, async () => 'ok');
  results.push(await p1, await p2);
  assert.deepEqual(results, ['boom', 'ok']);
});
