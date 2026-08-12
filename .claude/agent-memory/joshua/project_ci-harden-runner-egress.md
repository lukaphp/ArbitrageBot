---
name: ci-harden-runner-egress
description: CI gira harden-runner in egress-policy block — come leggere gli endpoint reali, i due fail-open da sapere, e perché i dati di audit ingannano
metadata:
  type: project
---

La CI (`.github/workflows/ci.yml`, unico workflow) gira `step-security/harden-runner` in
`egress-policy: block` con allowlist esplicita dallo Sprint 2 di Release 2 (CI-01, 12
agosto 2026).

**Why:** prima era `audit` per accumulare osservazioni. Il passaggio a `block` chiude il
vettore di esfiltrazione da dipendenza compromessa in CI.

**How to apply:** tre cose non ovvie, tutte verificate sul campo, che valgono ogni volta
che si tocca la rete in CI o si aggiorna una dipendenza nativa.

1. **Gli endpoint reali si leggono dal log, non dalla pagina insights.** Il passo
   `Post Harden Runner` riversa nel log del job il registro dell'agente:
   `gh run view <run-id> --log | grep -E "endpoint called|domain not allowed"`.
   Quelle righe hanno il **processo chiamante**, che è l'unica cosa che distingue il
   traffico del job da quello del demone di provisioning della VM (`provjobd`, host
   `hosted-compute-*.githubapp.com`, suffisso di regione che ruota — resta bloccato di
   proposito e va bene così).

2. **Un audit a cache calda descrive UN SOLO cammino di rete.** È il modo in cui CI-01
   ha quasi sbagliato: 31 run di audit non mostravano né
   `release-assets.githubusercontent.com` né `nodejs.org`, perché `prebuild-install`
   tiene il binario di `better-sqlite3` in `~/.npm/_prebuilds`, che sta dentro la
   directory messa in cache da `setup-node` con `cache: 'npm'`. A cache fredda quel
   cammino esce in rete. La cache si invalida a ogni cambio di `package-lock.json`:
   quindi dopo un bump di dipendenze **verifica un run a cache fredda**, non solo uno
   normale.

3. **Due fail-open da conoscere.** (a) harden-runner risolve da sé l'host corrente della
   cache di Actions e lo aggiunge a runtime — per questo `productionresultssaNN.blob...`
   NON va scritto in allowlist (il numero ruota davvero). (b) Se quella risoluzione
   fallisce, l'action degrada **da sola** a `audit`: job verde, ma non sta più bloccando.
   Non è presidiato da nessun controllo automatico — vedi la nota di refinement in
   `sprint2-status/joshua.json`.

Corollario: **"CI verde" non è la prova che la policy sia giusta.** Un endpoint bloccato
non fa fallire il job da sé; va cercato `domain not allowed` nel log.

Vedi [[verifica-prove-reali-non-comando-verde]].
