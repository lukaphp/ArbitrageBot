/**
 * FINESTRA SCORREVOLE + RIASSUNTO ROTANTE DELLA CONVERSAZIONE (ADV-02, spike §5)
 * ============================================================================
 *
 * Il problema: in chat il transcript si rispedisce a ogni turno, quindi il costo
 * cresce in modo quadratico nel numero di turni. La finestra è il tetto duro
 * (leva di costo #2 dello spike §4.3): si tengono per intero gli ultimi N turni,
 * i precedenti confluiscono in un riassunto.
 *
 * Il riassunto è DETERMINISTICO — costruito qui, non chiesto al modello — per due
 * motivi indipendenti:
 *
 *  1. **costo**: farsi riassumere la conversazione è un turno in più da pagare, e
 *     lo si pagherebbe proprio quando la sessione è già lunga (cioè cara);
 *  2. **anti-bias** (spike §5 punto 3, rischio S6): un riassunto generato dal
 *     modello riporterebbe le sue CONCLUSIONI precedenti, e al giro dopo le
 *     rileggerebbe come fatti stabiliti. Un consulente che si autoconferma —
 *     "come dicevamo, SOL è forte" — rinforza i bias invece di correggerli.
 *     Qui il riassunto conserva **fatti e numeri**: cosa ha chiesto l'utente e
 *     quali dati sono stati letti. Le opinioni dell'assistente restano fuori, per
 *     costruzione: le sue risposte non entrano affatto nel riassunto.
 *
 * Il pattern esiste già in miniatura nel progetto: `rejectedContext()` in
 * `analyst.js` comprime 12 strategie rifiutate in una riga di prompt.
 */

const MAX_QUESTION_CHARS = 160;
const MAX_QUESTIONS_IN_SUMMARY = 8;
const MAX_TOOLS_IN_SUMMARY = 12;

/** Data/ora compatta in italiano, per dare al riassunto un ancoraggio temporale. */
function stamp(ts) {
  if (!ts) return '?';
  return new Date(ts).toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function shorten(text, max = MAX_QUESTION_CHARS) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Divide i messaggi persistiti in "da riassumere" e "da tenere per intero".
 *
 * L'unità è il TURNO (un messaggio `user`), non il messaggio: tagliare in mezzo a
 * un turno lascerebbe una risposta dell'assistente senza la domanda, o un
 * risultato di strumento senza la richiesta che lo ha prodotto.
 *
 * @param rows righe `chat_messages` in ordine cronologico
 * @param windowTurns quanti turni tenere per intero
 */
export function splitWindow(rows = [], windowTurns = 15) {
  const userIdx = [];
  rows.forEach((r, i) => { if (r.role === 'user') userIdx.push(i); });
  if (userIdx.length <= windowTurns) return { older: [], window: rows, droppedTurns: 0 };
  const cut = userIdx[userIdx.length - windowTurns];
  return {
    older: rows.slice(0, cut),
    window: rows.slice(cut),
    droppedTurns: userIdx.length - windowTurns
  };
}

/**
 * Riassunto rotante dei turni usciti dalla finestra. Idempotente rispetto ai
 * dati: gli stessi messaggi producono lo stesso testo.
 *
 * Conserva: quanti turni, l'intervallo temporale, le DOMANDE dell'utente e gli
 * strumenti consultati (con il mercato, quando l'input lo dichiara).
 * NON conserva: le risposte dell'assistente. È la regola anti-bias, ed è per
 * costruzione — non per filtro a posteriori.
 */
export function buildRollingSummary(older = [], { previousSummary = null } = {}) {
  const questions = older.filter(m => m.role === 'user');
  const toolRows = older.filter(m => m.role === 'tool' && m.tool_name);
  if (!questions.length && !toolRows.length) return previousSummary || null;

  const first = older[0]?.ts;
  const last = older[older.length - 1]?.ts;

  const lines = [];
  lines.push(`Turni precedenti riassunti: ${questions.length} (dal ${stamp(first)} al ${stamp(last)}).`);

  if (questions.length) {
    const recent = questions.slice(-MAX_QUESTIONS_IN_SUMMARY).map(q => `"${shorten(q.content)}"`);
    const omitted = questions.length - recent.length;
    lines.push(`Domande dell'operatore${omitted > 0 ? ` (le ${recent.length} più recenti di ${questions.length})` : ''}: ${recent.join('; ')}.`);
  }

  if (toolRows.length) {
    // Conteggio per strumento (+ mercati toccati): un fatto, non un giudizio.
    const byTool = new Map();
    for (const t of toolRows) {
      const entry = byTool.get(t.tool_name) || { n: 0, coins: new Set() };
      entry.n++;
      const coin = extractCoin(t.content);
      if (coin) entry.coins.add(coin);
      byTool.set(t.tool_name, entry);
    }
    const parts = [...byTool.entries()].slice(0, MAX_TOOLS_IN_SUMMARY).map(([name, e]) => {
      const coins = [...e.coins].slice(0, 4).join(', ');
      return `${name}${coins ? `(${coins})` : ''}${e.n > 1 ? ` ×${e.n}` : ''}`;
    });
    lines.push(`Dati già consultati: ${parts.join('; ')}.`);
  }

  lines.push('Nessuna conclusione o opinione dei turni riassunti è riportata: se una tesi serve ancora, ricavala di nuovo dai dati con gli strumenti.');
  return lines.join('\n');
}

/** Estrae il mercato da un payload di strumento serializzato, se dichiarato. */
function extractCoin(content) {
  if (!content) return null;
  const m = String(content).match(/"coin"\s*:\s*"([^"]{1,20})"/);
  return m ? m[1] : null;
}

