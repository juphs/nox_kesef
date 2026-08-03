// config/systemConfig.js
// Central place for env vars. v2 is a single process -- no ZMQ, no
// separate engine to point at, just this.
require('dotenv').config();

const feedMode = process.env.FEED_MODE || 'mock'; // 'mock' | 'deriv'
const derivApiToken = process.env.DERIV_API_TOKEN || '';

const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  feed: {
    mode: feedMode,
    tickIntervalMs: parseInt(process.env.TICK_INTERVAL_MS || '1200', 10),
    pairs: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD'],
  },

  // Deriv's forex symbol naming convention ("frx" prefix). This is Deriv's
  // standard forex lineup -- majors, yen crosses, and EUR/GBP/AUD/NZD
  // crosses. In FEED_MODE=deriv this is cross-checked against Deriv's own
  // `active_symbols` response at connect time and narrowed to whatever
  // your account can actually trade.
  derivSymbolMap: {
    EURUSD: 'frxEURUSD', GBPUSD: 'frxGBPUSD', USDJPY: 'frxUSDJPY', USDCHF: 'frxUSDCHF',
    AUDUSD: 'frxAUDUSD', USDCAD: 'frxUSDCAD', NZDUSD: 'frxNZDUSD',
    EURJPY: 'frxEURJPY', GBPJPY: 'frxGBPJPY', AUDJPY: 'frxAUDJPY', CADJPY: 'frxCADJPY',
    CHFJPY: 'frxCHFJPY', NZDJPY: 'frxNZDJPY',
    EURGBP: 'frxEURGBP', EURAUD: 'frxEURAUD', EURCAD: 'frxEURCAD', EURCHF: 'frxEURCHF', EURNZD: 'frxEURNZD',
    GBPAUD: 'frxGBPAUD', GBPCAD: 'frxGBPCAD', GBPCHF: 'frxGBPCHF', GBPNZD: 'frxGBPNZD',
    AUDCAD: 'frxAUDCAD', AUDCHF: 'frxAUDCHF', AUDNZD: 'frxAUDNZD',
    CADCHF: 'frxCADCHF', NZDCAD: 'frxNZDCAD', NZDCHF: 'frxNZDCHF',
  },

  deriv: {
    appId: process.env.DERIV_APP_ID || '1089',
    apiToken: derivApiToken,
    multiplier: parseInt(process.env.DERIV_MULTIPLIER || '20', 10),
    allowRealMoneyTrading: (process.env.ALLOW_REAL_MONEY_TRADING || 'false').toLowerCase() === 'true',
  },

  execution: {
    mode: feedMode === 'deriv' && derivApiToken ? 'deriv' : 'paper',
  },

  nvidia: {
    apiKey: process.env.NVIDIA_API_KEY || '',
    callTimeoutMs: parseInt(process.env.LLM_CALL_TIMEOUT_MS || '6000', 10),
    // Only genuine trade candidates (EV already cleared the approval bar)
    // get the full 10-function LLM pass -- these calls are slow (hundreds
    // of ms to seconds each) and rate-limited on the free tier, so running
    // them on every tick of market noise would be wasteful and would wreck
    // the sub-millisecond statistical fast path.
    runMatrixOnlyForCandidates: true,
  },

  risk: {
    maxDailyDrawdownPct: parseFloat(process.env.MAX_DAILY_DRAWDOWN_PCT || '2.0'),
    kellyFraction: parseFloat(process.env.KELLY_FRACTION || '0.25'),
    startingBalance: parseFloat(process.env.STARTING_BALANCE || '10000'),
    maxPositionPctOfBalance: parseFloat(process.env.MAX_POSITION_PCT_OF_BALANCE || '5') / 100,
    maxLeverage: parseInt(process.env.MAX_LEVERAGE || '30', 10),
    minStake: parseFloat(process.env.MIN_STAKE || '1'),
    // Portfolio-level cap, independent of per-trade sizing: no matter how
    // good any individual signal looks, only this many positions can be
    // open across all pairs at once. Without this, a bot that dispatches
    // faster than positions resolve can quietly accumulate unbounded
    // concurrent exposure -- exactly the "no diversification limit"
    // failure mode the research doc calls out.
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '8', 10),
  },

  rewardTarget: 1.5,
  riskTarget: 1.0,
};

if (config.deriv.multiplier > config.risk.maxLeverage) {
  console.warn(
    `[systemConfig] DERIV_MULTIPLIER (${config.deriv.multiplier}) exceeds MAX_LEVERAGE ` +
    `(${config.risk.maxLeverage}) -- clamping to MAX_LEVERAGE.`
  );
  config.deriv.multiplier = config.risk.maxLeverage;
}

module.exports = config;
