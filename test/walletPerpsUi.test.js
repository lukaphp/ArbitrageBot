/**
 * Wallet MetaMask dentro la UI Perps (public/perps.js) — EVM-01
 * =============================================================
 *
 * Fino allo Sprint 2 lo stato del wallet viveva in `public/app.js` (la demo di
 * arbitraggio EVM) e la vista Perps lo leggeva da lì: `perps.connected` era un
 * getter su `app.isConnected`. Il ritiro della demo ha eliminato `app.js`, quindi
 * il rischio vero di EVM-01 non è "resta codice morto", è "si porta via la
 * connessione MetaMask che serve a firmare l'approvazione dell'agent e i
 * trasferimenti Spot→Perp". Questi casi coprono esattamente quella regressione:
 *
 *  - il pill #walletStatus in header è cliccabile e connette/disconnette;
 *  - la riconnessione all'avvio usa `eth_accounts` (nessun popup non richiesto);
 *  - `enableAgent()` e `transferToPerp()` firmano con l'indirizzo migrato;
 *  - nessuna rete EVM viene verificata o forzata durante la connessione;
 *  - `setNetwork()` (testnet/mainnet di Hyperliquid) è intatto — vincolo esplicito
 *    del planning: è un'altra cosa che condivide solo la parola "testnet".
 *
 * `public/perps.js` è uno script di browser (nessun export): viene caricato in un
 * contesto `node:vm` con un DOM finto minimale, come già in killSwitchUi.test.js —
 * zero dipendenze aggiuntive, nessun headless browser. Coperto quindi il
 * comportamento della classe, non il rendering reale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERPS_JS = path.join(HERE, '..', 'public', 'perps.js');
const INDEX_HTML = path.join(HERE, '..', 'public', 'index.html');
const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

/** Elemento DOM finto: solo ciò che perps.js usa davvero. */
function fakeElement(id, initialClasses = []) {
  const classes = new Set(initialClasses);
  const children = { '.text': { textContent: '' } };
  const listeners = {};
  return {
    id,
    textContent: '',
    innerHTML: '',
    title: '',
    value: '',
    dataset: {},
    listeners,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c);
        else classes.delete(c);
        return classes.has(c);
      }
    },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    click: () => (listeners.click || []).forEach(fn => fn({})),
    querySelector: (sel) => children[sel] || null,
    hasClass: (c) => classes.has(c),
    label: () => children['.text'].textContent
  };
}

/**
 * Carica perps.js in un contesto isolato.
 * `ethereum` assente = MetaMask non installato; `accounts` = account già
 * autorizzati (quelli che `eth_accounts` restituisce senza aprire popup).
 */
