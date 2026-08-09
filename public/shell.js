/**
 * SHELL DELL'APPLICAZIONE
 * =======================
 * Parti di interfaccia che non appartengono a nessuna vista in particolare:
 * gate di autenticazione (overlay di login single-user), socket condiviso,
 * toast e helper dei modali.
 *
 * Perché questo file esiste (EVM-01, Sprint 3). Fino allo Sprint 2 questa roba
 * viveva in `public/app.js`, insieme alla demo di arbitraggio EVM e alla
 * connessione MetaMask: tre cose senza relazione tra loro nello stesso oggetto
 * globale `app`. Il ritiro della demo EVM ha eliminato `app.js`, ma login,
 * socket, toast e modali servono ancora — sono usati da `perps.js` e da diversi
 * `onclick` inline in `index.html`, incluso il modale di creazione bot, che è
 * Perps al 100%. Restano quindi qui, senza portarsi dietro nulla della demo.
 *
 * La connessione MetaMask NON sta qui: è passata dentro `perps.js`, che è
 * l'unico consumatore (approvazione agent, transfer spot→perp).
 */

// Polyfill per la serializzazione di BigInt in JSON (evita "Do not know how to serialize a BigInt")
if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function () {
    const num = Number(this);
    return Number.isSafeInteger(num) ? num : this.toString();
  };
}

class AppShell {
  constructor() {
    this.socket = null;
  }

  async init() {
    // Gate di autenticazione (single-user): se attivo e non loggato, mostra il login.
    // Il socket è dietro `auth.socketAuth` lato server: crearlo prima che la
    // sessione esista significherebbe un handshake rifiutato.
    if (!(await this._ensureAuth())) return;
    this.getSocket();
  }

  // ---- Autenticazione ----

  /** Verifica lo stato di autenticazione; mostra il login se necessario. */
  async _ensureAuth() {
    try {
      const res = await fetch('/api/auth/status');
      const { data } = await res.json();
      if (!data?.enabled || data?.authenticated) return true;
    } catch (e) {
      console.warn('auth status non raggiungibile', e);
      return true; // non bloccare se l'endpoint non risponde (es. modalità limitata)
    }
    this._showLogin();
    return false;
  }

  /** Overlay di login (single-user), iniettato via JS. */
  _showLogin() {
    if (document.getElementById('loginOverlay')) return;
    const ov = document.createElement('div');
    ov.id = 'loginOverlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,0.92);backdrop-filter:blur(4px)';
    ov.innerHTML = `
      <form id="loginForm" style="background:#fff;padding:28px 26px;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.4);width:320px;max-width:90vw;font-family:inherit">
        <div style="font-size:30px;text-align:center;margin-bottom:6px">🔒</div>
        <h2 style="margin:0 0 4px;text-align:center;font-size:19px;color:#1a202c">Accesso richiesto</h2>
        <p style="margin:0 0 16px;text-align:center;color:#718096;font-size:13px">Inserisci la password per accedere al pannello di trading.</p>
        <input id="loginPassword" type="password" autocomplete="current-password" placeholder="Password"
          style="width:100%;padding:11px 12px;border:1px solid #cbd5e0;border-radius:8px;font-size:14px;box-sizing:border-box">
        <div id="loginError" style="color:#e53e3e;font-size:12px;min-height:16px;margin:6px 2px"></div>
        <button type="submit" style="width:100%;padding:11px;border:0;border-radius:8px;background:#6366f1;color:#fff;font-size:14px;font-weight:600;cursor:pointer">Accedi</button>
      </form>`;
    document.body.appendChild(ov);
    const form = ov.querySelector('#loginForm');
    const err = ov.querySelector('#loginError');
    ov.querySelector('#loginPassword').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const password = ov.querySelector('#loginPassword').value;
      try {
        const res = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        if (res.ok) { location.reload(); return; }
        if (res.status === 429) { err.textContent = 'Troppi tentativi, riprova tra qualche minuto.'; return; }
        err.textContent = 'Password errata.';
      } catch (_) {
        err.textContent = 'Errore di connessione.';
      }
    });
  }

  async logout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (_) { /* noop */ }
    location.reload();
  }

  // ---- Socket condiviso ----

  /**
   * Socket.IO condiviso, creato una volta sola. Prima di EVM-01 la vista Perps
   * usava `app.socket` con fallback a un `io()` proprio: se `perps.onShow()`
   * partiva prima che `app.init()` avesse finito il suo `await` — cioè sempre —
   * si aprivano due connessioni. La memoizzazione qui rende l'ordine irrilevante.
   */
  getSocket() {
    if (this.socket) return this.socket;
    if (!window.io) return null;
    this.socket = window.io();
    this.socket.on('connect', () => this.updateServerStatus(true));
    this.socket.on('disconnect', () => this.updateServerStatus(false));
    this.socket.on('error', (error) => {
      console.error('Socket error:', error);
      this.showToast(error?.message || 'Errore di connessione', 'error');
    });
    return this.socket;
  }

  updateServerStatus(isOnline) {
    const el = document.getElementById('serverStatus');
    if (!el) return;
    el.classList.toggle('online', !!isOnline);
    el.classList.toggle('offline', !isOnline);
  }

  // ---- Modali ----

  showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('show');
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.classList.remove('show');
    setTimeout(() => modal.classList.add('hidden'), 300);
  }

  closeAllModals() {
    document.querySelectorAll('.modal').forEach(modal => {
      modal.classList.remove('show');
      setTimeout(() => modal.classList.add('hidden'), 300);
    });
  }

  _initModalHandlers() {
    // Chiusura su click sullo sfondo e su Escape.
    document.addEventListener('click', (e) => {
      if (e.target.classList?.contains('modal')) this.closeModal(e.target.id);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeAllModals();
    });
  }

  // ---- Toast ----

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    // textContent, non innerHTML: i messaggi includono anche errori che
    // arrivano dal server, che non devono poter iniettare markup.
    const icon = document.createElement('span');
    icon.textContent = icons[type] || icons.info;
    const text = document.createElement('span');
    text.textContent = message;
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; gap: 0.5rem;';
    row.append(icon, text);
    toast.appendChild(row);

    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 100);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }
}

const shell = new AppShell();
window.shell = shell;
shell._initModalHandlers();

// Usate dagli `onclick` inline in index.html (es. chiusura dei modali Perps).
function showModal(modalId) { shell.showModal(modalId); }
function closeModal(modalId) { shell.closeModal(modalId); }

document.addEventListener('DOMContentLoaded', () => { shell.init(); });
