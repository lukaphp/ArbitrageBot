/**
 * EVENT BUS (sistema agentico)
 * ============================
 *
 * Bus di eventi in-process che disaccoppia gli agenti: ognuno pubblica e si
 * sottoscrive a eventi tipizzati senza conoscere gli altri.
 *
 * Tipi di evento (convenzione `dominio.fatto`):
 *   market.tick · signal.proposed · proposal.created
 *   action.requested · action.approved · action.rejected
 *   order.filled · order.error · agent.health · alert
 *
 * Singleton: un solo bus per processo.
 */

import { EventEmitter } from 'events';
import logger from '../utils/logger.js';

export const EVENTS = {
  MARKET_TICK: 'market.tick',
  SIGNAL_PROPOSED: 'signal.proposed',
  PROPOSAL_CREATED: 'proposal.created',
  ACTION_REQUESTED: 'action.requested',
  ACTION_APPROVED: 'action.approved',
  ACTION_REJECTED: 'action.rejected',
  ORDER_FILLED: 'order.filled',
  ORDER_ERROR: 'order.error',
  AGENT_HEALTH: 'agent.health',
  ALERT: 'alert'
};

class AgentBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  publish(type, payload = {}) {
    logger.debug(`🚌 bus ${type}`, payload?.id ? { id: payload.id } : {});
    this.emit(type, payload);
  }

  /** Sottoscrizione; ritorna una funzione di unsubscribe. */
  on(type, handler) {
    super.on(type, handler);
    return () => super.off(type, handler);
  }
}

export default new AgentBus();
