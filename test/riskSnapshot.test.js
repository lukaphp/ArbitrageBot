import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDrawdown, deriveRiskAlerts, summarizeRisk } from '../src/perps/riskSnapshot.js';

test('calculateDrawdown: misura il picco e il drawdown massimo di sessione', () => {
  const result = calculateDrawdown([
    { value: 1000 },
    { value: 1200 },
    { value: 1080 },
    { value: 1150 }
  ]);
  assert.equal(result.peak, 1200);
  assert.equal(result.maxUsd, 120);
  assert.equal(result.maxPct, 10);
  assert.ok(Math.abs(result.currentPct - 4.166666666666667) < 1e-12);
});

test('deriveRiskAlerts: segnala esposizione, margine, ordini e feed', () => {
  const alerts = deriveRiskAlerts({
    now: Date.UTC(2026, 0, 1, 12, 0, 0),
    account: {
      equity: 1000,
      totalMarginUsed: 700,
      totalNtlPos: 1200,
      positions: [{ positionValue: 1200 }]
    },
    limits: {
      maxTotalExposureUsd: 1000,
      maxConcurrentPositions: 3,
      marginWarningPct: 60,
      marginCriticalPct: 80
    },
    orders: [{ isTrigger: false }],
    marketStatus: { isRunning: true, ws: false, wsFresh: false }
  });
  assert.ok(alerts.some(alert => alert.id === 'exposure-limit'));
  assert.ok(alerts.some(alert => alert.id === 'margin-warning'));
  assert.ok(alerts.some(alert => alert.id === 'pending-orders'));
  assert.ok(alerts.some(alert => alert.id === 'market-ws-disconnected'));
});

test('summarizeRisk: kill-switch forza lo stato blocked', () => {
  const summary = summarizeRisk([{ severity: 'warning' }], { killSwitch: true });
  assert.equal(summary.status, 'blocked');
  assert.equal(summary.warning, 1);
  assert.equal(summary.actionable, 1);
});
