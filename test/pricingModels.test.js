/**
 * LLM-PRICE-01 · il listino `pricing.models` è un GATE, non una tabella decorativa.
 * ================================================================================
 *
 * Perché questo file esiste. Gli alias DeepSeek su cui il listino era keyato
 * (`deepseek-chat`, `deepseek-reasoner`) sono stati ritirati il 2026-07-24. La
 * conseguenza non era "prezzi vecchi": `resolvePricing()` fa match esatto e poi per
 * prefisso, quindi per un ID DeepSeek attuale non trovava NIENTE, `hasPricing()`
 * tornava false e `getProvider()` rifiutava di costruire il fornitore con
 * `missing_pricing`. L'intero percorso multi-provider DeepSeek era inutilizzabile, e
 * lo è rimasto per settimane perché **nessun test copriva il tratto listino →
 * fornitore**: i test esistenti nominavano l'alias ritirato, quindi passavano
 * verificando un modello che non esiste più.
 *
 * Da qui la forma delle verifiche qui sotto: sono sulle PROPRIETÀ del listino e
 * iterano sulle sue chiavi reali. Un test che asserisse `hasPricing('deepseek-v4-pro')`
 * sarebbe inutile allo stesso modo — passerebbe oggi e resterebbe verde il giorno in
 * cui quell'ID verrà ritirato a sua volta, che è esattamente il guasto da intercettare.
 *
 * La cosa che i test NON possono verificare, e va detta: nessuno di questi controlli sa
 * se un ID esiste ancora presso il fornitore, né se il prezzo è quello giusto — per
 * saperlo serve il listino pubblico. Qui si verifica che il listino sia INTERNAMENTE
 * COERENTE e utilizzabile end-to-end; la freschezza dei numeri resta un fatto umano,
 * datato nel commento in config.js.
 *
 * Nessuna rete e nessuna chiave reale: `getProvider` costruisce l'adattatore senza
 * chiamare nulla, e le chiavi finte servono solo a far risultare i fornitori configurati.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js fotografa l'ambiente al caricamento: le chiavi finte vanno impostate prima.
process.env.DEEPSEEK_API_KEY = 'chiave-finta-mai-inviata';
process.env.OPENROUTER_API_KEY = 'chiave-finta-mai-inviata';

const { HYPERLIQUID_CONFIG } = await import('../src/config/config.js');
const { hasPricing, resolvePricing, priceOf } = await import('../src/agents/usage.js');
const { getProvider, ProviderError } = await import('../src/agents/providers/index.js');

const pricing = HYPERLIQUID_CONFIG.agents.pricing;
const models = pricing.models;
const ids = Object.keys(models);

/** Il fornitore a cui appartiene un ID, dedotto dalla forma del nome. */
function providerFor(id) {
  if (id.startsWith('claude-')) return 'anthropic';
  return id.includes('/') ? 'openrouter' : 'deepseek';
}

// --------------------------------------------------- coerenza interna del listino ---

test('ogni voce del listino ha tariffe positive e finite', () => {
  assert.ok(ids.length >= 4, `listino sospettosamente corto: ${ids.length} voci`);
  for (const id of ids) {
    const r = models[id];
    for (const lato of ['in', 'out']) {
      assert.equal(typeof r[lato], 'number', `${id}.${lato} non è un numero`);
      assert.ok(Number.isFinite(r[lato]), `${id}.${lato} non è finito (parseFloat di un valore non valido?)`);
      assert.ok(r[lato] > 0, `${id}.${lato} = ${r[lato]}: una tariffa 0 significa costo 0 e budget che non frena mai`);
    }
    assert.ok(r.out >= r.in, `${id}: output (${r.out}) più economico dell'input (${r.in}) — nessun fornitore lo fa, è probabile uno scambio di colonne`);
  }
});

test('nessuna voce del listino viene intercettata dal tier Anthropic per sottostringa', () => {
  // La trappola concreta: un ID che contenga "sonnet"/"opus"/"haiku" verrebbe risolto
  // dal tier PRIMA di essere utile come voce esatta? No — l'ordine in resolvePricing è
  // models-esatto, models-prefisso, poi tier. Questo test blocca la regressione se
  // quell'ordine venisse invertito, perché allora un DeepSeek tornerebbe a costare
  // come Sonnet: è il bug che LLM-01 aveva chiuso.
  for (const id of ids) {
    const r = resolvePricing(id);
    assert.ok(r, `${id} non è risolvibile pur essendo una chiave del listino`);
    assert.equal(r.source, 'model', `${id} risolto via "${r.source}" invece che per voce esatta`);
    assert.equal(r.key, id);
  }
});

