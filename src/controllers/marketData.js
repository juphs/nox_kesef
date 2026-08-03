// controllers/marketData.js
// Emits standardized tick payloads {symbol, ticks, bids, asks} for
// whichever pairs are currently selected. Two feed modes:
//   mock  -- synthetic random-walk generator, zero external deps
//   deriv -- REAL ticks from your Deriv account via deriv/derivClient.js
//
// Known, documented limitation of the 'deriv' feed: Deriv's retail forex
// API does not expose Level 2 order-book depth -- OBI is therefore
// approximated from recent tick-direction momentum rather than true
// resting-order volume. See README.md.

const EventEmitter = require('events');
const config = require('../config/systemConfig');
const tradingSettings = require('./tradingSettings');

const TICK_MOMENTUM_WINDOW = 20;

const MOCK_BASE_PRICES = {
  EURUSD: 1.082, GBPUSD: 1.265, USDJPY: 156.2, USDCHF: 0.881, AUDUSD: 0.651, USDCAD: 1.369, NZDUSD: 0.598,
  EURJPY: 169.0, GBPJPY: 197.6, AUDJPY: 101.7, CADJPY: 114.1, CHFJPY: 177.3, NZDJPY: 93.4,
  EURGBP: 0.855, EURAUD: 1.662, EURCAD: 1.481, EURCHF: 0.953, EURNZD: 1.809,
  GBPAUD: 1.943, GBPCAD: 1.732, GBPCHF: 1.114, GBPNZD: 2.115,
  AUDCAD: 0.891, AUDCHF: 0.573, AUDNZD: 1.088, CADCHF: 0.643, NZDCAD: 0.819, NZDCHF: 0.527,
};

class MockGenerator {
  constructor() {
    this.prices = { ...MOCK_BASE_PRICES };
    this.history = {};
  }

  _gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  nextTick(symbol) {
    if (!(symbol in this.prices)) this.prices[symbol] = 1.0;
    if (!this.history[symbol]) this.history[symbol] = [];

    const price = this.prices[symbol];
    // Tuned so a typical volatility-scaled stop/target (see
    // executionEngine.js) resolves within a few minutes of demo time
    // rather than the ~15-20 minutes a more timid drift would imply --
    // this only affects the mock generator; real Deriv ticks carry their
    // own real volatility.
    const drift = this._gauss() * price * 0.00018;
    const next = Math.max(0.0001, price + drift);
    this.prices[symbol] = next;

    this.history[symbol].push({ price: next, ts: Date.now() / 1000 });
    this.history[symbol] = this.history[symbol].slice(-200);

    const spread = next * 0.00008;
    const bids = Array.from({ length: 5 }, (_, i) => ({ price: Number((next - spread * (i + 1)).toFixed(5)), volume: Number((0.5 + Math.random() * 4.5).toFixed(3)) }));
    const asks = Array.from({ length: 5 }, (_, i) => ({ price: Number((next + spread * (i + 1)).toFixed(5)), volume: Number((0.5 + Math.random() * 4.5).toFixed(3)) }));

    return { symbol, ticks: this.history[symbol], bids, asks };
  }
}

function derivTickToPayload(symbol, history) {
  const recent = history.slice(-TICK_MOMENTUM_WINDOW);
  let ups = 0, downs = 0;
  for (let i = 1; i < recent.length; i += 1) {
    if (recent[i].price > recent[i - 1].price) ups += 1;
    else if (recent[i].price < recent[i - 1].price) downs += 1;
  }
  const total = ups + downs || 1;
  const bidVolume = (ups / total) * 5;
  const askVolume = (downs / total) * 5;
  const last = history[history.length - 1];

  return {
    symbol,
    ticks: history,
    bids: [{ price: last.bid, volume: Number(bidVolume.toFixed(3)) }],
    asks: [{ price: last.ask, volume: Number(askVolume.toFixed(3)) }],
  };
}

