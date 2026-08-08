---
name: arbitragebot-conventions
description: Use when writing, editing, or reviewing source code, tests, or dependency changes in the ArbitrageBot Perps project — before committing a code style choice, adding a test, touching order/trigger logic, or modifying package.json or package-lock.json.
---

# ArbitrageBot Conventions

## Overview

ArbitrageBot Perps (Hyperliquid trading bot) has consistent, load-bearing conventions across its codebase. They are not style preferences — the architectural ones (strategy/risk separation, order sequencing) exist because violating them has caused real bugs (see SEC-01, Sprint 1). Reference type: project conventions, not a discipline/process skill.

## Quick Reference

| Area | Convention |
|---|---|
| Language | ESM only (`import`/`export`, `"type": "module"`) |
| Comments | Italian, in the existing file's language — never switch languages mid-file |
| Comment style | JSDoc-like block at the top of non-trivial functions/files, explaining **why**, not just what |
| Logging | `logger` from `../utils/logger.js` — never `console.log` in `src/` |
| User-facing alerts | `notifier.notify(...)` (Telegram), same emoji/HTML style as existing calls |
| Money-handling changes | Land in `riskManager.js` (pure calculation) + I/O shell in `bot.js`, never inline math in the I/O layer |
| Order updates (TP/SL/trailing) | **Place-then-cancel**, always — see below |
| Tests touching the DB | Isolated temp SQLite file, never `data/perps.db` |
| Tests touching the exchange | `paperBroker`, never a real network call |
| `package-lock.json` diffs | Line-by-line review — see Supply Chain below |
| Commits | `<tipo>(<scope>): <descrizione>` — see Commit Style below |

## Architectural Separation: Strategy vs Risk

`strategyEngine.js` decides *what* to do (rule evaluation, signals). `riskManager.js` and `portfolio.js` decide *whether it's allowed* (sizing, TP/SL math, portfolio limits) — deterministically, the same inputs always give the same output, and the AI advisory layer (`agents/analyst/`) cannot bypass it. Don't blur this: a new rule type belongs in `strategyEngine.js`; a new risk calculation belongs in `riskManager.js`. `bot.js` orchestrates both but contains no decision logic of its own.

## Order Sequencing: Place-Then-Cancel

Any time a trigger order (TP/SL/trailing) is replaced, the new one is placed and confirmed **before** the old one is cancelled — never the reverse. A position must never have a window with zero protection.

```js
// 1) PLACE the new trigger
const res = await this.broker.placeTriggerOrder({ ... });
// 2) Update in-memory state + DB — protection is now live via the NEW trigger
this.position.slOid = res.oid;
db.updatePosition(this.position.id, { ... });
// 3) Only now CANCEL the old one
if (oldOid && oldOid !== res.oid) {
  await this.broker.cancelOrder({ ... }).catch(() => {});
}
```

See `_updateTrailing` and `_repriceTpSlAfterDca` in `src/perps/bot.js` for the canonical implementations. If a replacement fails partway, log **and** notify — never fail silently on a money-handling path (see `riskManager.js` `sizePosition` guard for the same principle applied to input validation).

## Testing Patterns

- **Exchange calls:** use `paperBroker` (`src/perps/paperBroker.js`), the same simulated broker used in production for forward-testing. It exposes `getFrontendOpenOrders()` to inspect trigger size/price after an action — this is how to assert TP/SL correctness without touching Hyperliquid.
- **Database:** import the `PerpsDatabase` class (not the default singleton `db`) and point it at a temp file via `fs.mkdtempSync`, or redirect the singleton's `dbPath` before first `init()` inside the same test process (`node:test` runs each file in its own process, so this doesn't leak across suites). Never let a test touch `data/perps.db`.
- **Price mocking:** `client.getMid = async () => MID` and `client.roundPx = (px) => ...` — see `test/paperBroker.test.js` and `test/botDca.test.js` for the pattern.
- A test that can't cover the full I/O path honestly (e.g. it would require mocking too many singletons) should extract the pure calculation into `riskManager.js` and test *that* in isolation, then say explicitly in the PR what remains uncovered — don't force a fragile end-to-end test just to have one.

## Supply Chain / `package-lock.json`

Every PR touching the lockfile gets line-by-line review of added/changed dependencies: download count, publish date, presence of `postinstall`/`preinstall` scripts, name similarity to a known package (typosquatting — e.g. `big-nunber` vs `bignumber.js`), and recent maintainer changes. `npm audit --audit-level=high` and `npm audit signatures` run in CI as a complement to human review, not a substitute — neither catches typosquatting or not-yet-reported malicious packages. Full detail: `CONTRIBUTING.md`.

## Commit Style

```
<tipo>(<scope>): <descrizione>
```
`tipo`: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`. `scope` often `perps` for trading-module changes. Description in Italian or English — match the commits immediately around what you're touching, don't introduce a third language.

## Common Mistakes

- Writing a new risk calculation inline in `bot.js` instead of `riskManager.js` — makes it untestable in isolation and easy to diverge from the backtester (which reuses `riskManager.js` directly).
- Cancelling an old trigger order before the new one is confirmed placed — the exact bug class SEC-01 fixed.
- A test that imports the default `db` singleton without redirecting `dbPath` first — silently reads/writes `data/perps.db`.
- Switching a file's comment language mid-edit because the change itself is more naturally described in the other language — match the file, not the diff.