test('le chiavi non si fanno ombra tra loro per prefisso', () => {
  // `resolvePricing` ripiega sul prefisso PIÙ LUNGO. Se una chiave fosse prefisso di
  // un'altra, la più corta non sarebbe mai un problema per la più lunga (vince la
  // lunga), ma il contrario è un errore facile da introdurre aggiungendo una voce
  // "di famiglia" tipo `deepseek-v4`: si mangerebbe ogni variante più specifica
  // aggiunta dopo. Meglio saperlo mentre si aggiunge la voce.
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      assert.equal(a.startsWith(b), false,
        `"${b}" è prefisso di "${a}": togli la voce generica o rendila più specifica, altrimenti le tariffe si confondono`);
    }
  }
});

// ------------------------------------------- il gate listino → fornitore, DeepSeek ---

/**
 * Gli ID che questo progetto INTENDE poter usare, scritti qui e non derivati da
 * `pricing.models`.
 *
 * La duplicazione è deliberata ed è il punto di tutto il file. Il primo giro di questo
 * test iterava sulle chiavi del listino, e ho verificato che NON intercettava il guasto:
 * rimettendo gli alias ritirati in config.js restava verde, perché prendeva come oracolo
 * la stessa cosa che doveva giudicare. Un listino non può testimoniare di sé di essere
 * aggiornato. Qui la lista è la SPECIFICA e `config.js` l'implementazione: se le due
 * divergono — un ID rinominato di là e non di qua — il test è rosso, che è esattamente
 * l'allarme che è mancato per settimane dopo il 2026-07-24.
 *
 * Aggiornare questa lista è un atto consapevole: chi cambia un ID deve dichiararlo in
 * due posti, e il secondo posto è quello che chiede "l'hai verificato sul listino?".
 */
const ID_ATTESI = [
  { id: 'deepseek-v4-pro', provider: 'deepseek' },
  { id: 'deepseek-v4-flash', provider: 'deepseek' },
  { id: 'deepseek/deepseek-v4-pro', provider: 'openrouter' },
  { id: 'deepseek/deepseek-v4-flash', provider: 'openrouter' }
];

test('DeepSeek è di nuovo utilizzabile: gli ID attuali costruiscono davvero il fornitore', () => {
  // È IL criterio di LLM-PRICE-01. Prima della correzione questo test era rosso su ogni
  // riga con `missing_pricing`: è la prova che il percorso multi-provider era fermo, non
  // solo prezzato male.
  for (const { id, provider } of ID_ATTESI) {
    assert.equal(hasPricing(id), true,
      `${id} non ha un listino: getProvider rifiuterà di partire con missing_pricing`);
    const p = getProvider({ provider, model: id });
    assert.equal(p.model, id);
    assert.equal(p.name, provider, `${id} deve essere costruito dal fornitore ${provider}`);
    assert.equal(p.isAvailable(), true, `${id}: fornitore costruito ma non utilizzabile`);
  }
});

test('la specifica e il listino non divergono in nessuna delle due direzioni', () => {
  // Un ID in più nel listino non è un errore (Anthropic ci sta di diritto), ma un ID
  // DeepSeek presente in config e non qui significa che qualcuno ne ha aggiunto uno
  // senza dichiararlo — e nessuno lo starebbe verificando.
  const attesi = new Set(ID_ATTESI.map(m => m.id));
  const nelListino = ids.filter(id => providerFor(id) !== 'anthropic');
  for (const id of nelListino) {
    assert.ok(attesi.has(id),
      `"${id}" è nel listino ma non in ID_ATTESI: aggiungilo qui dopo averne verificato il prezzo alla fonte`);
  }
  assert.equal(nelListino.length, ID_ATTESI.length);
});

test('entrambi i fornitori alternativi sono coperti, non solo uno', () => {
  // Senza questo, un listino con solo voci `deepseek/...` passerebbe i test qui sopra
  // lasciando DeepSeek diretto rotto (o viceversa).
  const perFornitore = new Set(ID_ATTESI.map(m => m.provider));
  assert.deepEqual([...perFornitore].sort(), ['deepseek', 'openrouter']);
});

test('un ID DeepSeek RITIRATO non viene prezzato e il fornitore si rifiuta di partire', () => {
  // Il comportamento voluto, non un difetto: chiedere un modello che non esiste più
  // deve fermarsi subito con un motivo leggibile, non ricadere su una tariffa altrui.
  // Se un domani qualcuno "risolvesse" il problema riaggiungendo l'alias vecchio al
  // listino, questo test lo direbbe.
  for (const ritirato of ['deepseek-chat', 'deepseek-reasoner', 'deepseek/deepseek-chat', 'deepseek/deepseek-r1']) {
    assert.equal(hasPricing(ritirato), false, `${ritirato} è stato ritirato il 2026-07-24: non deve avere un listino`);
    assert.throws(
      () => getProvider({ provider: providerFor(ritirato), model: ritirato }),
      (e) => e instanceof ProviderError && e.code === 'missing_pricing',
      `${ritirato}: atteso un rifiuto esplicito con codice missing_pricing`
    );
  }
});