function loadPerpsUi({ withMetaMask = true, accounts = [], rejectRequest = null } = {}) {
  const elements = {
    walletStatus: fakeElement('walletStatus', ['offline']),
    perpsNotConnected: fakeElement('perpsNotConnected'),
    perpsAccountBody: fakeElement('perpsAccountBody', ['hidden']),
    transferAmount: fakeElement('transferAmount'),
    networkBadge: fakeElement('networkBadge'),
    footerNetworkNotice: fakeElement('footerNetworkNotice'),
    cockpitNetworkEyebrow: fakeElement('cockpitNetworkEyebrow'),
    cockpitOrderNotice: fakeElement('cockpitOrderNotice')
  };
  const requests = [];
  const rpc = [];
  const toasts = [];

  const ethereum = {
    on: () => {},
    request: async ({ method, params }) => {
      rpc.push({ method, params });
      if (rejectRequest && rejectRequest.method === method) throw rejectRequest.error;
      if (method === 'eth_accounts') return accounts;
      if (method === 'eth_requestAccounts') return accounts.length ? accounts : [ADDRESS];
      if (method === 'eth_chainId') return '0xa4b1';
      if (method === 'eth_signTypedData_v4') return '0x' + 'ab'.repeat(65);
      return null;
    }
  };

  const sandbox = {
    console,
    BigInt,
    window: withMetaMask ? { ethereum } : {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '🤖 ArbitrageBot Perps',
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async (url, opts = {}) => {
      requests.push({ url, method: opts.method, body: opts.body });
      let data = {};
      if (url.startsWith('/api/perps/agent/prepare')) {
        data = { typedData: { domain: {}, types: {}, message: {}, primaryType: 'ApproveAgent' }, action: { type: 'approveAgent' } };
      } else if (url.startsWith('/api/perps/transfer/prepare')) {
        data = { typedData: { domain: {}, types: {}, message: {}, primaryType: 'UsdClassTransfer' }, action: { type: 'usdClassTransfer' } };
      } else if (url.startsWith('/api/perps/network')) {
        data = { network: 'testnet' };
      }
      return { ok: true, json: async () => ({ success: true, data }) };
    },
    alert: (msg) => toasts.push({ msg, type: 'alert' }),
    confirm: () => true,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {}
  };
  sandbox.window.shell = { showToast: (msg, type) => toasts.push({ msg, type }) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  const perps = sandbox.window.perps;
  return {
    perps, requests, rpc, toasts, elements,
    pillOnline: () => elements.walletStatus.hasClass('online'),
    pillLabel: () => elements.walletStatus.label(),
    signed: () => rpc.filter(r => r.method === 'eth_signTypedData_v4')
  };
}

test('stato iniziale: nessun wallet, indirizzo neutro e pill offline', () => {
  const ui = loadPerpsUi();
  assert.equal(ui.perps.connected, false);
  assert.equal(ui.perps.address, '0x0000000000000000000000000000000000000000');
  assert.equal(ui.pillOnline(), false);
});

test('initWallet riconnette in silenzio con eth_accounts, senza chiedere il permesso', async () => {
  const ui = loadPerpsUi({ accounts: [ADDRESS] });
  await ui.perps.initWallet();

  assert.equal(ui.perps.connected, true, 'account già autorizzato → connesso');
  assert.equal(ui.perps.address, ADDRESS);
  // eth_requestAccounts apre il popup di MetaMask: al caricamento pagina non va chiamato.
  assert.equal(ui.rpc.some(r => r.method === 'eth_requestAccounts'), false);
  assert.equal(ui.pillOnline(), true);
  assert.match(ui.pillLabel(), /^0x1234…5678$/);
});

test('initWallet senza account autorizzati non connette e non apre popup', async () => {
  const ui = loadPerpsUi({ accounts: [] });
  await ui.perps.initWallet();
  assert.equal(ui.perps.connected, false);
  assert.equal(ui.rpc.some(r => r.method === 'eth_requestAccounts'), false);
});

test('il pill #walletStatus in header connette al click (unico punto di ingresso dopo EVM-01)', async () => {
  const ui = loadPerpsUi({ accounts: [] });
  await ui.perps.initWallet();

  assert.ok(ui.elements.walletStatus.listeners.click?.length, 'il click deve essere agganciato');
  ui.elements.walletStatus.click();
  await new Promise(r => process.nextTick(r));

  assert.equal(ui.rpc.some(r => r.method === 'eth_requestAccounts'), true);
  assert.equal(ui.perps.connected, true);
  assert.equal(ui.pillOnline(), true);
});

test('un secondo click sul pill disconnette e riporta l\'etichetta a MetaMask', async () => {
  const ui = loadPerpsUi({ accounts: [ADDRESS] });
  await ui.perps.initWallet();
  assert.equal(ui.perps.connected, true);

  ui.elements.walletStatus.click();
  assert.equal(ui.perps.connected, false);
  assert.equal(ui.perps.address, '0x0000000000000000000000000000000000000000');
  assert.equal(ui.pillOnline(), false);
  assert.equal(ui.pillLabel(), 'MetaMask');
});

test('connessione: nessuna rete EVM viene letta, verificata o cambiata', async () => {
  const ui = loadPerpsUi({ accounts: [] });
  await ui.perps.initWallet();
  await ui.perps.connectWallet();

  // Erano queste chiamate a bloccare la connessione su Sepolia/BSC/Polygon Amoy:
  // reti del vecchio bot multi-chain, che a Hyperliquid non servono.
  const vietate = ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_getBalance'];
  for (const m of vietate) {
    assert.equal(ui.rpc.some(r => r.method === m), false, `${m} non deve essere chiamato`);
  }
});

test('rifiuto dell\'utente (codice 4001): messaggio neutro, non un errore', async () => {
  const ui = loadPerpsUi({
    accounts: [], rejectRequest: { method: 'eth_requestAccounts', error: { code: 4001, message: 'User rejected' } }
  });
  await ui.perps.connectWallet();
  assert.equal(ui.perps.connected, false);
  assert.equal(ui.toasts.at(-1).type, 'info');
});

test('MetaMask assente: messaggio esplicito e nessun crash', async () => {
  const ui = loadPerpsUi({ withMetaMask: false });
  await ui.perps.initWallet(0);
  await ui.perps.connectWallet();
  assert.equal(ui.perps.connected, false);
  assert.match(ui.toasts.at(-1).msg, /MetaMask non disponibile/);
});

test('APPROVAZIONE AGENT: firma EIP-712 con l\'indirizzo migrato e invio a Hyperliquid', async () => {
  const ui = loadPerpsUi({ accounts: [ADDRESS] });
  await ui.perps.initWallet();
  await ui.perps.enableAgent();

  const prep = ui.requests.find(r => r.url === '/api/perps/agent/prepare');
  assert.ok(prep, 'chiamato /api/perps/agent/prepare');
  assert.equal(JSON.parse(prep.body).address, ADDRESS, 'usa l\'indirizzo del wallet, non lo zero address');

  const sign = ui.signed()[0];
  assert.ok(sign, 'firma eth_signTypedData_v4 richiesta');
  assert.equal(sign.params[0], ADDRESS, 'la firma è richiesta all\'account connesso');

  const submit = ui.requests.find(r => r.url === '/api/perps/agent/submit');
  assert.ok(submit, 'approvazione inviata al server');
  assert.equal(JSON.parse(submit.body).address, ADDRESS);
});

test('TRANSFER SPOT→PERP: firma e invio usano lo stato wallet migrato', async () => {
  const ui = loadPerpsUi({ accounts: [ADDRESS] });
  await ui.perps.initWallet();
  ui.elements.transferAmount.value = '25';
  await ui.perps.transferToPerp();

  const prep = ui.requests.find(r => r.url === '/api/perps/transfer/prepare');
  assert.ok(prep, 'chiamato /api/perps/transfer/prepare');
  const body = JSON.parse(prep.body);
  assert.equal(body.address, ADDRESS);
  assert.equal(body.amount, 25);
  assert.equal(body.toPerp, true);
  assert.ok(ui.signed().length, 'la firma passa da MetaMask');
});

test('transferToPerp senza wallet connesso avvisa e non firma nulla', async () => {
  const ui = loadPerpsUi({ accounts: [] });
  ui.elements.transferAmount.value = '25';
  await ui.perps.transferToPerp();
  assert.equal(ui.signed().length, 0);
  assert.match(ui.toasts.at(-1).msg, /Connetti MetaMask/);
});

test('VINCOLO PLANNING: il selettore Testnet/Mainnet di Hyperliquid è intatto', async () => {
  const ui = loadPerpsUi();
  // Nessun wallet connesso: la rete Hyperliquid è indipendente da MetaMask.
  assert.equal(typeof ui.perps.setNetwork, 'function');
  await ui.perps.setNetwork('mainnet');

  const post = ui.requests.find(r => r.url === '/api/perps/network' && r.method === 'POST');
  assert.ok(post, 'il cambio rete passa ancora da POST /api/perps/network');
  assert.deepEqual(JSON.parse(post.body), { network: 'mainnet', confirm: true });
});

test('perps.js non fa più riferimento al globale `app` rimosso con app.js', () => {
  const src = fs.readFileSync(PERPS_JS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')      // via i commenti a blocco
    .replace(/(^|[^:])\/\/.*$/gm, '$1');   // via i commenti di riga
  // `app.hyperliquid.xyz` / `app.hyperliquid-testnet.xyz` sono host di Hyperliquid, non il globale.
  assert.equal(
    /(^|[^.\w])app\s*\??\.(?!hyperliquid)/.test(src), false,
    'nessun uso di app.* / app?.* nel codice'
  );
});

test('index.html: script legacy via, pill wallet e selettore rete Hyperliquid al loro posto', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const markup = html.replace(/<!--[\s\S]*?-->/g, ''); // i commenti citano app.js di proposito

  assert.equal(/<script[^>]*src="app\.js/.test(markup), false, 'app.js non più caricato');
  assert.equal(/<script[^>]*src="boot\.js/.test(markup), false, 'boot.js non più caricato');
  assert.match(markup, /<script src="shell\.js/);
  assert.equal(markup.includes('wallet-section'), false, 'nessun riferimento a .wallet-section');
  assert.equal(markup.includes('id="connectWallet"'), false, 'il vecchio pulsante nascosto è rimosso');

  // Il pill resta e resta azionabile anche da tastiera.
  assert.match(markup, /id="walletStatus"[^>]*role="button"[^>]*tabindex="0"/);

  // Vincolo del planning: i pulsanti di rete Hyperliquid non sono stati toccati.
  assert.match(markup, /perps\.setNetwork\('testnet'\)/);
  assert.match(markup, /perps\.setNetwork\('mainnet'\)/);
});
