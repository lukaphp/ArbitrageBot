---
name: perps-bot-operations
description: Procedures for managing automated trading bots on perps exchanges, focusing on safety, multi-user isolation, and risk management.
version: 0.3.0
author: Hermes
metadata:
  hermes:
    tags: [Trading, Crypto, Automation, RiskManagement, MCP, Guardrails]
---

# Perpetual Trading Bot Operations & MCP Guardrails Protocol

This skill outlines operational procedures for managing autonomous trading bots on perpetual exchanges via the ArbitrageBot Model Context Protocol (MCP) server.

## 💡 Operational Best Practice: The Multi-Bot Strategy
When scaling, maintain distinct operational logic per asset:
1. **Conservatives (e.g. Bisturi):** Lower leverage, wide SL (3%+), strict vol filters (1.5x+). Focus on high SNR (Signal-to-Noise).
2. **Aggressives (e.g. Trend Rider):** Adaptive leverage (up to 5x), rapid TF (15m), trend-momentum triggers (e.g. MACD). 
3. **Operational Visibility:** All bot activity must be routed via `actor_label: "Hermes"` and linked via `is_managed_by_agent: true` to ensure the dashboard correctly identifies and distinguishes activity.

## 🛡️ Mandatory Pre-Flight Guardrails Protocol

Every MCP command directed to a bot must pass the deterministic Pre-Flight Validation filter before reaching SQLite or Hyperliquid:

### 1. Risk Ceiling Hard-Gate
- **Max Account Leverage:** Hard limit capped at **5x**. Any order or bot registration requesting leverage > 5x is rejected with `GUARDRAIL_VIOLATION: Max Account Leverage exceeded`.
- **Account Exposure:** Aggregated open position notionals + requested order notional cannot exceed `maxPositionUsd` (or `max_allocation_usd`). Rejections return `GUARDRAIL_VIOLATION: Account Exposure exceeded`.
- **Daily Loss Limit:** If the bot's `daily_pnl` is negative beyond the configured threshold (`maxDailyLossUsd`), all new entry orders are strictly blocked (`GUARDRAIL_VIOLATION: Daily Loss Limit exceeded`).

### 2. Order Velocity Gate (Anti-Loop)
- A mandatory **10-second cooldown** is enforced between consecutive orders placed by the same bot to prevent loop/runaway states. Attempting rapid orders returns `GUARDRAIL_VIOLATION: Order velocity limit exceeded`.

### 3. Instruction Override & Blacklist
- The MCP server verifies assets against user and system blacklists. Attempting to trade or register blacklisted assets returns `GUARDRAIL_VIOLATION: Asset Blacklisted (<coin>)`.

### 4. Confirm Execution Mode (Two-Stage 60-Second TTL)
Critical operations (`emergency_shutdown`, `update_strategy_params`, and `delete_bot`) enforce a two-stage confirmation protocol:
- **Stage 1 (Prompt):** Invoking without a token generates a single-use `confirmation_token` valid for **60 seconds**, returning `status: "confirmation_required"` with an action summary.
- **Stage 2 (Execution):** Re-invoking the command with `confirmation_token: "<token>"` executes the action, consumes the token (anti-replay), and broadcasts updates to the UI.

---

## 🛠️ Registered MCP Tools

1. `mcp__arbitragebot__get_system_snapshot`
   - **Arguments:** `{}`
   - **Returns:** Consolidated health (kill-switch, active bots), portfolio equity, total P&L, open positions uPNL, and system alerts.

2. `mcp__arbitragebot__bot_control`
   - **Arguments:** `{"bot_id": "<uuid>", "action": "start" | "stop" | "restart"}`
   - **Safe-guards:** Validates process state, handles crash recovery, and synchronizes memory & SQLite.

3. `mcp__arbitragebot__place_order_paper`
   - **Arguments:** `{"bot_id": "<uuid>", "side": "long" | "short", "size": <float>, "entry_price": <float (optional)>, "leverage": <int (1-5, optional)>}`
   - **Safe-guards:** Filtered by Risk Ceiling (leverage <= 5x, maxPositionUsd, daily loss limit), Order Velocity (10s cooldown), and Blacklist.

4. `mcp__arbitragebot__register_bot`
   - **Arguments:** `{"name": "<string>", "coin": "<string>", "config": <object (optional)>, "actor_label": "Hermes", "actor_id": "hermes_agent_01", "is_managed_by_agent": true, "auto_start": false}`
   - **Safe-guards:** Pre-flight validation on leverage (max 5x), maxPositionUsd, asset blacklist check. Creates bot record in SQLite, instantiates in memory runtime, and emits WebSocket refresh events.

5. `mcp__arbitragebot__delete_bot`
   - **Arguments:** `{"bot_id": "<uuid>", "confirmation_token": "<token (optional)>"}`
   - **Safe-guards:** Two-stage confirmation (60s TTL). Deletes bot from DB & runtime memory, stopping any active loops.

6. `mcp__arbitragebot__emergency_shutdown`
   - **Arguments:** `{"confirmation_token": "<token (optional)>", "threshold": <float (optional)>}`
   - **Safe-guards:** Two-stage confirmation (60s TTL). Instantly halts all active bots and engages global kill-switch.

7. `mcp__arbitragebot__update_strategy_params`
   - **Arguments:** `{"bot_id": "<uuid>", "params": {"leverage": 4, "maxPositionUsd": 800, "takeProfitPct": 0.05}, "confirmation_token": "<token (optional)>"}`
   - **Safe-guards:** Two-stage confirmation (60s TTL). Updates SQLite DB, reloads runtime memory cache, and emits WebSocket refresh.

All tool executions are audited in SQLite with `actor: "hermes_mcp_call"`.