test('le varianti datate di un ID attuale ricadono sul prefisso, non nel vuoto', () => {
  // I fornitori pubblicano spesso `<id>-AAAA-MM`. Senza il ripiego sul prefisso ogni
  // pin di versione datato risulterebbe senza listino e il fornitore non partirebbe.
  const id = ids.find(k => providerFor(k) === 'deepseek');
  const datato = `${id}-2026-08`;
  const r = resolvePricing(datato);
  assert.equal(r.source, 'model-prefix');
  assert.equal(r.key, id);
  assert.equal(priceOf(datato, { tokensIn: 1e6 }), models[id].in, 'la variante datata paga la tariffa della voce base');
});

// ------------------------------------------------------------- tier Anthropic ------

test('i tier Anthropic restano e coprono i modelli pinnati di default', () => {
  // I default di analystModel/advisorModel sono i modelli che girano DAVVERO se
  // nessuno tocca l'ambiente: se uno dei due restasse senza tariffa, il suo costo
  // sarebbe 0 e il budget di ADV-03 non frenerebbe mai.
  for (const model of [HYPERLIQUID_CONFIG.agents.analystModel, HYPERLIQUID_CONFIG.agents.advisorModel]) {
    assert.equal(hasPricing(model), true, `${model} (default in config) non ha tariffa`);
  }
  assert.equal(resolvePricing(HYPERLIQUID_CONFIG.agents.analystModel).key, 'sonnet');
  assert.equal(resolvePricing(HYPERLIQUID_CONFIG.agents.advisorModel).key, 'haiku');
});

test('Opus non è più prezzato come la generazione ritirata', () => {
  // Era 15/75, cioè Opus 4.1/4 (ritirati). La famiglia acquistabile sta a 5/25:
  // il default vecchio sovrastimava di 3x l'unico Opus che si possa chiamare oggi.
  assert.equal(pricing.opus.in, 5);
  assert.equal(pricing.opus.out, 25);
  const perMilione = priceOf('claude-opus-5', { tokensIn: 1e6, tokensOut: 1e6 });
  assert.equal(perMilione, 30, '5 in + 25 out per milione di token');
});

test('Sonnet 5 costa meno del tier sonnet, e la voce esatta lo rende noto al budget', () => {
  // La proprietà che conta: chi passa a Sonnet 5 non deve pagare la tariffa del tier
  // (3/15, giusta per il pinnato claude-sonnet-4-6). Senza la voce esatta sarebbe
  // sovrastimato del 50%.
  const usage = { tokensIn: 1e6, tokensOut: 1e6 };
  const sonnet5 = priceOf('claude-sonnet-5', usage);
  const tier = priceOf('claude-sonnet-4-6', usage);
  assert.equal(resolvePricing('claude-sonnet-5').source, 'model');
  assert.equal(resolvePricing('claude-sonnet-4-6').source, 'tier');
  assert.ok(sonnet5 < tier, `Sonnet 5 (${sonnet5}) deve costare meno del tier (${tier})`);
  assert.equal(sonnet5, 12, '2 in + 10 out per milione');
});

// ---------------------------------------------------------- override da ambiente ---

test('ogni tariffa resta sovrascrivibile da ambiente', async () => {
  // Criterio esplicito della storia ("nessun comportamento cambia per chi già imposta
  // le proprie variabili"). Va verificato in un PROCESSO SEPARATO: config.js legge
  // l'ambiente una volta sola, al caricamento, quindi impostare la variabile qui non
  // avrebbe effetto sul modulo già importato — un test che lo facesse passerebbe per
  // il motivo sbagliato.
  const { execFileSync } = await import('node:child_process');
  const modelId = ids.find(k => providerFor(k) === 'deepseek');
  const script = `
    const { HYPERLIQUID_CONFIG } = await import('./src/config/config.js');
    const m = HYPERLIQUID_CONFIG.agents.pricing.models[${JSON.stringify(modelId)}];
    process.stdout.write(JSON.stringify({ in: m.in, out: m.out, opus: HYPERLIQUID_CONFIG.agents.pricing.opus }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      PRICE_DEEPSEEK_V4_PRO_IN: '1.23',
      PRICE_DEEPSEEK_V4_PRO_OUT: '4.56',
      PRICE_OPUS_IN: '7.89'
    },
    encoding: 'utf8'
  });
  const got = JSON.parse(out);
  assert.equal(got.in, 1.23, 'PRICE_DEEPSEEK_V4_PRO_IN ignorata');
  assert.equal(got.out, 4.56, 'PRICE_DEEPSEEK_V4_PRO_OUT ignorata');
  assert.equal(got.opus.in, 7.89, 'anche i tier restano sovrascrivibili');
  assert.equal(got.opus.out, 25, 'e una variabile non impostata lascia il default');
});
