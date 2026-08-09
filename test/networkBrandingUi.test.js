/**
 * Branding di rete (public/perps.js, public/index.html) — BRAND-01
 * ================================================================
 *
 * Prima di questo lavoro `index.html` diceva "Testnet Only" nel titolo della tab,
 * "TESTNET ONLY" nel badge e "Non utilizzare su mainnet" nel footer, fissi nel
 * markup. L'app supporta mainnet con un gate esplicito (`ALLOW_MAINNET`) e una
 * checklist GO-LIVE dedicata: quelle tre affermazioni erano semplicemente false
 * appena la si accendeva, e sono la prima cosa che un utente legge.
 *
 * La fonte di verità è `GET /api/perps/network`, cioè la rete su cui il server sta
 * operando davvero. Questi casi verificano che nessuna delle superfici testuali
 * affermi il falso in nessuno dei due stati.
 *
 * Come per gli altri test di `public/*.js`: caricamento in `node:vm` con DOM finto,
 * quindi è coperto il comportamento della classe, non il rendering reale — la
 * corrispondenza degli id con `public/index.html` è verificata a parte, sul markup.
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

function fakeElement(id) {
  const classes = new Set();
  return {
    id, textContent: '', innerHTML: '', title: '', value: '', dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c); else classes.delete(c);
        return classes.has(c);
      }
    },
    addEventListener: () => {},
    querySelector: () => null,
    hasClass: (c) => classes.has(c)
  };
}

/** Carica perps.js e applica il branding per la rete indicata dal server. */
async function loadBranding(network) {
  const ids = ['networkBadge', 'footerNetworkNotice', 'cockpitNetworkEyebrow',
    'cockpitOrderNotice', 'faucetCard', 'walletStatus'];
  const elements = Object.fromEntries(ids.map(id => [id, fakeElement(id)]));

  const sandbox = {
    console, BigInt,
    window: {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      title: '🤖 ArbitrageBot Perps',
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    fetch: async () => ({ ok: true, json: async () => ({ success: true, data: { network } }) }),
    alert: () => {}, confirm: () => true,
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERPS_JS, 'utf8'), sandbox, { filename: 'perps.js' });

  const perps = sandbox.window.perps;
  await perps.loadNetwork();
  return { perps, elements, title: () => sandbox.document.title };
}

test('testnet: titolo, badge, footer e strip dichiarano testnet, badge non allarmato', async () => {
  const ui = await loadBranding('testnet');
  assert.equal(ui.perps.network, 'testnet');
  assert.match(ui.title(), /TESTNET/);
  assert.match(ui.elements.networkBadge.textContent, /TESTNET/);
  assert.equal(ui.elements.networkBadge.hasClass('is-mainnet'), false);
  assert.match(ui.elements.footerNetworkNotice.textContent, /[Tt]estnet/);
  assert.match(ui.elements.cockpitNetworkEyebrow.textContent, /TESTNET/);
  assert.match(ui.elements.cockpitOrderNotice.textContent, /Testnet/);
});

test('mainnet: nessuna superficie afferma "solo testnet" e i fondi reali sono dichiarati', async () => {
  const ui = await loadBranding('mainnet');
  assert.equal(ui.perps.network, 'mainnet');

  const testi = [
    ui.title(),
    ui.elements.networkBadge.textContent,
    ui.elements.footerNetworkNotice.textContent,
    ui.elements.cockpitNetworkEyebrow.textContent,
    ui.elements.cockpitOrderNotice.textContent
  ];
  for (const t of testi) {
    assert.equal(/testnet/i.test(t), false, `"${t}" non deve parlare di testnet in mainnet`);
  }
  assert.match(ui.title(), /MAINNET/);
  assert.match(ui.elements.networkBadge.textContent, /MAINNET/);
  assert.match(ui.elements.networkBadge.textContent, /FONDI REALI/);
  assert.equal(ui.elements.networkBadge.hasClass('is-mainnet'), true, 'il badge va evidenziato in mainnet');
  assert.match(ui.elements.footerNetworkNotice.textContent, /fondi reali/i);
});

test('il branding segue un cambio rete a caldo, non solo il primo caricamento', async () => {
  const ui = await loadBranding('testnet');
  assert.match(ui.elements.networkBadge.textContent, /TESTNET/);
  ui.perps.network = 'mainnet';
  ui.perps._applyNetworkBranding();
  assert.match(ui.elements.networkBadge.textContent, /MAINNET/);
  assert.equal(ui.elements.networkBadge.hasClass('is-mainnet'), true);
});

test('index.html non contiene più affermazioni di rete fisse, e espone gli id del branding', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const markup = html.replace(/<!--[\s\S]*?-->/g, ''); // i commenti citano le vecchie stringhe di proposito

  assert.equal(/Testnet Only/i.test(markup), false, 'niente "Testnet Only" nel titolo');
  assert.equal(markup.includes('TESTNET ONLY'), false, 'niente badge "TESTNET ONLY" fisso');
  assert.equal(/Non utilizzare su mainnet/i.test(markup), false, 'niente avvertenza falsa nel footer');
  assert.equal(/Solo per uso su testnet/i.test(markup), false);

  for (const id of ['networkBadge', 'footerNetworkNotice', 'cockpitNetworkEyebrow', 'cockpitOrderNotice']) {
    assert.match(markup, new RegExp(`id="${id}"`), `manca id="${id}" in index.html`);
  }

  // Il selettore di rete Hyperliquid resta l'unico posto dove "Testnet"/"Mainnet"
  // sono etichette fisse: sono i due pulsanti di scelta, non un'affermazione.
  assert.match(markup, /data-net="testnet"/);
  assert.match(markup, /data-net="mainnet"/);
});
