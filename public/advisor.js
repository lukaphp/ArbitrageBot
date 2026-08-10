/**
 * DRAWER DEL CONSULENTE AI (ADV-02, fase 1 dello spike)
 * =====================================================
 * Pannello laterale a comparsa da destra, aperto dal toggle in header accanto al
 * pill #walletStatus. È l'opzione B dello spike (`spike-ai-advisor.md` §2): la
 * domanda tipica è "perché questa posizione è in rosso?", e la risposta va letta
 * *accanto* al dato, non al posto del dato — un tab a tutta pagina avrebbe
 * nascosto proprio le posizioni di cui si sta parlando.
 *
 * PERCHÉ UN FILE A PARTE, E PERCHÉ NON TOCCA `perps`
 * -------------------------------------------------
 * Tutto lo stato della chat (sessione attiva, transcript, budget, stato di
 * degrado) vive dentro questa classe e non esce da qui. Nessun campo di `perps`
 * o di `shell` viene letto o scritto, e nessun modulo legge lo stato di questo:
 * è il difetto architetturale che EVM-01 ha appena rimosso da questo codebase
 * (`perps.connected` era un getter su `app.isConnected`, e il ritiro di `app.js`
 * si è portato via la connessione MetaMask — vedi test/walletPerpsUi.test.js).
 * Non va reintrodotto per la chat.
 *
 * L'unica dipendenza esterna è `window.shell.showToast`, che è una utility di
 * presentazione condivisa (come già per `perps.js`), non stato: se manca, si
 * degrada su un avviso dentro il drawer.
 *
 * NIENTE POLLING
 * --------------
 * I dati si caricano all'apertura del drawer e dopo ogni azione dell'utente.
 * Nessun `setInterval`: la cockpit ha già il monitor dei bot (5s), il grafico di
 * posizione (6s), account (8s) e snapshot di rischio (15s).
 *
 * Come `perps.js` e `shell.js`, è uno script di browser classico: nessun export,
 * l'istanza è esposta su `window.advisor` per gli `onclick` inline di index.html.
 */

/** Etichette dei ruoli nel transcript. */
const ADVISOR_ROLES = { user: 'Tu', assistant: 'Consulente' };

class AdvisorDrawer {
  constructor() {
    this.isOpen = false;
    this.bound = false;
    /** Caricamento fatto almeno una volta (evita di rifare tutto a ogni apertura). */
    this.loaded = false;
    /** Sessioni: [{id, title, startedAt, lastAt, costUsd}] */
    this.sessions = [];
    this.activeSessionId = null;
    /** Transcript della sessione attiva: [{id, role, content, ts, toolName, costUsd}] */
    this.messages = [];
    /** Budget advisor in sola lettura (ADV-03: la modifica passa solo da Telegram). */
    this.budget = null;
    this.sending = false;
    /**
     * `false` quando il server dichiara il consulente non utilizzabile
     * (AGENTS_ENABLED=false, API key assente, budget mensile esaurito).
     * In quello stato il drawer resta apribile e leggibile, ma non invia nulla.
     */
    this.available = true;
    this.unavailableReason = null;
    /** Giorni di retention dichiarati dal server, per l'avviso sull'eliminazione. */
    this.retentionDays = null;
    /** Avviso corrente dentro il drawer: {text, kind}. */
    this.notice = null;
  }

  // ---- Infrastruttura ----

  /**
   * Aggancia i controlli. Difensiva per costruzione: se il markup non c'è
   * (pagina diversa, test), non fa nulla e non solleva — il resto della cockpit
   * non deve dipendere dalla presenza del drawer.
   */
  init() {
    if (this.bound) return;
    this.bound = true;
    const on = (id, ev, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(ev, fn);
    };
    on('advisorToggle', 'click', () => this.toggle());
    on('advisorClose', 'click', () => this.close());
    on('advisorNewSession', 'click', () => this.newSession());
    on('advisorDeleteSession', 'click', () => this.deleteSession());
    on('advisorSend', 'click', () => this.send());
    on('advisorSessionList', 'change', (event) => {
      const id = event?.target?.value || document.getElementById('advisorSessionList')?.value;
      if (id) this.selectSession(id);
    });
    // Invio con Enter, capo a riga con Shift+Enter: è un campo di chat, non un form.
    on('advisorInput', 'keydown', (event) => {
      if (event?.key === 'Enter' && !event.shiftKey) {
        event.preventDefault?.();
        this.send();
      }
    });
    document.addEventListener?.('keydown', (event) => {
      if (event?.key === 'Escape' && this.isOpen) this.close();
    });
    this._render();
  }

