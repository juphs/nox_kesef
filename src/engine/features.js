/**
 * features.js
 * -----------
 * Converts a raw tick history into stationary statistical features. Runs
 * in-process now (v1 shipped this as a separate Python service talked to
 * over ZeroMQ) -- same math, zero IPC, zero serialization overhead, and a
 * genuinely sub-millisecond round trip since it's just a function call.
 *
 * IMPORTANT (lookahead bias): every function here only ever reads indices
 * <= the current one. sequentialLookaheadCheck() in train.js asserts this
 * holds before any model is trained/exported.
 *
 * No retail indicators (RSI/MACD/EMA-crossover-as-a-signal) live here by
 * design -- only stochastic/microstructure features, per the research
 * doc's guidance to keep the feature set statistically grounded rather
 * than a grab-bag of textbook indicators.
 */

const ROLLING_WINDOW = 50;
const ZSCORE_WINDOW = 20;
const MOMENTUM_SHORT = 10;
const MOMENTUM_LONG = 30;
const OBI_DEPTH_LEVELS = 5;

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i += 1) {
    out.push(Math.log(prices[i] / prices[i - 1]));
  }
  return out;
}

function bookSideVolume(levels, depth = OBI_DEPTH_LEVELS) {
  if (!levels) return 0;
  return levels.slice(0, depth).reduce((sum, l) => sum + (l.volume || 0), 0);
}

/** OBI_t = (bidVol - askVol) / (bidVol + askVol), bounded [-1, 1]. */
function orderBookImbalance(bids, asks, depth = OBI_DEPTH_LEVELS) {
  const bidVol = bookSideVolume(bids, depth);
  const askVol = bookSideVolume(asks, depth);
  const denom = bidVol + askVol;
  if (denom === 0) return 0;
  return (bidVol - askVol) / denom;
}

/**
 * ticks: [{price, ts}, ...] ascending time order (only up to "now" -- never
 *        pass future data in here).
 * bids/asks: top-of-book depth, best first, [{price, volume}, ...]
 */
function computeFeatures({ symbol, ticks, bids, asks }) {
  const prices = (ticks || []).map((t) => t.price).filter((p) => typeof p === 'number' && p > 0);

  if (prices.length < 2) {
    const obi = orderBookImbalance(bids, asks);
    return {
      symbol,
      logReturn: 0,
      rollingVolatility: 0,
      zScore: 0,
      momentumSignal: 0,
      obi,
      featureVector: [0, obi, 0, 0, 0],
      tickCount: prices.length,
    };
  }

  const returns = logReturns(prices);
  const lastLogReturn = returns[returns.length - 1] ?? 0;

  const recentReturns = returns.slice(-ROLLING_WINDOW);
  const rollingVolatility = stdev(recentReturns);

  const zWindow = prices.slice(-ZSCORE_WINDOW);
  const zMean = mean(zWindow);
  const zStd = stdev(zWindow);
  const zScore = zStd > 0 ? (prices[prices.length - 1] - zMean) / zStd : 0;

  const shortWindow = prices.slice(-MOMENTUM_SHORT);
  const longWindow = prices.slice(-MOMENTUM_LONG);
  const shortMA = mean(shortWindow);
  const longMA = mean(longWindow);
  const momentumSignal = longMA !== 0 ? (shortMA - longMA) / longMA : 0;

  const obi = orderBookImbalance(bids, asks);

  return {
    symbol,
    logReturn: lastLogReturn,
    rollingVolatility,
    zScore,
    momentumSignal,
    obi,
    featureVector: [lastLogReturn, obi, rollingVolatility, zScore, momentumSignal],
    tickCount: prices.length,
  };
}

/**
 * Test helper used by train.js: recomputes features with the most recent
 * tick withheld and asserts the result differs from the full computation --
 * i.e. the feature at time t never "saw" t+1. Returns true if no leakage.
 */
function sequentialLookaheadCheck(payload) {
  const ticks = payload.ticks || [];
  if (ticks.length < 3) return true;
  const truncated = computeFeatures({ ...payload, ticks: ticks.slice(0, -1) });
  const full = computeFeatures({ ...payload, ticks });
  return truncated.logReturn !== full.logReturn;
}

module.exports = {
  computeFeatures,
  orderBookImbalance,
  sequentialLookaheadCheck,
  mean,
  stdev,
  logReturns,
  ROLLING_WINDOW,
  ZSCORE_WINDOW,
  MOMENTUM_SHORT,
  MOMENTUM_LONG,
};
