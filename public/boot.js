// Polyfill per la serializzazione di BigInt in JSON (evita "Do not know how to serialize a BigInt")
if (typeof BigInt.prototype.toJSON !== 'function') {
  BigInt.prototype.toJSON = function () {
    const num = Number(this);
    return Number.isSafeInteger(num) ? num : this.toString();
  };
}

// Switch tra vista Perps (principale) e Arbitraggio (demo)
function switchView(view) {
  document.body.classList.toggle('cockpit-mode', view === 'perps');
  document.getElementById('view-arbitrage').classList.toggle('hidden', view !== 'arbitrage');
  document.getElementById('view-perps').classList.toggle('hidden', view !== 'perps');
  document.querySelectorAll('.view-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === view);
  });
  if (view === 'perps' && window.perps) window.perps.onShow();
}

// Passa subito alla vista Perps principale in modo sincrono per evitare l'interruzione visuale al refresh
switchView('perps');

// Perps è il tab principale. Il modulo Arbitraggio EVM è una demo educativa,
// visibile solo se il server espone DEMO_EVM_ENABLED=true.
(async function bootViews() {
  let demoEvm = false;
  try {
    const res = await fetch('/api/auth/status');
    const { data } = await res.json();
    demoEvm = !!data?.demoEvmEnabled;
  } catch (_) { /* offline: resta solo Perps */ }
  window.__DEMO_EVM_ENABLED__ = demoEvm;
  const tab = document.getElementById('tab-arbitrage');
  if (tab) tab.style.display = demoEvm ? '' : 'none';
})();