/**
 * Costruisce l'array `messages` per l'API a partire dalle righe persistite.
 *
 * Le righe `tool` NON vengono rimandate come blocchi `tool_use`/`tool_result`
 * dei turni passati: si rispedirebbero interi payload di dati (fino a 6.000
 * caratteri l'uno) per turni già conclusi, che è esattamente la crescita di
 * prompt che la finestra deve evitare. Entrano invece nel riassunto come "dati
 * già consultati", così il modello sa di averli visti e può richiederli se
 * servono di nuovo. Il tool-use del turno CORRENTE resta completo: è advisor.js
 * che lo accumula dentro il suo loop.
 */
export function buildApiMessages({ rows = [], summary = null, windowTurns = 15, userMessage }) {
  const { older, window, droppedTurns } = splitWindow(rows, windowTurns);
  const rolling = older.length ? buildRollingSummary(older, { previousSummary: summary }) : summary;

  const messages = [];
  if (rolling) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `[Contesto della conversazione, riassunto]\n${rolling}` }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Ricevuto: userò questi fatti come contesto e ricaverò di nuovo le conclusioni dai dati.' }] });
  }

  for (const row of window) {
    if (row.role === 'user') {
      messages.push({ role: 'user', content: [{ type: 'text', text: String(row.content || '') }] });
    } else if (row.role === 'assistant' && row.content) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: String(row.content) }] });
    }
  }

  if (userMessage) {
    messages.push({ role: 'user', content: [{ type: 'text', text: String(userMessage) }] });
  }

  return { messages, rollingSummary: rolling, droppedTurns };
}

/**
 * L'API richiede che il primo messaggio sia dell'utente e che i ruoli si
 * alternino. Un transcript persistito può essere sbilanciato (turno interrotto a
 * metà da un errore o da un riavvio): due `user` di fila o un `assistant` in
 * testa farebbero fallire la chiamata con un 400 — cioè un turno pagato zero ma
 * una conversazione rotta per sempre.
 */
export function normalizeAlternation(messages = []) {
  const out = [];
  for (const m of messages) {
    if (!out.length && m.role !== 'user') continue;              // niente assistant in testa
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      // Fonde i due blocchi consecutivi dello stesso ruolo invece di scartarne
      // uno: scartare perderebbe una domanda dell'operatore.
      prev.content = [...prev.content, ...m.content];
      continue;
    }
    out.push({ role: m.role, content: [...m.content] });
  }
  // L'ultimo messaggio deve essere dell'utente: è quello a cui rispondere.
  while (out.length && out[out.length - 1].role !== 'user') out.pop();
  return out;
}

export default { splitWindow, buildRollingSummary, buildApiMessages, normalizeAlternation };
