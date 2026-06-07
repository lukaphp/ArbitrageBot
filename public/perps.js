/**
 * PERPS TRADING UI (Hyperliquid)
 * ==============================
 * Gestisce la vista "Perps": account/agent, ordini manuali, posizioni e bot
 * auto-pilot. Riusa la connessione MetaMask e i toast/modali di app.js.
 */

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
    this.socket.on('perps:position', () => this.refreshAccount());
    this.socket.on('perps:fill', () => this.refreshAccount());
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
      document.getElementById('perpsEquity').textContent = this.fmtUsd(acc.accountValue);
      document.getElementById('perpsMargin').textContent = this.fmtUsd(acc.totalMarginUsed);
      document.getElementById('perpsWithdrawable').textContent = this.fmtUsd(acc.withdrawable);
      document.getElementById('perpsPosCount').textContent = acc.positions.length;
      this._updateFaucetBadge(acc.accountValue);
      this._updateSpotTransfer(acc.spotUsdc || 0);
      this._renderPositions(acc.positions);
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
      this.toast('Trasferimento fallito: ' + (e.message || e), 'error');
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
      return `<tr>
        <td>${p.coin}</td>
        <td><span class="side-badge ${p.side}">${p.side.toUpperCase()}</span></td>
        <td>${this.fmtNum(p.size)}</td>
        <td>${this.fmtUsd(p.entryPx)}</td>
        <td class="${pnlClass}">${this.fmtUsd(p.unrealizedPnl)}</td>
        <td>${p.leverage ? p.leverage + 'x' : '—'}</td>
        <td>${p.liquidationPx ? this.fmtUsd(p.liquidationPx) : '—'}</td>
        <td><button class="btn btn-sm btn-danger" onclick="perps.closePosition('${coin}')">Chiudi</button></td>
      </tr>`;
    }).join('');
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
    } catch (e) { this.toast(e.message, 'error'); }
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
    } catch (e) { this.toast('Ordine fallito: ' + e.message, 'error'); }
  }

  // ---- Bots ----
  async loadBots() {
    try {
      this.bots = await this.api('/api/perps/bots');
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
    return `<div class="bot-card ${running ? 'running' : ''}" id="bot-${b.id}">
      <div class="bot-card-head">
        <div>
          <span class="bot-status-dot ${running ? 'online' : 'offline'}"></span>
          <strong>${b.name}</strong> <span class="muted">· ${b.coin}</span>
        </div>
        <span class="bot-pnl ${pnlClass}">${this.fmtUsd(b.dailyPnl || 0)}</span>
      </div>
      <div class="bot-card-body">
        <div class="bot-meta"><span class="label">Posizione</span> ${pos}</div>
        <div class="bot-meta"><span class="label">Ultima valutazione</span> <span class="eval">${evalTxt}</span></div>
        ${b.lastError ? `<div class="bot-error">⚠️ ${b.lastError}</div>` : ''}
      </div>
      <div class="bot-card-actions">
        ${running
          ? `<button class="btn btn-sm btn-secondary" onclick="perps.stopBot('${b.id}')">⏹️ Stop</button>`
          : `<button class="btn btn-sm btn-long" onclick="perps.startBot('${b.id}')">▶️ Avvia</button>`}
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

    document.getElementById('entryRules').innerHTML = '';
    document.getElementById('exitRules').innerHTML = '';
    (c.entryRules || [{ type: 'indicator', indicator: 'rsi', period: 14, op: '<', value: 30, signal: 'long' }])
      .forEach(r => this.addRule('entry', r));
    (c.exitRules || []).forEach(r => this.addRule('exit', r));

    app.showModal('botModal');
  }

  editBot(id) {
    const bot = this.bots.find(b => b.id === id);
    if (bot) this.openBotModal(bot);
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

    const config = {
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
      }
    };

    try {
      if (id) {
        await this.api(`/api/perps/bots/${id}`, { method: 'PATCH', body: JSON.stringify({ name, coin, config }) });
      } else {
        await this.api('/api/perps/bots', { method: 'POST', body: JSON.stringify({ name, coin, masterAddress: this.address, config }) });
      }
      this.toast('Bot salvato', 'success');
      app.closeModal('botModal');
      await this.loadBots();
    } catch (e) { this.toast('Errore salvataggio: ' + e.message, 'error'); }
  }
}

const perps = new PerpsApp();
window.perps = perps;

// Aggiorna il prezzo mostrato quando cambia il mercato selezionato
document.addEventListener('DOMContentLoaded', () => {
  const sel = document.getElementById('orderMarket');
  if (sel) sel.addEventListener('change', () => perps._updateMid());
});
