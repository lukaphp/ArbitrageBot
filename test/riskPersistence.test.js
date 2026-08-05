import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PerpsDatabase } from '../src/db/database.js';

test('risk equity history: persiste campioni e drawdown tra connessioni SQLite', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-risk-'));
  const dbPath = path.join(tempDir, 'perps.db');
  const network = 'testnet';
  const address = '0xABCDEF';

  try {
    const first = new PerpsDatabase({ dbPath });
    first.init();
    first.insertRiskEquitySample(network, address, 100, 1000, 180);
    first.insertRiskEquitySample(network, address, 101, 1200, 180);
    first.insertRiskEquitySample(network, address, 102, 1080, 180);
    const drawdown = {
      peak: 1200,
      current: 1080,
      maxUsd: 120,
      maxPct: 10,
      currentUsd: 120,
      currentPct: 10,
      scope: 'session'
    };
    first.upsertRiskDrawdownState(network, address, drawdown, 102000);
    first.close();

    const reopened = new PerpsDatabase({ dbPath });
    reopened.init();
    assert.deepEqual(reopened.listRiskEquityHistory(network, address), [
      { time: 100, value: 1000 },
      { time: 101, value: 1200 },
      { time: 102, value: 1080 }
    ]);
    assert.deepEqual(reopened.getRiskDrawdownState(network, address), {
      peakEquity: 1200,
      currentEquity: 1080,
      maxDrawdownUsd: 120,
      maxDrawdownPct: 10,
      currentDrawdownUsd: 120,
      currentDrawdownPct: 10,
      updatedAt: 102000,
      scope: 'session'
    });
    reopened.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('risk equity history: aggiorna lo stesso timestamp e conserva gli ultimi campioni', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrage-risk-limit-'));
  const dbPath = path.join(tempDir, 'perps.db');
  const database = new PerpsDatabase({ dbPath });

  try {
    database.init();
    database.insertRiskEquitySample('testnet', '0xabc', 1, 10, 2);
    database.insertRiskEquitySample('testnet', '0xabc', 2, 20, 2);
    database.insertRiskEquitySample('testnet', '0xabc', 2, 25, 2);
    database.insertRiskEquitySample('testnet', '0xabc', 3, 30, 2);
    assert.deepEqual(database.listRiskEquityHistory('testnet', '0xabc', 2), [
      { time: 2, value: 25 },
      { time: 3, value: 30 }
    ]);
  } finally {
    database.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
