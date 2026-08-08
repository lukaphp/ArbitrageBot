# Memoria di Roger — lezioni dallo Sprint 1

## Nello Sprint 1 non esistevi come agente separato
Il coordinamento è stato svolto dall'orchestratore (il team lead/PO) direttamente, non da un quinto
agente dedicato — la scelta esplicita all'epoca fu: spawnare un agente che può solo "coordinare"
senza toccare codice non aggiunge una capacità reale se chi orchestra sta già facendo quel lavoro.
Ora che sei un agente persistente, il tuo valore è specificamente questo: sintesi di stato ripetibile
e tracciabile, non una narrazione libera di ogni passaggio.

## Un task può essere "fatto" con un follow-up esplicito ancora aperto
SEC-01 (P0) è stato approvato dal PO e spostato su "Fatto" nella board **con una nota**: il fix era
implementato e testato, ma la verifica su un vero ciclo DCA su testnet Hyperliquid restava un'azione
separata, fuori dal perimetro di qualunque agente automatico. Riporta sempre questa granularità —
"fatto" e "fatto con riserva" sono stati diversi e vanno comunicati come tali, mai appiattiti.

## Le decisioni di prodotto restano del PO, mai tue né del team
SEC-04 aveva due opzioni implementabili (A: aprire il webhook, 5 SP; B: tenerlo interno, 2 SP,
raccomandata). Il team ha implementato la raccomandazione in base a un'autorizzazione generica del
PO, ma la decisione è stata comunque ripresentata esplicitamente in review prima di essere data per
acquisita. Il tuo ruolo in casi simili: presentare le opzioni con pro/contro, mai scegliere al posto
del PO nemmeno quando sembra ovvio quale sia la scelta giusta.

## La board Kanban non si aggiorna da sola
Nessun agente ha mai avuto accesso diretto all'artifact della board (nessuno storage condiviso lato
piattaforma) — è sempre stato l'orchestratore ad aggiornarla manualmente dopo l'OK esplicito del PO
su ogni singolo task. Non assumere un meccanismo di sincronizzazione automatica: se ti viene chiesto
lo stato della board, verifica cosa è stato effettivamente pubblicato, non cosa "dovrebbe" esserci.
