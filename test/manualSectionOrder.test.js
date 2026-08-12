/**
 * Ordine delle sezioni: docs/MANUAL.md allineato a public/manual.html (DEBT-05)
 * ============================================================================
 *
 * I due file dichiarano di avere lo stesso contenuto, ma l'ordine delle sezioni
 * era diverso: "Indicatori tecnici" era 13ª nell'HTML e 16ª nel Markdown. Il
 * disallineamento è stato trovato in Sprint 4 e rinviato perché riallinearlo non
 * è un'operazione di testo — nel Markdown le sezioni sono numerate, quindi
 * spostarne una vuol dire rinumerare heading, anchor dell'indice e riferimenti
 * `§N` sparsi nel testo.
 *
 * FONTE DI VERITÀ: `public/manual.html`. La sua barra di navigazione raggruppa le
 * sezioni sotto intestazioni che l'utente legge (*Bot & Strategie*,
 * *Intelligenza Artificiale*, …), quindi spostare una sezione lì la sposta anche
 * di gruppo: "Indicatori tecnici" sotto *Intelligenza Artificiale* sarebbe una
 * classificazione falsa. Nel Markdown l'ordine è solo una numerazione.
 *
 * Questo caso esiste perché il disallineamento era invisibile: nessuno dei due
 * file è sbagliato da solo, lo sono solo se confrontati. Senza un test torna alla
 * prima sezione aggiunta in un file e non nell'altro.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANUAL_MD = path.join(HERE, '..', 'docs', 'MANUAL.md');
const MANUAL_HTML = path.join(HERE, '..', 'public', 'manual.html');

const md = () => fs.readFileSync(MANUAL_MD, 'utf8');
const html = () => fs.readFileSync(MANUAL_HTML, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

/** Slug alla GitHub, come lo calcola il rendering degli anchor su MANUAL.md. */
const slug = (t) => t.toLowerCase().replace(/[^\w\s-]/gu, '').replace(/\s/g, '-');

