/**
 * PERPS TRADING UI (Hyperliquid)
 * ==============================
 * Gestisce la vista "Perps": account/agent, ordini manuali, posizioni e bot
 * auto-pilot. Riusa la connessione MetaMask e i toast/modali di app.js.
 */

// Strategie pronte per la modalità semplificata: il "consulente" le traduce
// in regole tecniche (RSI/EMA/MACD/Bollinger).
const BOT_STRATEGIES = {
  rsi_reversal: {
    name: 'Rimbalzo ipervenduto', emoji: '🔄', tag: 'Conservativa',
    desc: 'Compra quando il mercato è ipervenduto (RSI sotto 30) e vende quando è ipercomprato (RSI sopra 70).',
    when: 'Funziona meglio nei mercati laterali, senza trend forti.',
    build: () => ({
      direction: 'both', candleInterval: '15m', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' },
        { type: 'indicator', indicator: 'rsi', period: 14, op: '>', value: 70, signal: 'short' }
      ],
      exitRules: []
    })
  },
  ema_trend: {
    name: 'Segui il trend', emoji: '📈', tag: 'Moderata',
    desc: 'Va Long quando il prezzo è sopra la media mobile EMA50, Short quando è sotto.',
    when: 'Ideale nei mercati direzionali, con trend chiari al rialzo o al ribasso.',
    build: () => ({
      direction: 'both', candleInterval: '1h', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'ema', period: 50, compareToPrice: true, op: '>', signal: 'long' },
        { type: 'indicator', indicator: 'ema', period: 50, compareToPrice: true, op: '<', signal: 'short' }
      ],
      exitRules: []
    })
  },
  macd_momentum: {
    name: 'Momentum (MACD)', emoji: '⚡', tag: 'Moderata',
    desc: 'Entra Long quando il MACD diventa positivo, Short quando diventa negativo.',
    when: 'Buona per cavalcare movimenti decisi e veloci.',
    build: () => ({
      direction: 'both', candleInterval: '15m', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'macd', cond: 'bullish', signal: 'long' },
        { type: 'indicator', indicator: 'macd', cond: 'bearish', signal: 'short' }
      ],
      exitRules: []
    })
  },
  bollinger: {
    name: 'Bande di Bollinger', emoji: '🎯', tag: 'Conservativa',
    desc: 'Compra quando il prezzo tocca la banda inferiore, vende quando tocca la superiore.',
    when: 'Reversione alla media: meglio nei mercati laterali e volatili.',
    build: () => ({
      direction: 'both', candleInterval: '15m', logic: 'any',
      entryRules: [
        { type: 'indicator', indicator: 'bollinger', cond: 'below_lower', signal: 'long' },
        { type: 'indicator', indicator: 'bollinger', cond: 'above_upper', signal: 'short' }
      ],
      exitRules: []
    })
  }
};

const RISK_PROFILES = {
  conservativo: { name: 'Conservativo', emoji: '🟢', leverage: 2, sizingPercent: 5, tp: 1.5, sl: 1, trailing: 0, maxDailyLoss: 50, maxPosition: 500,
    desc: 'Leva bassa, posizioni piccole, stop stretti. Priorità alla protezione del capitale.' },
  moderato: { name: 'Moderato', emoji: '🟡', leverage: 3, sizingPercent: 10, tp: 3, sl: 1.5, trailing: 1, maxDailyLoss: 100, maxPosition: 1000,
    desc: 'Equilibrio tra rischio e rendimento, con trailing stop attivo.' },
  aggressivo: { name: 'Aggressivo', emoji: '🔴', leverage: 5, sizingPercent: 20, tp: 6, sl: 3, trailing: 2, maxDailyLoss: 300, maxPosition: 3000,
    desc: 'Leva e size elevate, obiettivi di profitto ampi. Rischio maggiore.' }
};

class PerpsApp {
  constructor() {
    this.markets = [];
    this.mids = {};
    this.bots = [];
    this.account = null;
    this.network = 'testnet';
    this.socket = null;
    this.shown = false;
    this.accountTimer = null;
    this.botMode = 'simple';
    this.selStrategy = null;
    this.selRisk = 'moderato';
    this.posTab = 'open';
  }

  // ---- Helpers ----
  get address() { return app?.walletAddress || null; }
  get connected() { return !!app?.isConnected; }
  toast(msg, type = 'info') { app?.showToast ? app.showToast(msg, type) : alert(msg); }

