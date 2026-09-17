#!/usr/bin/env node
/**
 * RICALCOLO DEL DRAWDOWN MASSIMO PERSISTITO
 * =========================================
 *
 * Da usare quando si è appena CORRETTO lo storico equity di un account e il
 * massimo di drawdown salvato in `risk_drawdown_state` è rimasto quello vecchio.
 *
 * Perché serve uno strumento e non basta correggere i dati: `mergeDrawdownState`
 * è monotono per disegno — `maxUsd`/`maxPct` sono il massimo fra ciò che si
 * calcola sulla curva e ciò che è persistito — così un vero massimo storico non
 * sparisce quando esce dalla finestra di campioni esposta. L'effetto collaterale
 * è che ripulire `risk_equity_history` NON abbassa il valore mostrato: la prima
 * chiamata a `/api/perps/risk` rilegge il pavimento vecchio e lo riscrive
 * identico. Senza questo passaggio un drawdown mai accaduto (per esempio quello
 * prodotto dal doppio conteggio dell'equity corretto in CRIT-05) resta per
 * sempre, e con lui l'alert `drawdown-critical` che porta la board a `blocked`
 * e il numero che finisce nel contesto del consulente AI.
 *
 * QUANDO NON USARLO: se lo storico è stato POTATO dalla ritenzione (10.000
 * campioni) e non corretto, il massimo persistito è l'unica memoria di un
 * drawdown realmente accaduto — ricalcolare lo cancellerebbe. Lo strumento vale
 * solo dopo aver stabilito che la curva attuale è la verità.
 *
 * Uso:
 *   node scripts/recompute-drawdown.js --network=testnet --address=0x…
 *   node scripts/recompute-drawdown.js --network=testnet --address=0x… --apply
 *   node scripts/recompute-drawdown.js --network=testnet --address=0x… --apply --db=/app/data/perps.db
 *
 * Senza `--apply` mostra soltanto il confronto fra persistito e ricalcolato:
 * un'operazione che riscrive uno stato di rischio non parte per sbaglio.
 * Exit code 0 = riuscito (o simulazione), diverso da 0 = niente è stato scritto.
 */
import { PerpsDatabase } from '../src/db/database.js';
import { recomputeDrawdownFromHistory } from '../src/perps/riskSnapshot.js';

const USO = `Uso: node scripts/recompute-drawdown.js --network=<rete> --address=<0x…> [--apply] [--db=<percorso>] [--limit=<n>]

  --network   rete dell'account (es. testnet, mainnet)
  --address   master address dell'account
  --apply     scrive davvero; senza, mostra solo il confronto
  --db        percorso del file SQLite (default: data/perps.db del repo)
  --limit     quanti campioni leggere da risk_equity_history (default 50000, cioè tutti)`;

function parseArgs(argv) {
  const out = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') { out.apply = true; continue; }
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    const match = /^--([a-zA-Z]+)=(.*)$/.exec(arg);
    if (!match) return { error: `Argomento non riconosciuto: ${arg}` };
    out[match[1]] = match[2];
  }
  return out;
}

function fmt(value, suffix = '') {
  return value == null || !Number.isFinite(Number(value)) ? 'n/d' : `${Number(value).toFixed(2)}${suffix}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(`${args.error}\n\n${USO}`); return 2; }
  if (args.help) { console.log(USO); return 0; }
  if (!args.network || !args.address) {
    console.error(`Mancano --network e/o --address.\n\n${USO}`);
    return 2;
  }

  const limit = Math.max(1, Math.min(50000, Number(args.limit) || 50000));
  const database = new PerpsDatabase(args.db ? { dbPath: args.db } : {});
  try {
    database.init();
    const history = database.listRiskEquityHistory(args.network, args.address, limit);
    const persisted = database.getRiskDrawdownState(args.network, args.address);
    const ricalcolato = recomputeDrawdownFromHistory(history);

    console.log(`Account: ${args.address} (${args.network})`);
    console.log(`Campioni in risk_equity_history: ${history.length}`);
    console.log('Persistito  → maxUsd '
      + `${fmt(persisted?.maxDrawdownUsd)} · maxPct ${fmt(persisted?.maxDrawdownPct, '%')} · peak ${fmt(persisted?.peakEquity)}`);

    if (!ricalcolato) {
      // Nessun campione utilizzabile: azzerare il massimo sarebbe una bugia
      // diversa, non una correzione. Meglio fermarsi e dirlo.
      console.error('Nessuno storico equity utilizzabile per questo account: '
        + 'la curva è vuota o senza campioni numerici, il ricalcolo non è possibile. Niente è stato scritto.');
      return 1;
    }

    console.log('Ricalcolato → maxUsd '
      + `${fmt(ricalcolato.maxUsd)} · maxPct ${fmt(ricalcolato.maxPct, '%')} · peak ${fmt(ricalcolato.peak)}`);

    if (!args.apply) {
      console.log('\nSimulazione: nessuna scrittura. Aggiungi --apply per riscrivere risk_drawdown_state.');
      return 0;
    }

    const scritto = database.upsertRiskDrawdownState(args.network, args.address, ricalcolato, Date.now());
    console.log(`\nrisk_drawdown_state riscritto: maxUsd ${fmt(scritto.maxDrawdownUsd)} · maxPct ${fmt(scritto.maxDrawdownPct, '%')}.`);
    console.log('La prossima lettura di /api/perps/risk ripartirà da questo valore.');
    return 0;
  } catch (error) {
    console.error(`Ricalcolo fallito: ${error.message}`);
    return 1;
  } finally {
    try { database.close(); } catch { /* noop */ }
  }
}

process.exit(main());