  /**
   * Chiamate all'API del consulente. Ricalca `perps.api()` invece di riusarlo:
   * dipendere da un metodo di un altro modulo è il primo passo verso lo stato
   * condiviso che questo file evita per progetto.
   */
  async _api(path, opts = {}) {
    const res = await fetch(`/api/advisor${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.success === false) {
      const err = new Error(payload.error || `Errore ${res.status}`);
      if (payload.code) err.code = payload.code;
      err.status = res.status;
      throw err;
    }
    return payload.data ?? payload;
  }

  _toast(msg, type = 'info') {
    if (window.shell?.showToast) window.shell.showToast(msg, type);
    else this._notice(msg, type === 'error' ? 'error' : 'info');
  }

  /** Formatta un costo in USD, più decimali sotto il dollaro (come perps._fmtCost). */
  _fmtCost(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return '$0';
    return '$' + v.toFixed(v < 1 ? 4 : 2);
  }

  _fmtTime(ts) {
    const v = Number(ts);
    if (!Number.isFinite(v) || v <= 0) return '';
    return new Date(v).toLocaleString('it-IT', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
  }

  /**
   * Riconosce gli errori che rendono il consulente inutilizzabile finché
   * qualcosa non cambia lato server, distinguendoli da un rifiuto passeggero
   * (`turn_in_progress`, `message_too_long`, `session_not_found`) che non deve
   * spegnere il campo di invio.
   *
   * Se il server manda un `code`, quello è la fonte: nessun sospetto sul testo.
   * Il fallback sul testo serve solo quando il `code` manca del tutto — è
   * un'euristica dichiarata, non un contratto.
   */
  _isUnavailable(err) {
    const code = String(err?.code || '');
    if (code) return ['agents_disabled', 'no_api_key', 'no_client', 'budget_exceeded'].includes(code);
    return /disabilitat|disattivat|non abilitat|budget|api key|chiave api/i.test(String(err?.message || ''));
  }

  /**
   * Mette il drawer in stato "non utilizzabile", senza toccare il resto della cockpit.
   *
   * Il primo motivo dichiarato vince e non viene sovrascritto: quello arriva da
   * `/status` ed è specifico ("Agenti AI disabilitati (AGENTS_ENABLED=false)"),
   * mentre gli errori che seguono sono conseguenze e direbbero di meno all'utente
   * ("budget non leggibile"). Senza questa regola il messaggio utile veniva
   * coperto da quello inutile.
   */
  _degrade(reason) {
    this.available = false;
    if (!this.unavailableReason) this.unavailableReason = reason || 'Consulente AI non disponibile.';
    this._notice(this.unavailableReason, 'error');
  }

  _notice(text, kind = 'info') {
    this.notice = text ? { text, kind } : null;
  }

  // ---- Apertura / chiusura ----

  toggle() {
    return this.isOpen ? this.close() : this.open();
  }

  async open() {
    this.isOpen = true;
    this._applyOpenState();
    this._render();
    document.getElementById('advisorInput')?.focus?.();
    if (!this.loaded) {
      this.loaded = true;
      await this.refresh();
    }
  }

  close() {
    this.isOpen = false;
    this._applyOpenState();
    document.getElementById('advisorToggle')?.focus?.();
  }

  _applyOpenState() {
    const drawer = document.getElementById('advisorDrawer');
    if (drawer) {
      drawer.hidden = !this.isOpen;
      drawer.classList.toggle('is-open', this.isOpen);
      drawer.setAttribute?.('aria-hidden', String(!this.isOpen));
    }
    const toggle = document.getElementById('advisorToggle');
    if (toggle) {
      toggle.setAttribute?.('aria-expanded', String(this.isOpen));
      toggle.classList.toggle('is-active', this.isOpen);
    }
    document.body?.classList?.toggle('advisor-open', this.isOpen);
  }

  // ---- Dati ----

  /** Stato + budget + elenco sessioni + transcript della più recente. Solo su azione utente. */
  async refresh() {
    await this.loadStatus();
    await this.loadBudget();
    // Le sessioni si leggono anche a consulente spento: rileggere una
    // conversazione passata non costa niente e non richiede il modello.
    await this.loadSessions();
  }

  /**
   * `GET /api/advisor/status` — l'unica fonte che decide se il consulente è
   * utilizzabile. Chiederlo esplicitamente evita di dover mandare un messaggio
   * (e spendere) solo per scoprire che l'advisor è spento.
   */
  async loadStatus() {
    try {
      const data = await this._api('/status');
      this.available = data?.available !== false;
      this.unavailableReason = this.available ? null : (data?.reason || 'Consulente AI non disponibile.');
      this.retentionDays = Number.isFinite(Number(data?.retentionDays)) ? Number(data.retentionDays) : null;
      this._notice(this.available ? null : this.unavailableReason, 'error');
    } catch (err) {
      // La route di stato non risponde: non si dichiara nulla di definitivo, si
      // dice che non si è raggiungibile e si lascia decidere al primo invio.
      this._notice(`Stato del consulente non leggibile: ${err.message}`, 'error');
    }
    this._render();
    return this.available;
  }

  /**
   * Budget mensile in sola lettura (ADV-03). La UI web non può modificarlo: la
   * modifica passa esclusivamente da Telegram con conferma a due passi, quindi
   * qui non esiste nessun controllo di scrittura, per progetto.
   */
  async loadBudget() {
    try {
      const data = await this._api('/budget');
      const limit = Number(data?.monthlyLimitUsd ?? data?.limitUsd);
      const spent = Number(data?.spentUsd);
      const remaining = Number(
        data?.remainingUsd ?? (Number.isFinite(limit) && Number.isFinite(spent) ? limit - spent : NaN)
      );
      this.budget = {
        limitUsd: Number.isFinite(limit) ? limit : null,
        spentUsd: Number.isFinite(spent) ? spent : null,
        remainingUsd: Number.isFinite(remaining) ? remaining : null,
        // `exceeded` è la valutazione del server: più affidabile di un confronto
        // fatto qui su un residuo arrotondato.
        exceeded: data?.exceeded === true || (Number.isFinite(remaining) && remaining <= 0),
        resetsAt: data?.resetsAt ?? null
      };
    } catch (err) {
      // Il budget è un'informazione di contorno: se non arriva si mostra '—',
      // non si dichiara il consulente rotto per questo.
      this.budget = null;
      if (this._isUnavailable(err)) this._degrade(err.message);
    }
    this._render();
    return this.budget;
  }

  /**
   * Elenco delle conversazioni. Deliberatamente NON tocca `available`: quella è
   * una decisione di `loadStatus()`, e un errore di lettura qui non deve
   * riabilitare un consulente che il server ha dichiarato spento.
   */
  async loadSessions() {
    try {
      const data = await this._api('/sessions');
      this.sessions = Array.isArray(data) ? data : [];
      const next = this.sessions.find(s => s.id === this.activeSessionId) || this.sessions[0];
      if (next && next.id !== this.activeSessionId) {
        await this.selectSession(next.id);
        return this.sessions;
      }
      if (!next) { this.activeSessionId = null; this.messages = []; }
    } catch (err) {
      this.sessions = [];
      this.activeSessionId = null;
      this.messages = [];
      // Se l'errore dice che il consulente è spento o senza budget, lo si
      // dichiara; altrimenti resta un problema di lettura, non un degrado.
      // In entrambi i casi il resto della cockpit non se ne accorge.
      if (this._isUnavailable(err)) this._degrade(err.message);
      else if (this.available) this._notice(`Conversazioni non leggibili: ${err.message}`, 'error');
    }
    this._render();
    return this.sessions;
  }

  async selectSession(id) {
    if (!id) return;
    this.activeSessionId = id;
    this.messages = [];
    this._render();
    try {
      const data = await this._api(`/sessions/${encodeURIComponent(id)}/messages`);
      this.messages = Array.isArray(data) ? data : [];
      this._notice(null);
    } catch (err) {
      this._notice(`Transcript non caricato: ${err.message}`, 'error');
      if (this._isUnavailable(err)) this._degrade(err.message);
    }
    this._render();
    return this.messages;
  }

  async newSession() {
    try {
      const data = await this._api('/sessions', { method: 'POST' });
      const id = data?.id;
      if (!id) throw new Error('Il server non ha restituito un id di sessione');
      this.sessions = [{ id, title: 'Nuova conversazione', startedAt: data.startedAt, lastAt: data.startedAt, costUsd: 0 }, ...this.sessions];
      this.activeSessionId = id;
      this.messages = [];
      this._notice(null);
      this._render();
      document.getElementById('advisorInput')?.focus?.();
      return id;
    } catch (err) {
      if (this._isUnavailable(err)) this._degrade(err.message);
      else this._notice(`Non è stato possibile aprire la conversazione: ${err.message}`, 'error');
      this._render();
      return null;
    }
  }

  async send() {
    const input = document.getElementById('advisorInput');
    const text = String(input?.value ?? '').trim();
    if (!text || this.sending) return null;
    if (!this.available) {
      // Nessuna chiamata LLM quando il server ha già detto di no: il messaggio
      // resta nel campo, così non si perde quello che l'utente aveva scritto.
      this._notice(this.unavailableReason, 'error');
      this._render();
      return null;
    }
    if (!this.activeSessionId && !(await this.newSession())) return null;

    this.sending = true;
    // Il messaggio dell'utente compare subito: la risposta può richiedere
    // secondi (round-trip con gli strumenti), e un campo che si svuota senza
    // che compaia nulla sembra un invio perso.
    this.messages = [...this.messages, { id: `local-${Date.now()}`, role: 'user', content: text, ts: Date.now() }];
    if (input) input.value = '';
    this._notice('Il consulente sta leggendo i dati…', 'info');
    this._render();

    try {
      const data = await this._api(`/sessions/${encodeURIComponent(this.activeSessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ message: text })
      });
      const tools = Array.isArray(data?.toolsUsed) ? data.toolsUsed.filter(Boolean) : [];
      this.messages = [...this.messages, {
        id: `reply-${Date.now()}`,
        role: 'assistant',
        content: String(data?.reply ?? ''),
        ts: Date.now(),
        costUsd: data?.costUsd,
        toolName: tools.length ? tools.join(', ') : null
      }];
      const remaining = Number(data?.budgetRemainingUsd);
      if (Number.isFinite(remaining)) this.budget = { ...(this.budget || {}), remainingUsd: remaining };
      this._notice(null);
      return this.messages.at(-1);
    } catch (err) {
      // Il server manda un messaggio già scritto per essere letto da un umano
      // ("budget mensile raggiunto: $X su $Y…"): si mostra quello, non un
      // "errore generico" che non dice all'utente cosa fare.
      this._notice(err.message, 'error');
      if (this._isUnavailable(err)) this._degrade(err.message);
      return null;
    } finally {
      this.sending = false;
      this._render();
    }
  }

  /**
   * Elimina la conversazione corrente. Conferma con il `confirm` nativo, come
   * per l'eliminazione massiva dello storico strategie: è un'azione distruttiva
   * e non recuperabile (retention a parte, il transcript non torna).
   */
  async deleteSession(id = this.activeSessionId) {
    if (!id) return false;
    const session = this.sessions.find(s => s.id === id);
    const label = session?.title || 'questa conversazione';
    if (!confirm(`Eliminare "${label}"? Il transcript non è recuperabile.`)) return false;
    try {
      await this._api(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      this.sessions = this.sessions.filter(s => s.id !== id);
      if (this.activeSessionId === id) {
        this.activeSessionId = null;
        this.messages = [];
        const next = this.sessions[0];
        if (next) { await this.selectSession(next.id); return true; }
      }
      this._toast('Conversazione eliminata', 'success');
      this._notice(null);
      this._render();
      return true;
    } catch (err) {
      this._notice(`Eliminazione non riuscita: ${err.message}`, 'error');
      this._render();
      return false;
    }
  }

  // ---- Rendering ----

  _render() {
    this._renderBudget();
    this._renderSessions();
    this._renderNotice();
    this._renderTranscript();
    this._renderComposer();
  }

  _renderBudget() {
    const el = document.getElementById('advisorBudget');
    if (!el) return;
    const b = this.budget;
    if (!b || (b.limitUsd == null && b.spentUsd == null && b.remainingUsd == null)) {
      el.textContent = 'Budget —';
      el.title = 'Contatore di spesa non disponibile.';
      return;
    }
    const parts = [];
    if (b.spentUsd != null && b.limitUsd != null) parts.push(`${this._fmtCost(b.spentUsd)} / ${this._fmtCost(b.limitUsd)}`);
    else if (b.limitUsd != null) parts.push(`limite ${this._fmtCost(b.limitUsd)}`);
    if (b.remainingUsd != null) parts.push(`residuo ${this._fmtCost(b.remainingUsd)}`);
    el.textContent = `Budget ${parts.join(' · ')}`;
    // ADV-03: il budget si modifica solo da Telegram, la UI web lo mostra e basta.
    const reset = b.resetsAt ? ` Si azzera il ${this._fmtTime(b.resetsAt)}.` : '';
    el.title = `Budget mensile del consulente, in sola lettura: si modifica solo da Telegram con /advisorbudget.${reset}`;
    el.classList.toggle('is-exhausted', b.exceeded === true);
  }

  _renderSessions() {
    const select = document.getElementById('advisorSessionList');
    if (select) {
      // textContent per ogni opzione: i titoli sono generati dal modello.
      select.innerHTML = '';
      if (!this.sessions.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Nessuna conversazione';
        select.appendChild(opt);
        select.disabled = true;
      } else {
        for (const session of this.sessions) {
          const opt = document.createElement('option');
          opt.value = String(session.id);
          const when = this._fmtTime(session.lastAt ?? session.startedAt);
          opt.textContent = [session.title || 'Conversazione', when].filter(Boolean).join(' · ');
          if (String(session.id) === String(this.activeSessionId)) opt.selected = true;
          select.appendChild(opt);
        }
        select.disabled = false;
        select.value = String(this.activeSessionId ?? '');
      }
    }
    const del = document.getElementById('advisorDeleteSession');
    if (del) del.disabled = !this.activeSessionId;
    const create = document.getElementById('advisorNewSession');
    if (create) create.disabled = !this.available;
  }

  _renderNotice() {
    const el = document.getElementById('advisorNotice');
    if (!el) return;
    if (!this.notice) {
      el.textContent = '';
      el.hidden = true;
      el.className = 'advisor-notice';
      return;
    }
    // textContent: il testo arriva dal server (e dal modello) e non deve poter
    // iniettare markup nella cockpit.
    el.textContent = this.notice.text;
    el.hidden = false;
    el.className = `advisor-notice advisor-notice-${this.notice.kind}`;
  }

  _renderTranscript() {
    const box = document.getElementById('advisorTranscript');
    if (!box) return;
    box.innerHTML = '';
    if (!this.messages.length) {
      const empty = document.createElement('p');
      empty.className = 'advisor-empty';
      empty.textContent = !this.available
        ? 'Il consulente non è attivo: nessuna conversazione da mostrare.'
        : this.activeSessionId
          ? 'Conversazione vuota. Chiedi qualcosa sul portafoglio, per esempio "perché questa posizione è in rosso?".'
          : 'Nessuna conversazione aperta. Premi “Nuova” per iniziare.';
      box.appendChild(empty);
      return;
    }
    for (const message of this.messages) box.appendChild(this._bubble(message));
    if (this.sending) {
      const wait = document.createElement('p');
      wait.className = 'advisor-typing';
      wait.textContent = 'Il consulente sta leggendo i dati…';
      box.appendChild(wait);
    }
    box.scrollTop = box.scrollHeight;
  }

  _bubble(message) {
    const role = message?.role === 'user' ? 'user' : 'assistant';
    const wrap = document.createElement('article');
    wrap.className = `advisor-msg advisor-msg-${role}`;
    const who = document.createElement('div');
    who.className = 'advisor-msg-who';
    who.textContent = ADVISOR_ROLES[role];
    const body = document.createElement('div');
    body.className = 'advisor-msg-body';
    // textContent, non innerHTML: il contenuto viene da un modello LLM e dai
    // risultati degli strumenti. Non deve poter iniettare markup.
    body.textContent = String(message?.content ?? '');
    wrap.appendChild(who);
    wrap.appendChild(body);

    const meta = [];
    if (message?.toolName) meta.push(`strumenti: ${message.toolName}`);
    const cost = Number(message?.costUsd);
    if (Number.isFinite(cost) && cost > 0) meta.push(this._fmtCost(cost));
    const when = this._fmtTime(message?.ts);
    if (when) meta.push(when);
    if (meta.length) {
      const metaEl = document.createElement('div');
      metaEl.className = 'advisor-msg-meta';
      metaEl.textContent = meta.join(' · ');
      wrap.appendChild(metaEl);
    }
    return wrap;
  }

  _renderComposer() {
    const input = document.getElementById('advisorInput');
    const send = document.getElementById('advisorSend');
    const blocked = !this.available;
    if (input) {
      input.disabled = blocked;
      input.placeholder = blocked
        ? 'Consulente non disponibile'
        : 'Chiedi al consulente… (Invio per inviare, Shift+Invio per andare a capo)';
    }
    if (send) {
      send.disabled = blocked || this.sending;
      send.textContent = this.sending ? 'Attendi…' : 'Invia';
    }
  }
}

const advisor = new AdvisorDrawer();
window.advisor = advisor;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => advisor.init());
} else {
  advisor.init();
}