const mdSections = () => [...md().matchAll(/^## (\d+)\. (.+)$/gm)]
  .map(m => ({ num: Number(m[1]), title: m[2].trim() }));

const htmlSections = () => [...html().matchAll(/<section id="([^"]+)" class="doc-section">/g)].map(m => m[1]);

test('stesso numero di sezioni nei due file', () => {
  assert.equal(mdSections().length, htmlSections().length,
    'una sezione è stata aggiunta a un file e non all\'altro');
});

test('la numerazione di MANUAL.md è 1..N senza salti né duplicati', () => {
  const nums = mdSections().map(s => s.num);
  assert.deepEqual(nums, nums.map((_, i) => i + 1),
    `numerazione non consecutiva: ${nums.join(', ')}`);
});

test('ORDINE ALLINEATO: la n-esima sezione del Markdown è la n-esima dell\'HTML', () => {
  // Le due liste hanno titoli diversi per forma (l'HTML ha le emoji e le
  // abbreviazioni della nav), quindi non si confrontano le stringhe: si
  // confronta l'ordine tramite una corrispondenza dichiarata qui. È l'unico
  // punto del repo dove le due tassonomie si toccano, e va letto in review se
  // qualcuno aggiunge una sezione.
  const PAIRS = [
    ['intro', 'Introduzione e architettura'],
    ['wallet', 'MetaMask e Agent Wallet'],
    ['tab-dashboard', 'Tab Dashboard'],
    ['tab-execution', 'Tab Execution — ordini manuali'],
    ['tab-positions', 'Tab Positions'],
    ['tab-performance', 'Tab Performance — storico e aggregazioni'],
    ['tab-risk', 'Tab Risk & Alerts'],
    ['tab-system', 'Tab System — bot automatici'],
    ['bot-advanced', 'Configurazione avanzata dei bot'],
    ['paper', 'Paper trading (forward-test)'],
    ['backtest', 'Backtest e ottimizzazione walk-forward'],
    ['ml', 'Modello ML (predictor) e gate probabilistico'],
    ['indicators', 'Indicatori tecnici'],
    ['analyst-ai', 'Analyst AI e coda delle proposte'],
    ['advisor-ai', 'Consulente AI (drawer di chat)'],
    ['strategy-history', 'Storico strategie'],
    ['webhook', 'Segnali esterni via webhook'],
    ['telegram', 'Controllo via Telegram'],
    ['security', 'Sicurezza e gestione dei segreti'],
    ['monitoring', 'Monitoraggio e metriche'],
    ['faq', 'FAQ e troubleshooting']
  ];

  assert.deepEqual(htmlSections(), PAIRS.map(p => p[0]),
    'l\'ordine delle <section> in manual.html è cambiato: aggiorna la tabella qui sopra E MANUAL.md');
  assert.deepEqual(mdSections().map(s => s.title), PAIRS.map(p => p[1]),
    'MANUAL.md non è più allineato a manual.html — manual.html è la fonte di verità sull\'ordine');
});

test('la nav di manual.html elenca le sezioni nello stesso ordine in cui stanno', () => {
  const nav = [...html().matchAll(/<li class="nav-item"><a href="#([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(nav, htmlSections(),
    'una voce di nav è fuori posto rispetto alla sezione che punta');
});

test('ogni anchor dell\'indice di MANUAL.md risolve a un heading esistente', () => {
  const src = md();
  const headings = new Set([...src.matchAll(/^#{2,4} (.+)$/gm)].map(m => slug(m[1].trim())));
  const anchors = [...src.matchAll(/\]\(#([^)]+)\)/g)].map(m => m[1]);
  assert.ok(anchors.length >= 21, 'indice non trovato');
  for (const anchor of anchors) {
    assert.ok(headings.has(anchor), `anchor "#${anchor}" non punta a nessun titolo`);
  }
});

test('ogni riferimento §N punta a una sezione (o sottosezione) che esiste', () => {
  const src = md();
  const sections = new Set(mdSections().map(s => s.num));
  const subs = new Set([...src.matchAll(/^### (\d+\.\d+) /gm)].map(m => m[1]));
  let checked = 0;
  src.split('\n').forEach((line, i) => {
    // Un solo §N di questo manuale punta fuori: il §5 di DEPLOY.md.
    if (line.includes('DEPLOY.md')) return;
    for (const m of line.matchAll(/§(\d+)(\.\d+)?/g)) {
      checked++;
      if (m[2]) assert.ok(subs.has(m[1] + m[2]), `riga ${i + 1}: §${m[1]}${m[2]} non esiste`);
      else assert.ok(sections.has(Number(m[1])), `riga ${i + 1}: §${m[1]} non esiste`);
    }
  });
  assert.ok(checked > 10, `attesi più riferimenti §, controllati ${checked}`);
});

test('l\'indice elenca i titoli nello stesso ordine dei heading', () => {
  const src = md();
  const indexBlock = src.match(/## Indice\n\n([\s\S]*?)\n\n---/);
  assert.ok(indexBlock, 'blocco indice non trovato');
  const entries = [...indexBlock[1].matchAll(/^(\d+)\. \[(.+?)\]\(#/gm)].map(m => ({ num: Number(m[1]), title: m[2] }));
  assert.deepEqual(entries.map(e => e.num), mdSections().map(s => s.num));
  assert.deepEqual(entries.map(e => e.title), mdSections().map(s => s.title));
});

test('i due file dichiarano la stessa versione', () => {
  // Dicevano 2.8 e 2.7 pur affermando di avere lo stesso contenuto: due numeri
  // diversi sulla stessa cosa sono una mezza verità, ed è il genere di dettaglio
  // che nessuno ricontrolla a mano.
  const mdVersion = md().match(/\*\*Versione ([\d.]+)\*\*/);
  const htmlVersion = html().match(/Versione ([\d.]+)/);
  assert.ok(mdVersion && htmlVersion, 'marcatore di versione non trovato in uno dei due file');
  assert.equal(mdVersion[1], htmlVersion[1], 'MANUAL.md e manual.html dichiarano versioni diverse');
});