class MarketDataFeed extends EventEmitter {
  constructor(derivClient) {
    super();
    this.mode = config.feed.mode;
    this.derivClient = derivClient;
    this.generator = new MockGenerator();
    this._timer = null;
    this._derivHistory = {};
    this._derivSubscribed = new Set();
    this._running = false;
  }

  isRunning() {
    return this._running;
  }

  start() {
    if (this._running) return;
    this._running = true;

    if (this.mode === 'deriv') {
      if (!config.deriv.apiToken) {
        console.warn('[marketData] FEED_MODE=deriv but DERIV_API_TOKEN is not set -- falling back to the mock generator.');
        this._startMock();
        return;
      }
      this._startDeriv();
      return;
    }
    this._startMock();
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this.mode === 'deriv') this.derivClient.disconnect();
  }

  _startMock() {
    let pairIndex = 0;
    this._timer = setInterval(() => {
      const pairs = tradingSettings.getSelectedPairs();
      if (pairs.length === 0) return;
      const symbol = pairs[pairIndex % pairs.length];
      pairIndex += 1;
      this.emit('tick', this.generator.nextTick(symbol));
    }, config.feed.tickIntervalMs);
    console.log(`[marketData] mock feed started (pairs=${tradingSettings.getSelectedPairs().join(', ')})`);
  }

  _subscribeToSelectedPairs() {
    const selected = tradingSettings.getSelectedPairs();
    const newOnes = selected.filter((p) => !this._derivSubscribed.has(p));
    if (newOnes.length === 0) return;
    const derivSymbols = newOnes.map((p) => config.derivSymbolMap[p]).filter(Boolean);
    this.derivClient.subscribeTicks(derivSymbols);
    newOnes.forEach((p) => this._derivSubscribed.add(p));
    console.log(`[marketData] subscribed to live Deriv ticks: ${derivSymbols.join(', ')}`);
  }

  async _validateAvailablePairsAgainstDeriv() {
    try {
      const symbols = await this.derivClient.getActiveSymbols();
      const forexSymbols = new Set(symbols.filter((s) => s.market === 'forex').map((s) => s.symbol));
      const confirmedPairs = Object.keys(config.derivSymbolMap).filter((pair) => forexSymbols.has(config.derivSymbolMap[pair]));
      if (confirmedPairs.length > 0) {
        tradingSettings.setAvailablePairs(confirmedPairs);
        console.log(`[marketData] Deriv confirmed ${confirmedPairs.length} tradable forex pairs for this account`);
      }
    } catch (err) {
      console.warn('[marketData] could not validate pairs against Deriv active_symbols, using static list:', err.message);
    }
  }

  _startDeriv() {
    const symbolToPair = Object.fromEntries(Object.entries(config.derivSymbolMap).map(([pair, frx]) => [frx, pair]));

    this.derivClient.removeAllListeners('tick');
    this.derivClient.on('tick', (tick) => {
      const pair = symbolToPair[tick.symbol];
      if (!pair) return;
      if (!tradingSettings.getSelectedPairs().includes(pair)) return;

      if (!this._derivHistory[pair]) this._derivHistory[pair] = [];
      const history = this._derivHistory[pair];
      history.push({ price: tick.quote ?? tick.bid, bid: tick.bid, ask: tick.ask, ts: tick.epoch || Date.now() / 1000 });
      this._derivHistory[pair] = history.slice(-200);

      this.emit('tick', derivTickToPayload(pair, this._derivHistory[pair]));
    });

    this.derivClient.once('authorized', async () => {
      await this._validateAvailablePairsAgainstDeriv();
      this._subscribeToSelectedPairs();
    });

    tradingSettings.onSelectedChanged(() => {
      if (this.derivClient.authorized) this._subscribeToSelectedPairs();
    });

    this.derivClient.connect();
  }
}

module.exports = MarketDataFeed;