  async api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(data.error || `Errore ${res.status}`);
    }
    return data.data ?? data;
  }

  fmtUsd(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  fmtNum(n, d = 4) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
  }

  // ---- Lifecycle ----
  async onShow() {
    if (!this.socket) this._initSocket();
    await this.loadNetwork();
    await this.loadMarkets();
    await this.refreshAccount();
    await this.loadBots();
    await this.loadPortfolio();
    await this.loadNotifications();
    await this.loadAgents();
    if (!this.accountTimer) {
      this.accountTimer = setInterval(() => {
        if (!document.getElementById('view-perps').classList.contains('hidden')) {
          this.refreshAccount();
        }
      }, 8000);
    }
    this.shown = true;
  }

  _initSocket() {
    this.socket = app?.socket || (window.io ? window.io() : null);
    if (!this.socket) return;
    this.socket.on('perps:price', (d) => { this.mids = d.mids || {}; this._updateMid(); });
    this.socket.on('perps:botUpdate', (state) => this._updateBotCard(state));
    this.socket.on('perps:agentStatus', () => this.refreshAccount());
    this.socket.on('perps:position', () => { this.refreshAccount(); if (this.posTab === 'history') this.loadFills(); });
    this.socket.on('perps:fill', () => { this.refreshAccount(); if (this.posTab === 'history') this.loadFills(); });
  }

  // ---- Network ----
  async loadNetwork() {
    try {
      const d = await this.api('/api/perps/network');
      this.network = d.network;
      document.querySelectorAll('.net-pill').forEach(p =>
        p.classList.toggle('active', p.dataset.net === this.network));
      this._updateFaucetVisibility();
    } catch (e) { /* ignore */ }
  }

  async setNetwork(net) {
    if (net === this.network) return;
    let confirmMainnet = false;
    if (net === 'mainnet') {
      if (!confirm('⚠️ Passare a MAINNET significa operare con FONDI REALI. Confermi?')) return;
      confirmMainnet = true;
    }
    try {
      await this.api('/api/perps/network', {
        method: 'POST',
        body: JSON.stringify({ network: net, confirm: confirmMainnet })
      });
      this.network = net;
      this.toast(`Rete Perps: ${net.toUpperCase()}`, 'info');
      await this.loadNetwork();
      await this.loadMarkets();
      await this.refreshAccount();
      await this.loadBots();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  // ---- Markets ----
  async loadMarkets() {
    try {
      this.markets = await this.api('/api/perps/markets');
      const opts = this.markets.map(m =>
        `<option value="${m.coin}">${m.name} · max ${m.maxLeverage}x</option>`).join('');
      const sel1 = document.getElementById('orderMarket');
      const sel2 = document.getElementById('botMarket');
      if (sel1) sel1.innerHTML = opts;
      if (sel2) sel2.innerHTML = opts;
      this.mids = {};
      this.markets.forEach(m => { if (m.mid) this.mids[m.coin] = m.mid; });
      this._updateMid();
    } catch (e) { this.toast('Mercati Perps: ' + e.message, 'error'); }
  }

  _updateMid() {
    const sel = document.getElementById('orderMarket');
    const el = document.getElementById('orderMid');
    if (!sel || !el) return;
    const px = this.mids[sel.value] ?? this.mids[sel.value?.replace('-PERP', '')];
    el.textContent = px ? this.fmtUsd(parseFloat(px)) : '—';
  }

  // ---- Account & Agent ----
  async refreshAccount() {
    const notConn = document.getElementById('perpsNotConnected');
    const body = document.getElementById('perpsAccountBody');
    if (!this.connected) {
      notConn?.classList.remove('hidden');
      body?.classList.add('hidden');
      return;
    }
    notConn?.classList.add('hidden');
    body?.classList.remove('hidden');

    try {
      const acc = await this.api('/api/perps/account?address=' + this.address);
      this.account = acc;
      // Mostra l'equity utilizzabile (Perp + Spot, account unificati)
      document.getElementById('perpsEquity').textContent = this.fmtUsd(acc.equity ?? acc.accountValue);
      document.getElementById('perpsMargin').textContent = this.fmtUsd(acc.totalMarginUsed);
      document.getElementById('perpsWithdrawable').textContent = this.fmtUsd(acc.withdrawable);
      document.getElementById('perpsPosCount').textContent = acc.positions.length;
      this._updateFaucetBadge(acc.accountValue);
      this._updateSpotTransfer(acc.spotUsdc || 0);
      this._allPositions = acc.positions;
      this._populatePosBotFilter();
      this.applyPosFilter();
    } catch (e) {
      // Account inesistente su HL = equity 0 (non un errore bloccante)
      this._updateFaucetBadge(0);
      this._updateSpotTransfer(0);
      this._renderPositions([]);
    }
    await this._refreshAgentStatus();
  }

  _updateSpotTransfer(spotUsdc) {
    this._spotUsdc = spotUsdc;
    const box = document.getElementById('spotTransfer');
    const bal = document.getElementById('spotBalance');
    if (bal) bal.textContent = this.fmtUsd(spotUsdc);
    if (box) box.classList.toggle('hidden', !(spotUsdc > 0.01) || this.network !== 'testnet');
  }

  fillTransferMax() {
    const inp = document.getElementById('transferAmount');
    if (inp && this._spotUsdc) inp.value = Math.floor(this._spotUsdc * 100) / 100;
  }

  async transferToPerp() {
    if (!this.connected) return this.toast('Connetti MetaMask', 'warning');
    const amount = parseFloat(document.getElementById('transferAmount').value);
    if (!amount || amount <= 0) return this.toast('Inserisci un importo valido', 'warning');
    try {
      this.toast('Preparazione trasferimento...', 'info');
      const chainId = await window.ethereum.request({ method: 'eth_chainId' });
      const prep = await this.api('/api/perps/transfer/prepare', {
        method: 'POST',
        body: JSON.stringify({ address: this.address, amount, toPerp: true, signatureChainId: chainId })
      });
      const { domain, types, message, primaryType } = prep.typedData;
      const fullTypedData = {
        domain, primaryType,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }
          ],
          ...types
        },
        message
      };
      const signature = await window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [this.address, JSON.stringify(fullTypedData)]
      });
      await this.api('/api/perps/transfer/submit', {
        method: 'POST',
        body: JSON.stringify({ address: this.address, action: prep.action, signature })
      });
      this.toast(`✅ Trasferiti ${this.fmtUsd(amount)} a Perps!`, 'success');
      await this.refreshAccount();
    } catch (e) {
      const msg = e.message || String(e);
      if (/unified account/i.test(msg)) {
        // Account unificato: lo Spot è già collaterale, nessun trasferimento necessario
        this.toast('ℹ️ Account unificato: i tuoi USDC Spot sono già utilizzabili come collaterale. Puoi fare trading direttamente.', 'info');
        document.getElementById('spotTransfer')?.classList.add('hidden');
        await this.refreshAccount();
      } else {
        this.toast('Trasferimento fallito: ' + msg, 'error');
      }
    }
  }

  // ---- Faucet testnet ----
  _updateFaucetVisibility() {
    const card = document.getElementById('faucetCard');
    if (card) card.classList.toggle('hidden', this.network !== 'testnet');
  }

  _updateFaucetBadge(equity) {
    const b = document.getElementById('faucetEquityBadge');
    if (!b) return;
    b.textContent = 'Equity: ' + this.fmtUsd(equity);
    b.classList.toggle('funded', equity > 0);
  }

  openFaucet(which) {
    const urls = {
      hyperliquid: 'https://app.hyperliquid-testnet.xyz/drip',
      circle: 'https://faucet.circle.com',
      gas: 'https://faucets.chain.link/arbitrum-sepolia',
      deposit: 'https://app.hyperliquid-testnet.xyz/'
    };
    window.open(urls[which], '_blank', 'noopener');
    // Per i faucet/deposit che alimentano Hyperliquid, avvia il rilevamento fondi
    if (which === 'hyperliquid' || which === 'deposit') {
      if (this.connected) this._watchEquity();
      else this.toast('Connetti MetaMask per rilevare i fondi', 'warning');
    }
  }

  async _watchEquity() {
    if (this._watching) return;
    this._watching = true;
    const watch = document.getElementById('faucetWatch');
    const text = document.getElementById('faucetWatchText');
    watch?.classList.remove('hidden');
    const baseline = this.account?.accountValue || 0;
    let attempts = 0;
    const maxAttempts = 36; // ~3 minuti a 5s
    const tick = async () => {
      attempts++;
      try {
        const acc = await this.api('/api/perps/account?address=' + this.address);
        this.account = acc;
        this._updateFaucetBadge(acc.accountValue);
        if (acc.accountValue > baseline + 0.01) {
          this.toast(`✅ Fondi ricevuti! Equity: ${this.fmtUsd(acc.accountValue)}`, 'success');
          watch?.classList.add('hidden');
          this._watching = false;
          await this.refreshAccount();
          return;
        }
      } catch (e) { /* l'account potrebbe non esistere ancora */ }
      if (attempts >= maxAttempts) {
        if (text) text.textContent = 'Nessun fondo rilevato. Quando completi il faucet, premi "Aggiorna".';
        setTimeout(() => watch?.classList.add('hidden'), 6000);
        this._watching = false;
        return;
      }
      if (text) text.textContent = `In attesa dell'arrivo dei fondi… (${attempts}/${maxAttempts})`;
      setTimeout(tick, 5000);
    };
    setTimeout(tick, 5000);
  }

  async _refreshAgentStatus() {
    try {
      const s = await this.api('/api/perps/agent/status?address=' + this.address);
      const dot = document.querySelector('#agentStatus .agent-dot');
      const text = document.getElementById('agentStatusText');
      const btn = document.getElementById('enableAgentBtn');
      if (s.approved) {
        dot?.classList.remove('offline'); dot?.classList.add('online');
        if (text) text.textContent = 'Auto-trading attivo ✅';
        if (btn) { btn.textContent = '🔄 Rinnova agent'; }
      } else {
        dot?.classList.add('offline'); dot?.classList.remove('online');
        if (text) text.textContent = 'Auto-trading non abilitato';
        if (btn) btn.textContent = '🔑 Abilita auto-trading';
      }
    } catch (e) { /* ignore */ }
  }

  async enableAgent() {
    if (!this.connected) return this.toast('Connetti prima MetaMask', 'warning');
    try {
      this.toast('Generazione agent...', 'info');
      // Firma sul chainId su cui MetaMask è attualmente connesso: MetaMask rifiuta
      // di firmare un dominio EIP-712 con chainId diverso dalla rete attiva.
      // Hyperliquid accetta qualsiasi signatureChainId (ricostruisce il dominio da esso).
      const chainId = await window.ethereum.request({ method: 'eth_chainId' });
      const prep = await this.api('/api/perps/agent/prepare', {
        method: 'POST',
        body: JSON.stringify({ address: this.address, signatureChainId: chainId })
      });
      const { domain, types, message, primaryType } = prep.typedData;
      // Firma EIP-712 direttamente con MetaMask (eth_signTypedData_v4).
      // NON usiamo ethers _signTypedData perché impone che il chainId del dominio
      // coincida con la rete attiva: Hyperliquid richiede invece chainId 421614/42161
      // (solo dominio di firma, non una transazione), indipendente dalla rete connessa.
      const fullTypedData = {
        domain,
        primaryType,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' }
          ],
          ...types
        },
        message
      };
      const signature = await window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [this.address, JSON.stringify(fullTypedData)]
      });
      this.toast('Invio approvazione a Hyperliquid...', 'info');
      await this.api('/api/perps/agent/submit', {
        method: 'POST',
        body: JSON.stringify({ address: this.address, action: prep.action, signature })
      });
      this.toast('✅ Auto-trading abilitato!', 'success');
      await this._refreshAgentStatus();
    } catch (e) {
      this.toast('Errore approvazione agent: ' + (e.message || e), 'error');
    }
  }

  _renderPositions(positions) {
    const tbody = document.getElementById('positionsList');
    const empty = document.getElementById('noPositions');
    if (!tbody) return;
    if (!positions.length) {
      tbody.innerHTML = '';
      empty?.classList.remove('hidden');
      return;
    }
    empty?.classList.add('hidden');
    tbody.innerHTML = positions.map(p => {
      const pnlClass = p.unrealizedPnl >= 0 ? 'profit-positive' : 'profit-negative';
      const coin = p.coin.includes('-PERP') ? p.coin : p.coin + '-PERP';
      const opened = p.openedAt ? new Date(p.openedAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '<span class="muted">—</span>';
      const botCell = p.botName
        ? `<span class="hist-bot">${p.botName === 'Manuale' ? '✋ Manuale' : '🤖 ' + p.botName}</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td>${opened}</td>
        <td>${botCell}</td>
        <td>${p.coin}</td>
        <td><span class="side-badge ${p.side}">${p.side.toUpperCase()}</span></td>
        <td>${this.fmtNum(p.size)}</td>
        <td>${this.fmtUsd(p.entryPx)}</td>
        <td class="${pnlClass}">${this.fmtUsd(p.unrealizedPnl)}</td>
        <td>${p.leverage ? p.leverage + 'x' : '—'}</td>
        <td>${p.liquidationPx ? this.fmtUsd(p.liquidationPx) : '—'}</td>
        <td class="pos-actions">
          <button class="btn btn-sm btn-outline" onclick="perps.openChart('${coin}')">📊</button>
          <button class="btn btn-sm btn-danger" onclick="perps.closePosition('${coin}')">Chiudi</button>
        </td>
      </tr>`;
    }).join('');
  }

  /** Popola il menu dei bot nel filtro delle posizioni aperte. */
  _populatePosBotFilter() {
    const sel = document.getElementById('posBot');
    if (!sel) return;
    const names = [...new Set((this._allPositions || []).map(p => p.botName).filter(Boolean))].sort();
    const cur = sel.value;
    sel.innerHTML = '<option value="">Tutti i bot</option>' + names.map(n => `<option value="${n}">${n}</option>`).join('');
    if (names.includes(cur)) sel.value = cur;
  }

  setPosRange(range) {
    this._posRange = range;
    document.querySelectorAll('.pos-preset').forEach(b => b.classList.toggle('active', b.dataset.range === range));
    const f = document.getElementById('posFrom'); const t = document.getElementById('posTo');
    if (f) f.value = ''; if (t) t.value = '';
    this.applyPosFilter();
  }

  applyPosFilter(fromRange = false) {
    if (fromRange) {
      this._posRange = 'custom';
      document.querySelectorAll('.pos-preset').forEach(b => b.classList.remove('active'));
    }
    let fromTs = 0, toTs = Date.now(), hasDate = false;
    const f = document.getElementById('posFrom')?.value;
    const t = document.getElementById('posTo')?.value;
    if (f || t) { hasDate = true; if (f) fromTs = new Date(f + 'T00:00:00').getTime(); if (t) toTs = new Date(t + 'T23:59:59').getTime(); }
    else { const days = { '1d': 1, '7d': 7, '30d': 30, '365d': 365 }[this._posRange]; if (days) { hasDate = true; fromTs = Date.now() - days * 86400000; } }
    const botFilter = document.getElementById('posBot')?.value || '';
    const filtered = (this._allPositions || []).filter(p => {
      if (botFilter && p.botName !== botFilter) return false;
      // Le posizioni senza data nota restano sempre visibili (non si nasconde una posizione live)
      if (hasDate && p.openedAt != null && !(p.openedAt >= fromTs && p.openedAt <= toTs)) return false;
      return true;
    });
    this._renderPositions(filtered);
  }

  async closePosition(coin) {
    if (!confirm(`Chiudere la posizione su ${coin}?`)) return;
    try {
      await this.api(`/api/perps/positions/${encodeURIComponent(coin)}/close`, {
        method: 'POST',
        body: JSON.stringify({ masterAddress: this.address })
      });
      this.toast('Posizione chiusa', 'success');
      await this.refreshAccount();
      if (this.posTab === 'history') this.loadFills();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  // ---- Rischio portafoglio & notifiche ----
  async loadPortfolio() {
    try {
      const l = await this.api('/api/perps/portfolio');
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      set('pfMaxPositions', l.maxConcurrentPositions);
      set('pfMaxExposure', l.maxTotalExposureUsd);
      set('pfMaxLosses', l.maxConsecutiveLosses);
      set('pfCooldown', l.cooldownMinutes);
    } catch (e) { /* ignore */ }
  }

  async savePortfolio() {
    try {
      await this.api('/api/perps/portfolio', {
        method: 'POST',
        body: JSON.stringify({
          maxConcurrentPositions: parseInt(document.getElementById('pfMaxPositions').value),
          maxTotalExposureUsd: parseFloat(document.getElementById('pfMaxExposure').value),
          maxConsecutiveLosses: parseInt(document.getElementById('pfMaxLosses').value),
          cooldownMinutes: parseInt(document.getElementById('pfCooldown').value)
        })
      });
      this.toast('Limiti di portafoglio salvati', 'success');
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async loadNotifications() {
    try {
      const s = await this.api('/api/perps/notifications');
      const en = document.getElementById('tgEnabled');
      const st = document.getElementById('tgStatus');
      if (en) en.checked = !!s.enabled;
      if (st) st.textContent = s.configured ? '(configurato)' : '(non configurato)';
      this._refreshTgControlStatus();
    } catch (e) { /* ignore */ }
  }

  async _refreshTgControlStatus() {
    const el = document.getElementById('tgControlStatus');
    if (!el) return;
    try {
      const s = await this.api('/api/perps/telegram/status');
      el.textContent = s.running ? '🟢 attivo' : (s.configured ? '⏸️ in pausa' : '⚪ non configurato');
    } catch { /* ignore */ }
  }

  // ---- Agente AI ----
  async loadAgents() {
    try {
      const [status, props] = await Promise.all([
        this.api('/api/agents/status'),
        this.api('/api/agents/proposals?status=pending')
      ]);
      const a = status.analyst || {};
      const st = document.getElementById('agentStatus');
      if (st) {
        if (!a.hasApiKey) st.textContent = '⚪ chiave AI non configurata';
        else if (!a.enabled) st.textContent = '⏸️ disattivato (AGENTS_ENABLED)';
        else st.textContent = `🟢 attivo · ${a.runsThisHour}/${a.maxCallsPerHour} run/h`;
      }
      const ks = document.getElementById('killswitchState');
      if (ks) ks.textContent = status.killSwitch ? '🔴 ATTIVO — aperture bloccate' : '';
      this._renderProposals(props || []);
      await this.loadStrategyHistory();
    } catch (e) { /* ignore */ }
  }

  /** Storico delle strategie AI approvate/rifiutate, con esito live di quelle avviate. */
  async loadStrategyHistory() {
    const box = document.getElementById('strategyHistory');
    if (!box) return;
    try {
      const hist = await this.api('/api/agents/strategy-history');
      if (!hist.length) { box.innerHTML = '<div class="agent-empty">Nessuna strategia decisa finora.</div>'; return; }
      box.innerHTML = hist.map(h => {
        const date = h.decidedAt ? new Date(h.decidedAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        const badge = h.status === 'approved' ? '<span class="sh-badge ok">approvata</span>'
          : h.status === 'rejected' ? '<span class="sh-badge no">rifiutata</span>'
          : '<span class="sh-badge exp">scaduta</span>';
        let outcome = '';
        if (h.status === 'approved') {
          if (!h.linkedBotId) outcome = '<span class="sh-outcome muted">— bot non ancora creato</span>';
          else if (!h.botExists) outcome = '<span class="sh-outcome muted">— bot eliminato</span>';
          else if (!h.outcome || !h.outcome.trades) outcome = `<span class="sh-outcome muted">▶️ ${h.botName} · in attesa di operazioni</span>`;
          else {
            const o = h.outcome;
            const pnlCls = o.totalPnl >= 0 ? 'profit-positive' : 'profit-negative';
            const pf = isFinite(o.profitFactor) ? o.profitFactor.toFixed(2) : '∞';
            outcome = `<span class="sh-outcome">📊 ${h.botName}: ${o.trades} op · WR ${(o.winRate * 100).toFixed(0)}% · PF ${pf} · PnL <span class="${pnlCls}">${this.fmtUsd(o.totalPnl)}</span></span>`;
          }
        }
        return `
        <div class="sh-row">
          <div class="sh-line1">${badge} <b>${h.coin || ''}</b> <span class="muted">${date}</span></div>
          ${h.rationale ? `<div class="sh-rationale">${h.rationale}</div>` : ''}
          ${outcome ? `<div>${outcome}</div>` : ''}
        </div>`;
      }).join('');
    } catch (e) { /* ignore */ }
  }

  _renderProposals(list) {
    const box = document.getElementById('agentProposals');
    if (!box) return;
    this._proposalsById = {};
    if (!list.length) {
      box.innerHTML = '<div class="agent-empty">Nessuna proposta in attesa. L\'AI proporrà azioni quando rileva qualcosa di utile.</div>';
      return;
    }
    box.innerHTML = list.map(p => {
      this._proposalsById[p.id] = p;
      const conf = p.confidence != null ? `${Math.round(p.confidence * 100)}%` : '—';
      const payload = p.payload ? Object.entries(p.payload).filter(([k]) => k !== 'config').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : '';
      const isStrategy = p.type === 'new_strategy_candidate';
      const approveBtn = isStrategy
        ? `<button class="btn btn-sm btn-primary" onclick="perps.applyStrategyProposal('${p.id}')">⚙️ Approva e configura</button>`
        : `<button class="btn btn-sm btn-primary" onclick="perps.approveProposal('${p.id}')">✅ Approva</button>`;
      return `
      <div class="agent-proposal">
        <div class="ap-head">
          <span class="ap-type">${p.type}</span>
          ${p.coin ? `<span class="ap-coin">${p.coin}</span>` : ''}
          <span class="ap-conf">confidenza ${conf}</span>
        </div>
        <div class="ap-rationale">${p.rationale || ''}</div>
        ${payload ? `<div class="ap-payload">${payload}</div>` : ''}
        <div class="ap-actions">
          ${approveBtn}
          <button class="btn btn-sm btn-outline" onclick="perps.rejectProposal('${p.id}')">🚫 Rifiuta</button>
        </div>
      </div>`;
    }).join('');
  }

  /** Approva una strategia suggerita e apre il creatore bot precompilato. */
  async applyStrategyProposal(id) {
    const p = this._proposalsById?.[id];
    try {
      await this.api(`/api/agents/proposals/${id}/approve`, { method: 'POST' });
    } catch (e) {
      this.toast(`Errore: ${e.message}`, 'error');
      return;
    }
    const coin = p?.coin || this.markets[0]?.coin;
    const cfg = (p?.payload && p.payload.config) ? { ...p.payload.config } : {};
    if (p?.payload?.interval && !cfg.candleInterval) cfg.candleInterval = p.payload.interval;
    // Apre il creatore bot precompilato con la strategia suggerita (modalità avanzata)
    this.openBotModal({ name: `AI ${coin || ''}`.trim(), coin, config: cfg });
    this._pendingProposalId = id; // verrà collegato al bot al salvataggio
    this.toast('Strategia approvata: rivedi i parametri e salva il bot', 'info');
  }

  async approveProposal(id) {
    try {
      const r = await this.api(`/api/agents/proposals/${id}/approve`, { method: 'POST' });
      this.toast(r?.suggestion
        ? '📝 Suggerimento acquisito — configuralo a mano nel creatore bot'
        : 'Proposta approvata ed eseguita', 'success');
    } catch (e) {
      this.toast(`Non eseguita: ${e.message}`, 'warning');
    }
    this.loadAgents();
  }

  async rejectProposal(id) {
    try { await this.api(`/api/agents/proposals/${id}/reject`, { method: 'POST' }); this.toast('Proposta rifiutata', 'info'); }
    catch (e) { this.toast(e.message, 'error'); }
    this.loadAgents();
  }

  async runAnalyst() {
    const st = document.getElementById('agentStatus');
    if (st) st.textContent = '⏳ analisi in corso…';
    try {
      const r = await this.api('/api/agents/analyst/run', { method: 'POST' });
      this.toast(r?.summary ? `Analyst: ${r.proposals} proposte` : 'Analisi completata', 'success');
    } catch (e) {
      this.toast(`Analyst: ${e.message}`, 'warning');
    }
    this.loadAgents();
  }

  async killSwitch() {
    if (!confirm('Attivare il KILL-SWITCH? Ferma tutti i bot e blocca ogni nuova apertura.')) return;
    try {
      await this.api('/api/perps/killswitch', { method: 'POST', body: JSON.stringify({ closePositions: false }) });
      this.toast('🛑 Kill-switch attivato: bot fermati, aperture bloccate', 'warning');
    } catch (e) { this.toast(e.message, 'error'); }
    this.loadAgents();
    this.loadBots();
  }

  async saveNotifications() {
    try {
      const d = await this.api('/api/perps/notifications', {
        method: 'POST',
        body: JSON.stringify({
          token: document.getElementById('tgToken').value.trim(),
          chatId: document.getElementById('tgChatId').value.trim(),
          enabled: document.getElementById('tgEnabled').checked
        })
      });
      this.toast('Notifiche salvate', 'success');
      const st = document.getElementById('tgStatus');
      if (st) st.textContent = d.configured ? '(configurato)' : '(non configurato)';
      this._refreshTgControlStatus();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async testNotification() {
    try {
      const r = await this.api('/api/perps/notifications/test', { method: 'POST' });
      this.toast(r.sent ? '✅ Messaggio di test inviato' : 'Non inviato: controlla token/chat id e che sia abilitato', r.sent ? 'success' : 'warning');
    } catch (e) { this.toast(e.message, 'error'); }
  }

  // ---- Grafico posizione (Lightweight Charts) ----
  openChart(coin) {
    if (!window.LightweightCharts) return this.toast('Libreria grafici non caricata', 'error');
    this.chartCoin = coin;
    document.getElementById('chartTitle').textContent = `📊 ${coin}`;
    const buttons = [...document.querySelectorAll('.chart-int')];
    // Vista attiva (default 15m); ogni pulsante porta intervallo + lookback in giorni
    const activeBtn = buttons.find(b => b.classList.contains('active')) || buttons[1];
    this.chartInterval = activeBtn.dataset.int;
    this.chartLookbackDays = parseInt(activeBtn.dataset.days) || 3;
    buttons.forEach(btn => {
      btn.onclick = () => {
        this.chartInterval = btn.dataset.int;
        this.chartLookbackDays = parseInt(btn.dataset.days) || 3;
        buttons.forEach(b => b.classList.toggle('active', b === btn));
        this._destroyChart();
        this._renderChart();
      };
    });
    app.showModal('chartModal');
    setTimeout(() => this._renderChart(), 60); // attendi il layout del modal
    if (this.chartTimer) clearInterval(this.chartTimer);
    this.chartTimer = setInterval(() => this._renderChart(true), 6000);
  }

  closeChart() {
    if (this.chartTimer) { clearInterval(this.chartTimer); this.chartTimer = null; }
    this._destroyChart();
    app.closeModal('chartModal');
  }

  // ---- Monitor bot (cosa sta facendo, anche da fermo) ----
  async openBotMonitor(id) {
    this.monitorBotId = id;
    document.getElementById('monitorBody').innerHTML = '<div class="backtest-loading"><span class="spinner-sm"></span> Lettura stato del bot…</div>';
    app.showModal('botMonitorModal');
    await this._refreshMonitor();
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = setInterval(() => this._refreshMonitor(), 5000); // aggiornamento live
  }

  closeBotMonitor() {
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    this.monitorBotId = null;
    app.closeModal('botMonitorModal');
  }

  async _refreshMonitor() {
    if (!this.monitorBotId) return;
    try {
      const m = await this.api(`/api/perps/bots/${this.monitorBotId}/monitor`);
      document.getElementById('monitorTitle').textContent = `📡 ${m.name} · ${m.coin}`;
      document.getElementById('monitorBody').innerHTML = this._renderMonitor(m);
    } catch (e) {
      document.getElementById('monitorBody').innerHTML = `<div class="backtest-empty">Monitor non disponibile: ${e.message}</div>`;
    }
  }

  _renderMonitor(m) {
    const dirIt = { both: 'Long & Short', long: 'solo Long', short: 'solo Short' }[m.direction] || m.direction;
    const statusDot = m.status === 'running' ? '🟢 attivo' : '⏸️ fermo';
    const le = m.lastEval || {};
    const leTime = le.ts ? new Date(le.ts).toLocaleTimeString('it-IT') : '—';

    const ruleRow = (r) => `
      <div class="mon-rule ${r.met ? 'met' : ''}">
        <div class="mon-rule-top">
          <span class="mon-dot">${r.met ? '🟢' : '⚪'}</span>
          <span class="mon-rule-label">${r.label}</span>
          <span class="mon-rule-sig side-badge ${r.signal === 'short' ? 'short' : 'long'}">${(r.signal || '').toUpperCase()}</span>
          <span class="mon-rule-target">${r.target}</span>
        </div>
        <div class="mon-rule-hint">${r.met ? '✅ condizione soddisfatta' : '⏳ ' + (r.hint || '')} <span class="muted">· ora: ${r.current}</span></div>
      </div>`;

    const logic = m.logic === 'all' ? 'tutte le regole insieme (AND)' : 'una qualsiasi regola (OR)';

    let posBlock;
    if (m.inPosition && m.position) {
      const p = m.position;
      posBlock = `<div class="mon-pos in"><b>${p.side.toUpperCase()} ${this.fmtNum(p.size)} ${m.coin}</b> @ ${this.fmtUsd(p.entryPx)} · TP ${p.tpPx ? this.fmtUsd(p.tpPx) : '—'} · SL ${p.slPx ? this.fmtUsd(p.slPx) : '—'}</div>`;
    } else {
      posBlock = `<div class="mon-pos flat">Nessuna posizione aperta — il bot sta cercando un punto d'ingresso.</div>`;
    }

    const gates = [];
    if (m.gates.mtf) gates.push(`Conferma multi-timeframe (EMA${m.gates.mtf.period} su ${m.gates.mtf.interval})`);
    if (m.gates.ml) gates.push(`Filtro ML (prob ≥ ${Math.round(m.gates.ml.minProb * 100)}% su ${m.gates.ml.interval})`);
    if (m.gates.partialTp) gates.push('Take profit parziale');
    if (m.gates.dca) gates.push('DCA');

    return `
      <div class="mon-head">
        <span>${statusDot}</span>
        <span class="muted">·</span><span>Prezzo ${this.fmtUsd(m.price)}</span>
        <span class="muted">·</span><span>${dirIt}</span>
        <span class="muted">·</span><span>TF ${m.interval}</span>
      </div>
      ${posBlock}
      <div class="mon-section-title">Ultima valutazione <span class="muted">(${leTime})</span></div>
      <div class="mon-lasteval"><b>${le.action || '—'}</b> — ${le.reason || '—'}</div>
      <div class="mon-section-title">Condizioni d'ingresso <span class="muted">— serve ${logic}</span></div>
      <div class="mon-rules">${m.entryRules.length ? m.entryRules.map(ruleRow).join('') : '<div class="muted">Nessuna regola d\'ingresso.</div>'}</div>
      ${m.inPosition && m.exitRules.length ? `<div class="mon-section-title">Condizioni d'uscita</div><div class="mon-rules">${m.exitRules.map(ruleRow).join('')}</div>` : ''}
      ${gates.length ? `<div class="mon-section-title">Filtri aggiuntivi</div><div class="mon-gates">${gates.map(g => `<span class="mon-gate">🔒 ${g}</span>`).join('')}</div>` : ''}
      ${m.lastError ? `<div class="bot-error">⚠️ ${m.lastError}</div>` : ''}
      <div class="mon-foot muted">Aggiornamento automatico ogni 5s · il bot rivaluta ogni ${Math.round((m.loopIntervalMs || 10000) / 1000)}s</div>`;
  }

  _destroyChart() {
    if (this.chart) { try { this.chart.remove(); } catch {} this.chart = null; this.candleSeries = null; this.emaSeries = null; }
    this._priceLines = [];
  }

  _ema(values, period) {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const out = [];
    let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period - 1; i < values.length; i++) {
      prev = i === period - 1 ? prev : values[i] * k + prev * (1 - k);
      out.push({ i, value: prev });
    }
    return out;
  }

  async _renderChart(isUpdate = false) {
    const coin = this.chartCoin;
    const container = document.getElementById('chartContainer');
    if (!container) return;
    try {
      const lookbackMs = (this.chartLookbackDays || 3) * 86400000;
      const [candlesRaw, orders] = await Promise.all([
        this.api(`/api/perps/candles?coin=${encodeURIComponent(coin)}&interval=${this.chartInterval}&lookback=${lookbackMs}`),
        this.connected ? this.api('/api/perps/orders?address=' + this.address).catch(() => []) : Promise.resolve([])
      ]);
      const candles = (candlesRaw || []).map(k => ({
        time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c
      })).filter(c => !isNaN(c.close));
      if (!candles.length) return;

      if (!this.chart) {
        this.chart = LightweightCharts.createChart(container, {
          width: container.clientWidth, height: 420,
          layout: { background: { color: '#fff' }, textColor: '#2d3748' },
          grid: { vertLines: { color: '#edf2f7' }, horzLines: { color: '#edf2f7' } },
          timeScale: { timeVisible: true, borderColor: '#e2e8f0' },
          rightPriceScale: { borderColor: '#e2e8f0' },
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
        });
        this.candleSeries = this.chart.addCandlestickSeries({
          upColor: '#38a169', downColor: '#e53e3e', borderVisible: false,
          wickUpColor: '#38a169', wickDownColor: '#e53e3e'
        });
        this.emaSeries = this.chart.addLineSeries({ color: '#805ad5', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        this._priceLines = [];
        new ResizeObserver(() => { if (this.chart) this.chart.resize(container.clientWidth, 420); }).observe(container);
      }

      this.candleSeries.setData(candles);
      // EMA 20 overlay
      const closes = candles.map(c => c.close);
      const ema = this._ema(closes, 20).map(e => ({ time: candles[e.i].time, value: +e.value.toFixed(4) }));
      this.emaSeries.setData(ema);

      // Rimuovi vecchie linee e ridisegna i livelli della posizione
      (this._priceLines || []).forEach(pl => { try { this.candleSeries.removePriceLine(pl); } catch {} });
      this._priceLines = [];
      const addLine = (price, color, title) => {
        if (!price || isNaN(price)) return;
        this._priceLines.push(this.candleSeries.createPriceLine({
          price, color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
          axisLabelVisible: true, title
        }));
      };
      const pos = (this.account?.positions || []).find(p => p.coin === coin || `${p.coin}-PERP` === coin);
      const legend = [];
      if (pos) {
        addLine(pos.entryPx, '#3182ce', 'Entry');
        addLine(pos.liquidationPx, '#dd6b20', 'Liq.');
        legend.push(`<span class="lg-entry">● Entry ${this.fmtUsd(pos.entryPx)}</span>`);
        if (pos.liquidationPx) legend.push(`<span class="lg-liq">● Liq ${this.fmtUsd(pos.liquidationPx)}</span>`);
      }
      // TP/SL dai trigger order aperti su questo coin
      (orders || []).filter(o => (o.coin === coin || `${o.coin}-PERP` === coin) && o.isTrigger && o.triggerPx)
        .forEach(o => {
          const isTp = /tp|take/i.test(o.orderType || '');
          addLine(o.triggerPx, isTp ? '#38a169' : '#e53e3e', isTp ? 'TP' : 'SL');
          legend.push(`<span class="${isTp ? 'lg-tp' : 'lg-sl'}">● ${isTp ? 'TP' : 'SL'} ${this.fmtUsd(o.triggerPx)}</span>`);
        });

      // Marker dei fill su questo mercato
      const fills = this.connected ? await this.api('/api/perps/fills?address=' + this.address).catch(() => []) : [];
      const markers = (fills || [])
        .filter(f => f.coin === coin || `${f.coin}-PERP` === coin)
        .map(f => {
          const isBuy = f.side === 'buy' || /Long/i.test(f.dir);
          return {
            time: Math.floor(f.time / 1000),
            position: isBuy ? 'belowBar' : 'aboveBar',
            color: isBuy ? '#38a169' : '#e53e3e',
            shape: isBuy ? 'arrowUp' : 'arrowDown',
            text: f.dir || (isBuy ? 'Buy' : 'Sell')
          };
        }).sort((a, b) => a.time - b.time);
      this.candleSeries.setMarkers(markers);

      legend.push(`<span class="lg-ema">● EMA20</span>`);
      document.getElementById('chartLegend').innerHTML = legend.join(' ');
      if (!isUpdate) this.chart.timeScale().fitContent();
    } catch (e) {
      if (!isUpdate) this.toast('Errore caricamento grafico: ' + e.message, 'error');
    }
  }

  // ---- Tab posizioni: Aperte / Storico ----
  switchPosTab(tab) {
    this.posTab = tab;
    document.getElementById('posOpen')?.classList.toggle('hidden', tab !== 'open');
    document.getElementById('posHistory')?.classList.toggle('hidden', tab !== 'history');
    document.querySelectorAll('.pos-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === tab));
    if (tab === 'history') this.loadFills();
  }

  refreshPositionsTab() {
    if (this.posTab === 'history') this.loadFills();
    else this.refreshAccount();
  }

  async loadFills() {
    if (!this.connected) return;
    try {
      const fills = await this.api('/api/perps/fills?address=' + this.address);
      this._allFills = fills || [];
      this._populateHistBotFilter();
      this.applyHistoryFilter();
    } catch (e) { this._allFills = []; this._renderFills([]); }
  }

  /** Popola il menu dei bot nel filtro storico (dai nomi presenti nei fill). */
  _populateHistBotFilter() {
    const sel = document.getElementById('histBot');
    if (!sel) return;
    const names = [...new Set((this._allFills || []).map(f => f.botName).filter(Boolean))].sort();
    const cur = sel.value;
    sel.innerHTML = '<option value="">Tutti i bot</option>' +
      names.map(n => `<option value="${n}">${n}</option>`).join('');
    if (names.includes(cur)) sel.value = cur;
  }

  /** Imposta un preset temporale (oggi/settimana/mese/anno/tutto). */
  setHistoryRange(range) {
    this._histRange = range;
    document.querySelectorAll('.hist-preset').forEach(b => b.classList.toggle('active', b.dataset.range === range));
    // svuota i campi da/a quando si usa un preset
    const from = document.getElementById('histFrom'); const to = document.getElementById('histTo');
    if (from) from.value = ''; if (to) to.value = '';
    this.applyHistoryFilter();
  }

  /** Applica i filtri (preset o range da/a + bot) e rende lo storico. */
  applyHistoryFilter(fromRange = false) {
    if (fromRange) { // l'utente ha scelto una data → disattiva i preset
      this._histRange = 'custom';
      document.querySelectorAll('.hist-preset').forEach(b => b.classList.remove('active'));
    }
    let fromTs = 0, toTs = Date.now();
    const fromEl = document.getElementById('histFrom')?.value;
    const toEl = document.getElementById('histTo')?.value;
    if (fromEl || toEl) {
      if (fromEl) fromTs = new Date(fromEl + 'T00:00:00').getTime();
      if (toEl) toTs = new Date(toEl + 'T23:59:59').getTime();
    } else {
      const days = { '1d': 1, '7d': 7, '30d': 30, '365d': 365 }[this._histRange];
      if (days) fromTs = Date.now() - days * 86400000;
    }
    const botFilter = document.getElementById('histBot')?.value || '';
    const filtered = (this._allFills || []).filter(f =>
      f.time >= fromTs && f.time <= toTs && (!botFilter || f.botName === botFilter));
    this._renderFills(filtered);
  }

  _explorerTxUrl(hash) {
    const host = this.network === 'mainnet' ? 'app.hyperliquid.xyz' : 'app.hyperliquid-testnet.xyz';
    return `https://${host}/explorer/tx/${hash}`;
  }

  _renderFills(fills) {
    const tbody = document.getElementById('fillsList');
    const empty = document.getElementById('noFills');
    if (!tbody) return;
    if (!fills || !fills.length) {
      tbody.innerHTML = '';
      empty?.classList.remove('hidden');
      return;
    }
    empty?.classList.add('hidden');
    tbody.innerHTML = fills.map(f => {
      const date = new Date(f.time).toLocaleString('it-IT');
      const isLong = /Long/i.test(f.dir);
      const dirClass = isLong ? 'side-badge long' : 'side-badge short';
      const pnl = f.closedPnl;
      const pnlCell = pnl ? `<span class="${pnl >= 0 ? 'profit-positive' : 'profit-negative'}">${this.fmtUsd(pnl)}</span>` : '—';
      const txLink = f.hash && f.hash !== '0x0000000000000000000000000000000000000000000000000000000000000000'
        ? `<a href="${this._explorerTxUrl(f.hash)}" target="_blank" rel="noopener">🔗</a>` : '—';
      const botCell = f.botName
        ? `<span class="hist-bot">${f.botName === 'Manuale' ? '✋ Manuale' : '🤖 ' + f.botName}</span>`
        : '<span class="muted">—</span>';
      return `<tr>
        <td>${date}</td>
        <td>${botCell}</td>
        <td>${f.coin}</td>
        <td><span class="${dirClass}">${f.dir || (f.side === 'buy' ? 'Buy' : 'Sell')}</span></td>
        <td>${this.fmtNum(f.sz)}</td>
        <td>${this.fmtUsd(f.px)}</td>
        <td>${pnlCell}</td>
        <td class="muted">${this.fmtUsd(f.fee)}</td>
        <td>${txLink}</td>
      </tr>`;
    }).join('');
  }

  // ---- Manual order ----
  async submitOrder(side) {
    if (!this.connected) return this.toast('Connetti prima MetaMask', 'warning');
    const coin = document.getElementById('orderMarket').value;
    const leverage = parseFloat(document.getElementById('orderLeverage').value);
    const sizeUsd = parseFloat(document.getElementById('orderSizeUsd').value);
    const tpv = parseFloat(document.getElementById('orderTp').value);
    const slv = parseFloat(document.getElementById('orderSl').value);
    const body = {
      masterAddress: this.address, coin, side, sizeUsd, leverage,
      tp: !isNaN(tpv) ? { mode: 'percent', value: tpv } : undefined,
      sl: !isNaN(slv) ? { mode: 'percent', value: slv } : undefined
    };
    try {
      this.toast(`Invio ordine ${side.toUpperCase()}...`, 'info');
      const r = await this.api('/api/perps/order', { method: 'POST', body: JSON.stringify(body) });
      this.toast(`✅ Ordine ${side.toUpperCase()} ${coin} eseguito @ ${this.fmtUsd(r.entryPx)}`, 'success');
      await this.refreshAccount();
      if (this.posTab === 'history') this.loadFills();
    } catch (e) { this.toast('Ordine fallito: ' + e.message, 'error'); }
  }

  // ---- Bots ----
  async loadBots() {
    try {
      this.bots = await this.api('/api/perps/bots');
      // Mappa bot -> strategia AI d'origine (per mostrare da quale proposta nasce)
      try {
        const hist = await this.api('/api/agents/strategy-history');
        this._botStrategy = {};
        for (const h of hist) if (h.linkedBotId) this._botStrategy[h.linkedBotId] = h;
      } catch { this._botStrategy = this._botStrategy || {}; }
      this._renderBots();
    } catch (e) { /* ignore */ }
  }

  _renderBots() {
    const list = document.getElementById('botsList');
    const empty = document.getElementById('noBots');
    if (!list) return;
    if (!this.bots.length) {
      list.innerHTML = '';
      empty?.classList.remove('hidden');
      return;
    }
    empty?.classList.add('hidden');
    list.innerHTML = this.bots.map(b => this._botCardHtml(b)).join('');
  }

  _botCardHtml(b) {
    const running = b.status === 'running';
    const pos = b.position
      ? `<span class="side-badge ${b.position.side}">${b.position.side.toUpperCase()} ${this.fmtNum(b.position.size)}</span>`
      : '<span class="muted">flat</span>';
    const evalTxt = b.lastEval ? `${b.lastEval.action} · ${b.lastEval.reason || ''}` : '—';
    const pnlClass = (b.dailyPnl || 0) >= 0 ? 'profit-positive' : 'profit-negative';
    let statsLine = '';
    if (b.stats && b.stats.trades > 0) {
      const pf = isFinite(b.stats.profitFactor) ? b.stats.profitFactor.toFixed(2) : '∞';
      const wrClass = b.stats.winRate >= 0.5 ? 'profit-positive' : '';
      statsLine = `<div class="bot-meta"><span class="label">Storico reale</span>
        <span class="bot-stats"><span class="${wrClass}">${(b.stats.winRate * 100).toFixed(0)}% win</span> · ${b.stats.trades} trade · PF ${pf} · <span class="${b.stats.totalPnl >= 0 ? 'profit-positive' : 'profit-negative'}">${this.fmtUsd(b.stats.totalPnl)}</span></span></div>`;
    }
    const strat = this._botStrategy?.[b.id];
    const stratBadge = strat
      ? `<div class="bot-strategy-badge" title="${(strat.rationale || '').replace(/"/g, '&quot;')}">🧠 da strategia AI${strat.decidedAt ? ' · ' + new Date(strat.decidedAt).toLocaleDateString('it-IT') : ''}</div>`
      : '';
    return `<div class="bot-card ${running ? 'running' : ''}" id="bot-${b.id}">
      <div class="bot-card-head">
        <div>
          <span class="bot-status-dot ${running ? 'online' : 'offline'}"></span>
          <strong>${b.name}</strong> <span class="muted">· ${b.coin}</span>
        </div>
        <span class="bot-pnl ${pnlClass}">${this.fmtUsd(b.dailyPnl || 0)}</span>
      </div>
      <div class="bot-card-body">
        ${stratBadge}
        <div class="bot-meta"><span class="label">Posizione</span> ${pos}</div>
        <div class="bot-meta"><span class="label">Ultima valutazione</span> <span class="eval">${evalTxt}</span></div>
        ${statsLine}
        ${b.lastError ? `<div class="bot-error">⚠️ ${b.lastError}</div>` : ''}
      </div>
      <div class="bot-card-actions">
        ${running
          ? `<button class="btn btn-sm btn-secondary" onclick="perps.stopBot('${b.id}')">⏹️ Stop</button>`
          : `<button class="btn btn-sm btn-long" onclick="perps.startBot('${b.id}')">▶️ Avvia</button>`}
        <button class="btn btn-sm btn-outline" onclick="perps.openBotMonitor('${b.id}')">📡 Monitor</button>
        <button class="btn btn-sm btn-outline" onclick="perps.editBot('${b.id}')">✏️</button>
        <button class="btn btn-sm btn-danger" onclick="perps.deleteBot('${b.id}')">🗑️</button>
      </div>
    </div>`;
  }

  _updateBotCard(state) {
    const idx = this.bots.findIndex(b => b.id === state.id);
    if (idx >= 0) this.bots[idx] = state; else this.bots.push(state);
    const el = document.getElementById('bot-' + state.id);
    if (el) el.outerHTML = this._botCardHtml(state);
    else this._renderBots();
  }

  async startBot(id) {
    if (!this.connected) return this.toast('Connetti MetaMask', 'warning');
    try {
      const s = await this.api(`/api/perps/agent/status?address=${this.address}`);
      if (!s.approved) return this.toast('Abilita prima l\'auto-trading (agent)', 'warning');
      await this.api(`/api/perps/bots/${id}/start`, { method: 'POST' });
      this.toast('Bot avviato', 'success');
      await this.loadBots();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async stopBot(id) {
    try {
      await this.api(`/api/perps/bots/${id}/stop`, { method: 'POST' });
      this.toast('Bot fermato', 'info');
      await this.loadBots();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async deleteBot(id) {
    if (!confirm('Eliminare questo bot?')) return;
    try {
      await this.api(`/api/perps/bots/${id}`, { method: 'DELETE' });
      this.toast('Bot eliminato', 'info');
      await this.loadBots();
    } catch (e) { this.toast(e.message, 'error'); }
  }

  // ---- Bot modal & rule builder ----
  openBotModal(bot = null) {
    this._pendingProposalId = null; // reset; applyStrategyProposal lo reimposta dopo
    document.getElementById('botModalTitle').textContent = bot ? '✏️ Modifica Bot' : '🤖 Nuovo Bot';
    document.getElementById('botEditId').value = bot?.id || '';
    document.getElementById('botName').value = bot?.name || '';
    document.getElementById('botMarket').value = bot?.coin || (this.markets[0]?.coin || '');
    const c = bot?.config || {};
    document.getElementById('botDirection').value = c.direction || 'both';
    document.getElementById('botLeverage').value = c.leverage || 3;
    document.getElementById('botSizingMode').value = c.sizing?.mode || 'percent';
    document.getElementById('botSizingValue').value = c.sizing?.value ?? 10;
    document.getElementById('botInterval').value = c.candleInterval || '15m';
    document.getElementById('botLogic').value = c.logic || 'any';
    document.getElementById('botTpEnabled').checked = c.tp?.enabled ?? true;
    document.getElementById('botTpValue').value = c.tp?.value ?? 2;
    document.getElementById('botSlEnabled').checked = c.sl?.enabled ?? true;
    document.getElementById('botSlValue').value = c.sl?.value ?? 1;
    document.getElementById('botTrailEnabled').checked = c.trailing?.enabled ?? false;
    document.getElementById('botTrailValue').value = c.trailing?.value ?? 1;
    document.getElementById('botMaxDailyLoss').value = c.risk?.maxDailyLossUsd ?? 100;
    document.getElementById('botMaxPosition').value = c.risk?.maxPositionUsd ?? 1000;
    // Automazione avanzata
    document.getElementById('botMtfEnabled').checked = !!c.mtfConfirm;
    document.getElementById('botMtfInterval').value = c.mtfConfirm?.interval || '1h';
    document.getElementById('botMtfPeriod').value = c.mtfConfirm?.period ?? 50;
    document.getElementById('botPtpEnabled').checked = !!(c.partialTp && c.partialTp.length);
    document.getElementById('botPtp1').value = c.partialTp?.[0]?.atPercent ?? 2;
    document.getElementById('botPtp2').value = c.partialTp?.[1]?.atPercent ?? 5;
    document.getElementById('botDcaEnabled').checked = !!c.dca;
    document.getElementById('botDcaSteps').value = c.dca?.steps ?? 2;
    document.getElementById('botDcaStep').value = c.dca?.stepPercent ?? 2;
    document.getElementById('botDcaMult').value = c.dca?.sizeMultiplier ?? 1;
    document.getElementById('botMlEnabled').checked = !!c.mlGate?.enabled;
    document.getElementById('botMlInterval').value = c.mlGate?.interval || '1h';
    document.getElementById('botMlMinProb').value = c.mlGate?.minProb ? Math.round(c.mlGate.minProb * 100) : 55;

    document.getElementById('entryRules').innerHTML = '';
    document.getElementById('exitRules').innerHTML = '';
    (c.entryRules || [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' }])
      .forEach(r => this.addRule('entry', r));
    (c.exitRules || []).forEach(r => this.addRule('exit', r));

    // Modalità semplificata: ripristina selezioni se il bot è stato creato così
    this.selStrategy = c.preset?.strategy || null;
    this.selRisk = c.preset?.risk || 'moderato';
    this._renderStrategyCards();
    this._renderRiskProfiles();
    this._updateConsultant();
    // Un bot con preset → semplificata; un bot avanzato (o nuovo) → default semplificata,
    // ma se in modifica e senza preset apri direttamente l'avanzata.
    this.setBotMode(bot && !c.preset ? 'advanced' : 'simple');

    const btBox = document.getElementById('backtestResult');
    if (btBox) btBox.innerHTML = '';
    const optBox = document.getElementById('optimizeResult');
    if (optBox) optBox.innerHTML = '';
    this._lastOpt = null;

    app.showModal('botModal');
  }

  editBot(id) {
    const bot = this.bots.find(b => b.id === id);
    if (bot) this.openBotModal(bot);
  }

  // ---- Modalità bot (semplificata / avanzata) ----
  setBotMode(mode) {
    this.botMode = mode;
    document.getElementById('botSimple')?.classList.toggle('hidden', mode !== 'simple');
    document.getElementById('botAdvanced')?.classList.toggle('hidden', mode !== 'advanced');
    document.querySelectorAll('.bot-mode').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === mode));
  }

  _renderStrategyCards() {
    const box = document.getElementById('strategyCards');
    if (!box) return;
    box.innerHTML = Object.entries(BOT_STRATEGIES).map(([key, s]) => `
      <div class="strategy-card ${this.selStrategy === key ? 'selected' : ''}" onclick="perps.selectStrategy('${key}')">
        <div class="strategy-card-head"><span class="strategy-emoji">${s.emoji}</span><strong>${s.name}</strong><span class="strategy-tag">${s.tag}</span></div>
        <p class="strategy-desc">${s.desc}</p>
        <p class="strategy-when">💡 ${s.when}</p>
      </div>`).join('');
  }

  _renderRiskProfiles() {
    const box = document.getElementById('riskProfiles');
    if (!box) return;
    box.innerHTML = Object.entries(RISK_PROFILES).map(([key, r]) => `
      <div class="risk-profile ${this.selRisk === key ? 'selected' : ''}" onclick="perps.selectRisk('${key}')">
        <div class="risk-profile-head">${r.emoji} <strong>${r.name}</strong></div>
        <div class="risk-profile-params">Leva ${r.leverage}x · ${r.sizingPercent}% equity · TP ${r.tp}% · SL ${r.sl}%</div>
        <p class="risk-profile-desc">${r.desc}</p>
      </div>`).join('');
  }

  selectStrategy(key) {
    this.selStrategy = key;
    this._renderStrategyCards();
    this._updateConsultant();
  }

  selectRisk(key) {
    this.selRisk = key;
    this._renderRiskProfiles();
    this._updateConsultant();
  }

  _updateConsultant(backtestStats = null) {
    const box = document.getElementById('consultantBox');
    const txt = document.getElementById('consultantText');
    if (!box || !txt) return;
    if (!this.selStrategy) { box.classList.add('hidden'); return; }
    const s = BOT_STRATEGIES[this.selStrategy];
    const r = RISK_PROFILES[this.selRisk];
    const coin = document.getElementById('botMarket')?.value || 'il mercato scelto';
    const cfg = s.build();
    const dir = cfg.direction === 'both' ? 'Long e Short' : (cfg.direction === 'long' ? 'solo Long' : 'solo Short');
    let bt = '';
    if (backtestStats) {
      const pf = isFinite(backtestStats.profitFactor) ? backtestStats.profitFactor.toFixed(2) : '∞';
      const edge = backtestStats.expectancy > 0 ? 'un edge positivo ✅' : 'un edge negativo ⚠️ — valuta di cambiare strategia o parametri';
      bt = `<br><span class="consultant-bt">📊 Backtest: win rate ${(backtestStats.winRate * 100).toFixed(0)}%, profit factor ${pf} → ${edge}</span>`;
    }
    box.classList.remove('hidden');
    txt.innerHTML = `
      Per <strong>${coin}</strong> ti consiglio la strategia <strong>"${s.name}"</strong> (${s.tag.toLowerCase()}) con profilo <strong>${r.name}</strong>.<br>
      Il bot opererà <strong>${dir}</strong> sul timeframe <strong>${cfg.candleInterval}</strong>: ${s.desc}<br>
      Gestione: leva <strong>${r.leverage}x</strong>, <strong>${r.sizingPercent}%</strong> dell'equity per operazione,
      take profit <strong>+${r.tp}%</strong>, stop loss <strong>-${r.sl}%</strong>${r.trailing ? `, trailing stop <strong>${r.trailing}%</strong>` : ''}.
      Stop automatico a <strong>-${this.fmtUsd(r.maxDailyLoss)}</strong> di perdita giornaliera.
      <br><span class="consultant-note">💡 ${s.when}</span>${bt}`;
    // Stima ML per il mercato/timeframe della strategia (asincrona)
    this.loadMlEstimate(cfg.candleInterval);
  }

  _buildSimpleConfig() {
    const s = BOT_STRATEGIES[this.selStrategy];
    const r = RISK_PROFILES[this.selRisk];
    const strat = s.build();
    return {
      ...strat,
      leverage: r.leverage,
      sizing: { mode: 'percent', value: r.sizingPercent },
      tp: { enabled: true, mode: 'percent', value: r.tp },
      sl: { enabled: true, mode: 'percent', value: r.sl },
      trailing: { enabled: r.trailing > 0, mode: 'percent', value: r.trailing || 1 },
      risk: { maxDailyLossUsd: r.maxDailyLoss, maxPositionUsd: r.maxPosition },
      preset: { strategy: this.selStrategy, risk: this.selRisk }
    };
  }

  addRule(kind, rule = {}) {
    const container = document.getElementById(kind === 'entry' ? 'entryRules' : 'exitRules');
    const row = document.createElement('div');
    row.className = 'rule-row';
    row.dataset.kind = kind;
    row.innerHTML = `
      <select class="form-select form-select-sm rule-type">
        <option value="indicator">Indicatore</option>
        <option value="price">Prezzo</option>
        <option value="funding">Funding</option>
        <option value="external">Segnale esterno</option>
      </select>
      <span class="rule-fields"></span>
      ${kind === 'entry'
        ? `<select class="form-select form-select-sm rule-signal"><option value="long">→ Long</option><option value="short">→ Short</option></select>`
        : `<input type="hidden" class="rule-signal" value="close">`}
      <button class="btn btn-sm btn-danger rule-remove">×</button>`;
    container.appendChild(row);

    const typeSel = row.querySelector('.rule-type');
    typeSel.value = rule.type || 'indicator';
    typeSel.addEventListener('change', () => this._renderRuleFields(row, {}));
    row.querySelector('.rule-remove').addEventListener('click', () => row.remove());
    if (kind === 'entry' && rule.signal) row.querySelector('.rule-signal').value = rule.signal;
    this._renderRuleFields(row, rule);
  }

  _renderRuleFields(row, rule) {
    const type = row.querySelector('.rule-type').value;
    const f = row.querySelector('.rule-fields');
    const opSel = (val) => `<select class="form-select form-select-sm rf-op">
      ${['<', '>', '<=', '>='].map(o => `<option ${val === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;

    if (type === 'indicator') {
      const indicator = rule.indicator || 'rsi';
      f.innerHTML = `
        <select class="form-select form-select-sm rf-indicator">
          ${['rsi', 'ema', 'sma', 'macd', 'bollinger'].map(i =>
            `<option value="${i}" ${indicator === i ? 'selected' : ''}>${i.toUpperCase()}</option>`).join('')}
        </select>
        <span class="rf-params"></span>`;
      const indSel = f.querySelector('.rf-indicator');
      const renderParams = () => {
        const ind = indSel.value;
        const params = f.querySelector('.rf-params');
        if (ind === 'macd') {
          params.innerHTML = `<select class="form-select form-select-sm rf-cond">
            <option value="bullish" ${rule.cond === 'bullish' ? 'selected' : ''}>istogramma > 0 (rialzo)</option>
            <option value="bearish" ${rule.cond === 'bearish' ? 'selected' : ''}>istogramma < 0 (ribasso)</option></select>`;
        } else if (ind === 'bollinger') {
          params.innerHTML = `<select class="form-select form-select-sm rf-cond">
            <option value="below_lower" ${rule.cond === 'below_lower' ? 'selected' : ''}>prezzo < banda inf.</option>
            <option value="above_upper" ${rule.cond === 'above_upper' ? 'selected' : ''}>prezzo > banda sup.</option></select>`;
        } else {
          params.innerHTML = `
            <input type="number" class="form-input form-input-sm rf-period" placeholder="periodo" value="${rule.period ?? 14}" style="width:70px">
            ${opSel(rule.op)}
            <input type="number" class="form-input form-input-sm rf-value" placeholder="valore" value="${rule.value ?? 30}" style="width:80px">`;
        }
      };
      indSel.addEventListener('change', renderParams);
      renderParams();
    } else if (type === 'external') {
      f.innerHTML = `<span class="muted">attivato da webhook</span>`;
    } else {
      // price | funding
      const ph = type === 'funding' ? 'es. 0.0001' : 'prezzo';
      f.innerHTML = `${opSel(rule.op)}
        <input type="number" class="form-input form-input-sm rf-value" placeholder="${ph}" value="${rule.value ?? ''}" step="any" style="width:110px">`;
    }
  }

  /** Costruisce la config del bot dalla modalità attiva (simple/advanced). */
  _buildBotConfig() {
    if (this.botMode === 'simple') {
      if (!this.selStrategy) { this.toast('Scegli una strategia', 'warning'); return null; }
      return this._buildSimpleConfig();
    }
    return {
      direction: document.getElementById('botDirection').value,
      leverage: parseFloat(document.getElementById('botLeverage').value),
      sizing: {
        mode: document.getElementById('botSizingMode').value,
        value: parseFloat(document.getElementById('botSizingValue').value)
      },
      candleInterval: document.getElementById('botInterval').value,
      logic: document.getElementById('botLogic').value,
      entryRules: this._collectRules('entry'),
      exitRules: this._collectRules('exit'),
      tp: { enabled: document.getElementById('botTpEnabled').checked, mode: 'percent', value: parseFloat(document.getElementById('botTpValue').value) },
      sl: { enabled: document.getElementById('botSlEnabled').checked, mode: 'percent', value: parseFloat(document.getElementById('botSlValue').value) },
      trailing: { enabled: document.getElementById('botTrailEnabled').checked, mode: 'percent', value: parseFloat(document.getElementById('botTrailValue').value) },
      risk: {
        maxDailyLossUsd: parseFloat(document.getElementById('botMaxDailyLoss').value),
        maxPositionUsd: parseFloat(document.getElementById('botMaxPosition').value)
      },
      ...this._collectAdvancedAutomation()
    };
  }

  /** Raccoglie i campi di automazione avanzata (MTF, partial TP, DCA). */
  _collectAdvancedAutomation() {
    const out = {};
    if (document.getElementById('botMtfEnabled')?.checked) {
      out.mtfConfirm = {
        interval: document.getElementById('botMtfInterval').value,
        period: parseInt(document.getElementById('botMtfPeriod').value) || 50
      };
    }
    if (document.getElementById('botPtpEnabled')?.checked) {
      const a1 = parseFloat(document.getElementById('botPtp1').value);
      const a2 = parseFloat(document.getElementById('botPtp2').value);
      out.partialTp = [
        { portion: 0.5, atPercent: a1 },
        { portion: 0.5, atPercent: a2 }
      ].filter(s => s.atPercent > 0);
    }
    if (document.getElementById('botDcaEnabled')?.checked) {
      out.dca = {
        steps: parseInt(document.getElementById('botDcaSteps').value) || 1,
        stepPercent: parseFloat(document.getElementById('botDcaStep').value) || 2,
        sizeMultiplier: parseFloat(document.getElementById('botDcaMult').value) || 1
      };
    }
    if (document.getElementById('botMlEnabled')?.checked) {
      out.mlGate = {
        enabled: true,
        interval: document.getElementById('botMlInterval').value,
        minProb: (parseFloat(document.getElementById('botMlMinProb').value) || 55) / 100
      };
    }
    return out;
  }

  // ---- Backtest ----
  async runBacktest() {
    const coin = document.getElementById('botMarket').value;
    const config = this._buildBotConfig();
    if (!config) return;
    const lookbackDays = parseInt(document.getElementById('backtestDays').value) || 30;
    const box = document.getElementById('backtestResult');
    box.innerHTML = '<div class="backtest-loading"><span class="spinner-sm"></span> Backtest in corso…</div>';
    try {
      const r = await this.api('/api/perps/backtest', {
        method: 'POST',
        body: JSON.stringify({ coin, config, interval: config.candleInterval, lookbackDays })
      });
      if (r.error) { box.innerHTML = `<div class="backtest-empty">⚠️ ${r.error}</div>`; return; }
      box.innerHTML = this._backtestHtml(r);
      // aggiorna anche il box consulente in modalità semplice
      if (this.botMode === 'simple') this._updateConsultant(r.stats);
    } catch (e) {
      box.innerHTML = `<div class="backtest-empty">Errore backtest: ${e.message}</div>`;
    }
  }

  _backtestHtml(r) {
    const s = r.stats;
    const pf = s.profitFactor === null || s.profitFactor === Infinity || !isFinite(s.profitFactor) ? '∞' : s.profitFactor.toFixed(2);
    const edge = s.expectancy > 0 ? 'positivo' : 'negativo';
    const edgeClass = s.expectancy > 0 ? 'profit-positive' : 'profit-negative';
    const wrClass = s.winRate >= 0.5 ? 'profit-positive' : '';
    return `
      <div class="backtest-grid">
        <div class="bt-metric"><span class="bt-label">Win rate</span><span class="bt-value ${wrClass}">${(s.winRate * 100).toFixed(1)}%</span></div>
        <div class="bt-metric"><span class="bt-label">Profit factor</span><span class="bt-value">${pf}</span></div>
        <div class="bt-metric"><span class="bt-label">Expectancy</span><span class="bt-value ${edgeClass}">${this.fmtUsd(s.expectancy)}/trade</span></div>
        <div class="bt-metric"><span class="bt-label">Operazioni</span><span class="bt-value">${s.trades}</span></div>
        <div class="bt-metric"><span class="bt-label">Return</span><span class="bt-value ${s.totalReturnPct >= 0 ? 'profit-positive' : 'profit-negative'}">${s.totalReturnPct.toFixed(1)}%</span></div>
        <div class="bt-metric"><span class="bt-label">Max drawdown</span><span class="bt-value profit-negative">-${s.maxDrawdownPct.toFixed(1)}%</span></div>
      </div>
      ${this._equitySparkline(r.equityCurve)}
      <div class="backtest-verdict ${edgeClass}">Edge ${edge} su ${r.period.days} giorni (${r.period.candles} candele, ${r.period.interval}).</div>
      <div class="backtest-disclaimer">⚠️ Risultati storici su un notional di ${this.fmtUsd(r.notionalUsd)}: NON garantiscono rendimenti futuri.</div>`;
  }

  /** Sparkline SVG della equity curve (nessuna dipendenza). */
  _equitySparkline(curve) {
    if (!curve || curve.length < 2) return '';
    const vals = curve.map(p => p.equity);
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = (max - min) || 1;
    const W = 600, H = 80;
    const pts = curve.map((p, i) => {
      const x = (i / (curve.length - 1)) * W;
      const y = H - ((p.equity - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const last = vals[vals.length - 1];
    const stroke = last >= 0 ? '#38a169' : '#e53e3e';
    const zeroY = H - ((0 - min) / range) * H;
    return `<svg class="equity-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${(min < 0 && max > 0) ? `<line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e0" stroke-dasharray="4" />` : ''}
      <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2" />
    </svg>`;
  }

  // ---- Optimizer (Hyperopt + walk-forward) ----
  async runOptimize() {
    const coin = document.getElementById('botMarket').value;
    const config = this._buildBotConfig();
    if (!config) return;
    const method = document.getElementById('optMethod').value;
    const objective = document.getElementById('optObjective').value;
    const lookbackDays = parseInt(document.getElementById('optDays').value) || 60;
    const box = document.getElementById('optimizeResult');
    box.innerHTML = '<div class="backtest-loading"><span class="spinner-sm"></span> Ottimizzazione in corso… (può richiedere qualche secondo)</div>';
    try {
      const r = await this.api('/api/perps/optimize', {
        method: 'POST',
        body: JSON.stringify({ coin, config, interval: config.candleInterval, lookbackDays, method, objective })
      });
      if (r.error) { box.innerHTML = `<div class="backtest-empty">⚠️ ${r.error}</div>`; return; }
      this._lastOpt = r;
      box.innerHTML = this._optimizeHtml(r);
    } catch (e) {
      box.innerHTML = `<div class="backtest-empty">Errore ottimizzazione: ${e.message}</div>`;
    }
  }

  _fmtPf(pf) {
    return (pf === null || pf === Infinity || !isFinite(pf)) ? '∞' : pf.toFixed(2);
  }

  _optimizeHtml(r) {
    const b = r.best;
    const verdictMap = {
      robust: { cls: 'profit-positive', txt: '✅ L\'edge regge anche fuori campione: parametri più affidabili.' },
      weaker: { cls: '', txt: '⚠️ Fuori campione l\'edge si indebolisce: usa con cautela.' },
      overfit: { cls: 'profit-negative', txt: '⛔ Fuori campione l\'edge crolla: parametri sovra-ottimizzati, NON usare.' },
      unknown: { cls: '', txt: 'ℹ️ Validazione fuori campione non disponibile.' }
    };
    const v = verdictMap[b.verdict] || verdictMap.unknown;

    const cmpRow = (label, inS, outS, fmt) => `
      <tr><td>${label}</td><td>${fmt(inS)}</td><td>${outS != null ? fmt(outS) : '—'}</td></tr>`;
    const fmtPct = x => `${x.toFixed(1)}%`;
    const fmtWr = x => `${(x * 100).toFixed(0)}%`;
    const oos = b.outOfSample;
    const inS = b.inSample;

    const paramsTxt = Object.values(b.params).map(p => `<span class="opt-param">${p.label}: <b>${p.value}</b></span>`).join(' ');

    const lbHead = `<tr><th>#</th>${r.dims.map(d => `<th>${d.label}</th>`).join('')}<th>Win</th><th>PF</th><th>Exp</th><th>Trade</th></tr>`;
    const lbRows = r.leaderboard.map((e, i) => `
      <tr class="${i === 0 ? 'opt-best-row' : ''}">
        <td>${i + 1}</td>
        ${r.dims.map(d => `<td>${e.params[d.key]}</td>`).join('')}
        <td>${fmtWr(e.winRate)}</td><td>${this._fmtPf(e.profitFactor)}</td>
        <td class="${e.expectancy >= 0 ? 'profit-positive' : 'profit-negative'}">${this.fmtUsd(e.expectancy)}</td>
        <td>${e.trades}</td>
      </tr>`).join('');

    return `
      <div class="opt-best">
        <div class="opt-best-head">🏆 Migliore combinazione <span class="muted">(obiettivo: ${r.objective}, ${r.evals} valutazioni, ${r.method})</span></div>
        <div class="opt-params">${paramsTxt}</div>
        <table class="opt-cmp">
          <thead><tr><th>Metrica</th><th>In-sample</th><th>Out-of-sample</th></tr></thead>
          <tbody>
            ${cmpRow('Win rate', inS.winRate, oos?.winRate, fmtWr)}
            ${cmpRow('Profit factor', inS.profitFactor, oos?.profitFactor, x => this._fmtPf(x))}
            ${cmpRow('Expectancy', inS.expectancy, oos?.expectancy, x => this.fmtUsd(x))}
            ${cmpRow('Return', inS.totalReturnPct, oos?.totalReturnPct, fmtPct)}
            ${cmpRow('Operazioni', inS.trades, oos?.trades, x => x)}
          </tbody>
        </table>
        <div class="backtest-verdict ${v.cls}">${v.txt}</div>
        <button class="btn btn-sm btn-primary" onclick="perps.applyOptimized()">✨ Applica migliori parametri</button>
      </div>
      <details class="opt-leaderboard"><summary>📋 Classifica (top ${r.leaderboard.length})</summary>
        <div class="opt-table-wrap"><table class="opt-lb"><thead>${lbHead}</thead><tbody>${lbRows}</tbody></table></div>
      </details>
      <div class="backtest-disclaimer">⚠️ Periodo: ${r.period.days}g (${r.period.inSampleCandles} in-sample + ${r.period.outSampleCandles} out-of-sample, ${r.period.interval}). Parametri ottimizzati sui dati storici: performance passata ≠ futura.</div>`;
  }

  /** Applica al form (modalità avanzata) la configurazione migliore trovata. */
  applyOptimized() {
    const c = this._lastOpt?.best?.config;
    if (!c) return;
    this.setBotMode('advanced');
    document.getElementById('botDirection').value = c.direction || 'both';
    document.getElementById('botLeverage').value = c.leverage || 3;
    document.getElementById('botSizingMode').value = c.sizing?.mode || 'percent';
    document.getElementById('botSizingValue').value = c.sizing?.value ?? 10;
    document.getElementById('botInterval').value = c.candleInterval || '15m';
    document.getElementById('botLogic').value = c.logic || 'any';
    document.getElementById('botTpEnabled').checked = c.tp?.enabled ?? true;
    document.getElementById('botTpValue').value = c.tp?.value ?? 2;
    document.getElementById('botSlEnabled').checked = c.sl?.enabled ?? true;
    document.getElementById('botSlValue').value = c.sl?.value ?? 1;
    document.getElementById('botTrailEnabled').checked = c.trailing?.enabled ?? false;
    document.getElementById('botTrailValue').value = c.trailing?.value ?? 1;
    document.getElementById('entryRules').innerHTML = '';
    document.getElementById('exitRules').innerHTML = '';
    (c.entryRules || []).forEach(r => this.addRule('entry', r));
    (c.exitRules || []).forEach(r => this.addRule('exit', r));
    this.toast('Parametri ottimizzati applicati (modalità avanzata)', 'success');
  }

  // ---- Stima ML (FreqAI-lite) ----
  async loadMlEstimate(intervalArg) {
    const coin = document.getElementById('botMarket')?.value;
    const interval = intervalArg || document.getElementById('botInterval')?.value || '15m';
    const box = document.getElementById('mlEstimate');
    if (!coin || !box) return;
    box.innerHTML = '<span class="spinner-sm"></span> calcolo stima…';
    try {
      const r = await this.api(`/api/perps/predict?coin=${encodeURIComponent(coin)}&interval=${interval}`);
      if (r.error) { box.innerHTML = `<span class="muted">ML non disponibile: ${r.error}</span>`; return; }
      const prob = (r.probUp * 100).toFixed(0);
      const acc = (r.model.accuracy * 100).toFixed(0);
      const base = (r.model.baseline * 100).toFixed(0);
      const dir = r.probUp >= 0.55 ? '📈 rialzo' : r.probUp <= 0.45 ? '📉 ribasso' : '➖ neutro';
      const edgeWarn = r.hasEdge ? '' : ` <span class="ml-warn">⚠️ accuratezza ≈ baseline: il modello non ha edge, non usarlo da solo.</span>`;
      box.innerHTML = `🧠 <b>Stima ML:</b> prob. rialzo <b>${prob}%</b> (${dir}) · accuratezza ${acc}% vs baseline ${base}% (n=${r.model.samples})${edgeWarn}`;
    } catch (e) {
      box.innerHTML = `<span class="muted">ML non disponibile: ${e.message}</span>`;
    }
  }

  _collectRules(kind) {
    const rows = document.querySelectorAll(`#${kind}Rules .rule-row`);
    const rules = [];
    rows.forEach(row => {
      const type = row.querySelector('.rule-type').value;
      const signal = row.querySelector('.rule-signal').value;
      const rule = { type, signal };
      if (type === 'indicator') {
        rule.indicator = row.querySelector('.rf-indicator').value;
        const cond = row.querySelector('.rf-cond');
        if (cond) {
          rule.cond = cond.value;
        } else {
          rule.period = parseInt(row.querySelector('.rf-period')?.value) || undefined;
          rule.op = row.querySelector('.rf-op')?.value;
          rule.value = parseFloat(row.querySelector('.rf-value')?.value);
        }
      } else if (type === 'price' || type === 'funding') {
        rule.op = row.querySelector('.rf-op')?.value;
        rule.value = parseFloat(row.querySelector('.rf-value')?.value);
      }
      rules.push(rule);
    });
    return rules;
  }

  async saveBot() {
    const id = document.getElementById('botEditId').value;
    const name = document.getElementById('botName').value.trim();
    const coin = document.getElementById('botMarket').value;
    if (!name) return this.toast('Inserisci un nome', 'warning');
    if (!this.connected) return this.toast('Connetti MetaMask', 'warning');

    const config = this._buildBotConfig();
    if (!config) return;

    try {
      let created = null;
      if (id) {
        await this.api(`/api/perps/bots/${id}`, { method: 'PATCH', body: JSON.stringify({ name, coin, config }) });
      } else {
        created = await this.api('/api/perps/bots', { method: 'POST', body: JSON.stringify({ name, coin, masterAddress: this.address, config }) });
      }
      // Se il bot nasce da una strategia AI approvata, collegalo per seguirne l'esito
      if (!id && this._pendingProposalId && created?.id) {
        try {
          await this.api(`/api/agents/proposals/${this._pendingProposalId}/link`, { method: 'POST', body: JSON.stringify({ botId: created.id }) });
          this.toast('Bot collegato alla strategia AI: ne seguirai l\'esito nello storico', 'success');
        } catch (_) { /* il bot è creato comunque */ }
        this._pendingProposalId = null;
      } else {
        this.toast('Bot salvato', 'success');
      }
      app.closeModal('botModal');
      await this.loadBots();
      this.loadStrategyHistory?.();
    } catch (e) { this.toast('Errore salvataggio: ' + e.message, 'error'); }
  }
}

const perps = new PerpsApp();
window.perps = perps;

// Aggiorna il prezzo mostrato quando cambia il mercato selezionato
document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('orderMarket');
  if (sel) sel.addEventListener('change', () => perps._updateMid());
  const botSel = document.getElementById('botMarket');
  if (botSel) botSel.addEventListener('change', () => perps._updateConsultant());
});
