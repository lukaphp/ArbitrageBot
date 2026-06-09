/**
 * AGENT RUNTIME (registry + supervisor)
 * =====================================
 *
 * Avvia/ferma gli agenti, ne schedula i `tick()` periodici e li SUPERVISIONA:
 * ogni tick è in try/catch, gli errori sono tracciati e notificati (con
 * throttling). Un tick che fallisce non uccide l'agente: il successivo riparte,
 * ottenendo un'auto-ripresa robusta. Espone lo stato di salute di ogni agente.
 *
 * Interfaccia agente: { name, intervalMs?, async tick()?, async start()?,
 *   async stop()?, status?() }
 */

import bus, { EVENTS } from './bus.js';
import notifier from '../perps/notifier.js';
import logger from '../utils/logger.js';

class AgentRuntime {
  constructor() {
    this.agents = new Map(); // name -> { agent, timer, running, lastHeartbeat, lastError, errorStreak, lastAlertTs }
  }

  register(agent) {
    if (!agent?.name) throw new Error('Ogni agente deve avere un name');
    this.agents.set(agent.name, {
      agent, timer: null, running: false,
      lastHeartbeat: null, lastError: null, errorStreak: 0, lastAlertTs: 0
    });
    logger.info(`🧩 Agente registrato: ${agent.name}`);
    return this;
  }

  async startAll() {
    for (const rec of this.agents.values()) await this._start(rec);
    logger.info(`🤖 Runtime agenti avviato (${this.agents.size} agenti)`);
  }

  async stopAll() {
    for (const rec of this.agents.values()) await this._stop(rec);
  }

  async _start(rec) {
    const { agent } = rec;
    try {
      if (agent.start) await agent.start();
      rec.running = true;
      rec.lastHeartbeat = Date.now();
      if (agent.intervalMs && agent.tick) {
        rec.timer = setInterval(() => this._runTick(rec), agent.intervalMs);
      }
    } catch (e) {
      rec.lastError = e.message;
      logger.error(`Agente ${agent.name}: avvio fallito`, e.message);
    }
  }

  async _stop(rec) {
    if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
    rec.running = false;
    try { if (rec.agent.stop) await rec.agent.stop(); } catch { /* noop */ }
  }

  async _runTick(rec) {
    const { agent } = rec;
    try {
      await agent.tick();
      rec.lastHeartbeat = Date.now();
      rec.lastError = null;
      rec.errorStreak = 0;
      bus.publish(EVENTS.AGENT_HEALTH, { name: agent.name, ok: true });
    } catch (e) {
      rec.lastError = e.message;
      rec.errorStreak++;
      logger.error(`Agente ${agent.name}: tick fallito (streak ${rec.errorStreak})`, e.message);
      bus.publish(EVENTS.AGENT_HEALTH, { name: agent.name, ok: false, error: e.message });
      // Allerta throttlata (max 1 ogni 10 min per agente)
      const now = Date.now();
      if (now - rec.lastAlertTs > 10 * 60 * 1000) {
        rec.lastAlertTs = now;
        notifier.notify(`⚠️ <b>Agente ${agent.name}</b> in errore: ${e.message}`);
      }
    }
  }

  status() {
    return [...this.agents.values()].map(r => ({
      name: r.agent.name,
      running: r.running,
      lastHeartbeat: r.lastHeartbeat,
      lastError: r.lastError,
      errorStreak: r.errorStreak,
      ...(r.agent.status ? r.agent.status() : {})
    }));
  }
}

export default new AgentRuntime();
