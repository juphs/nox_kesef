/**
 * derivClient.js
 * --------------
 * A real client for Deriv's public WebSocket API
 * (wss://ws.derivws.com/websockets/v3). Authorizes with your API token,
 * streams real bid/ask tick data, syncs your real account balance, and
 * places/monitors real Multiplier contracts.
 *
 * Reference: https://developers.deriv.com/docs/intro/api-overview/
 *
 * Message correlation: Deriv multiplexes everything over one socket.
 * Request/response calls (proposal, buy, sell, active_symbols) are
 * correlated via a `req_id` attached to every request and a Map of
 * pending promises keyed by that id. Streams (tick, balance,
 * proposal_open_contract) are not request/response -- they just keep
 * arriving, surfaced as EventEmitter events instead.
 */

const EventEmitter = require('events');
const WebSocket = require('ws');

const PING_INTERVAL_MS = 20000;
const RECONNECT_BASE_DELAY_MS = 1500;
const RECONNECT_MAX_DELAY_MS = 20000;
const REQUEST_TIMEOUT_MS = 15000;

class ModelUnavailable extends Error {}

class DerivClient extends EventEmitter {
  constructor({ appId, apiToken }) {
    super();
    this.appId = appId;
    this.apiToken = apiToken;
    this.ws = null;
    this.reqCounter = 1;
    this.pending = new Map();
    this.subscribedSymbols = new Set();
    this.account = null;
    this.authorized = false;
    this._pingTimer = null;
    this._reconnectAttempt = 0;
    this._closedByUser = false;
    this._started = false;
  }

  connect() {
    if (!this.apiToken) {
      this.emit('error', new Error('DERIV_API_TOKEN is not set -- cannot connect.'));
      return;
    }
    this._started = true;
    this._closedByUser = false;
    const url = `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this._reconnectAttempt = 0;
      console.log('[derivClient] WebSocket connected');
      this._authorize().catch((err) => this.emit('error', err));
      this._startPing();
    });

    this.ws.on('message', (raw) => this._handleMessage(raw));

    this.ws.on('close', () => {
      this.authorized = false;
      this._stopPing();
      this.emit('disconnected');
      if (!this._closedByUser && this._started) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => this.emit('error', err));
  }

  disconnect() {
    this._closedByUser = true;
    this._started = false;
    this._stopPing();
    if (this.ws) this.ws.close();
  }

  _scheduleReconnect() {
    this._reconnectAttempt += 1;
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * this._reconnectAttempt, RECONNECT_MAX_DELAY_MS);
    console.warn(`[derivClient] disconnected -- reconnecting in ${delay}ms`);
    setTimeout(() => {
      if (this._started) this.connect();
    }, delay);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ping: 1 }));
    }, PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  _nextReqId() {
    this.reqCounter += 1;
    return this.reqCounter;
  }

  _send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  _call(payload) {
    return new Promise((resolve, reject) => {
      const reqId = this._nextReqId();
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new ModelUnavailable(`Deriv request timed out: ${JSON.stringify(payload)}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(reqId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  async _authorize() {
    const response = await this._call({ authorize: this.apiToken });
    const auth = response.authorize;
    this.account = {
      loginid: auth.loginid,
      balance: parseFloat(auth.balance),
      currency: auth.currency,
      isVirtual: !!auth.is_virtual,
      scopes: auth.scopes || [],
    };
    this.authorized = true;
    console.log(
      `[derivClient] authorized as ${this.account.loginid} (${this.account.isVirtual ? 'DEMO' : 'REAL MONEY'}) ` +
      `balance=${this.account.balance} ${this.account.currency}`
    );
    this.emit('authorized', this.account);

    this._send({ balance: 1, subscribe: 1 });
    for (const symbol of this.subscribedSymbols) this._send({ ticks: symbol, subscribe: 1 });
  }

  subscribeTicks(symbols) {
    symbols.forEach((s) => this.subscribedSymbols.add(s));
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      symbols.forEach((symbol) => this._send({ ticks: symbol, subscribe: 1 }));
    }
  }

  subscribeContract(contractId) {
    this._send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
  }

  getProposal({ symbol, contractType, stake, multiplier, takeProfit, stopLoss, currency }) {
    return this._call({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency,
      symbol,
      multiplier,
      limit_order: { take_profit: takeProfit, stop_loss: stopLoss },
    }).then((res) => res.proposal);
  }

  buyContract(proposalId, price) {
    return this._call({ buy: proposalId, price }).then((res) => res.buy);
  }

  sellContract(contractId, price = 0) {
    return this._call({ sell: contractId, price }).then((res) => res.sell);
  }

  getActiveSymbols() {
    return this._call({ active_symbols: 'brief', product_type: 'basic' }).then((res) => res.active_symbols || []);
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.error('[derivClient] failed to parse message', err);
      return;
    }

    if (msg.req_id && this.pending.has(msg.req_id)) {
      const { resolve, reject, timer } = this.pending.get(msg.req_id);
      clearTimeout(timer);
      this.pending.delete(msg.req_id);
      if (msg.error) reject(new ModelUnavailable(`${msg.error.code}: ${msg.error.message}`));
      else resolve(msg);
      return;
    }

    if (msg.error) {
      this.emit('error', new Error(`${msg.error.code}: ${msg.error.message}`));
      return;
    }

    switch (msg.msg_type) {
      case 'tick': {
        const t = msg.tick;
        this.emit('tick', { symbol: t.symbol, bid: t.bid ?? t.quote, ask: t.ask ?? t.quote, quote: t.quote, epoch: t.epoch });
        break;
      }
      case 'balance': {
        const b = msg.balance;
        if (this.account) this.account.balance = parseFloat(b.balance);
        this.emit('balance', { balance: parseFloat(b.balance), currency: b.currency });
        break;
      }
      case 'proposal_open_contract': {
        const c = msg.proposal_open_contract;
        if (!c || !c.contract_id) break;
        this.emit('contract_update', c);
        if (c.is_sold) this.emit('contract_closed', c);
        break;
      }
      default:
        break;
    }
  }
}

module.exports = { DerivClient, ModelUnavailable };
