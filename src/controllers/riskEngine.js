// controllers/riskEngine.js
// Hard guardrails between "the model likes this trade" and "an order goes
// out". Checks, in order: kill switch -> circuit breaker -> Quarter-Kelly
// sizing (scaled by the active risk profile) -> statistical position/
// leverage caps that no profile can exceed. All money math goes through
// bignumber.js -- never raw floats.

const BigNumber = require('bignumber.js');
const config = require('../config/systemConfig');

const RISK_PROFILES = {
  conservative: { label: 'Conservative', kelly: 0.5, position: 0.4, drawdown: 0.6, leverage: 0.5 },
  balanced: { label: 'Balanced', kelly: 1.0, position: 1.0, drawdown: 1.0, leverage: 1.0 },
  aggressive: { label: 'Aggressive', kelly: 1.6, position: 1.8, drawdown: 1.75, leverage: 1.5 },
};

const ABSOLUTE_MAX_POSITION_PCT = 0.15;
const ABSOLUTE_MAX_DRAWDOWN_PCT = 6;
const ABSOLUTE_MAX_LEVERAGE = 100;
const MAX_BALANCE_HISTORY_POINTS = 400;

class RiskEngine {
  constructor() {
    this.balance = new BigNumber(config.risk.startingBalance);
    this.peakBalance = new BigNumber(config.risk.startingBalance);
    this.dayStartBalance = new BigNumber(config.risk.startingBalance);
    this.dayStartedAt = Date.now();
    this.tradeLog = [];
    this.liveBalanceSynced = false;
    this.killSwitchEngaged = false;
    this.killSwitchReason = null;
    this.activeProfile = 'balanced';
    this.balanceHistory = [{ ts: new Date().toISOString(), balance: this.balance.toNumber() }];
    this.openPositionCount = 0;
  }

  incrementOpenPositions() {
    this.openPositionCount += 1;
  }

  decrementOpenPositions() {
    this.openPositionCount = Math.max(0, this.openPositionCount - 1);
  }

  setRiskProfile(name) {
    if (!RISK_PROFILES[name]) throw new Error(`Unknown risk profile: ${name}`);
    this.activeProfile = name;
    console.log(`[riskEngine] risk profile set to ${name}`);
    return this.getProfileSummary();
  }

  _activeMultipliers() {
    return RISK_PROFILES[this.activeProfile];
  }

  _activeParams() {
    const m = this._activeMultipliers();
    return {
      kellyFraction: config.risk.kellyFraction * m.kelly,
      maxPositionPctOfBalance: Math.min(config.risk.maxPositionPctOfBalance * m.position, ABSOLUTE_MAX_POSITION_PCT),
      maxDailyDrawdownPct: Math.min(config.risk.maxDailyDrawdownPct * m.drawdown, ABSOLUTE_MAX_DRAWDOWN_PCT),
      leverage: Math.min(Math.round(config.deriv.multiplier * m.leverage), Math.min(config.risk.maxLeverage, ABSOLUTE_MAX_LEVERAGE)),
    };
  }

  getActiveDerivMultiplier() {
    return this._activeParams().leverage;
  }

  getProfileSummary() {
    const params = this._activeParams();
    return {
      active: this.activeProfile,
      label: RISK_PROFILES[this.activeProfile].label,
      available: Object.entries(RISK_PROFILES).map(([id, p]) => ({ id, label: p.label })),
      effective: {
        kellyFraction: Number(params.kellyFraction.toFixed(4)),
        maxPositionPctOfBalance: Number((params.maxPositionPctOfBalance * 100).toFixed(2)),
        maxDailyDrawdownPct: Number(params.maxDailyDrawdownPct.toFixed(2)),
        leverage: params.leverage,
      },
    };
  }

  _recordBalancePoint() {
    this.balanceHistory.push({ ts: new Date().toISOString(), balance: this.balance.toNumber() });
    if (this.balanceHistory.length > MAX_BALANCE_HISTORY_POINTS) {
      this.balanceHistory = this.balanceHistory.slice(-MAX_BALANCE_HISTORY_POINTS);
    }
  }

  syncLiveBalance(amount) {
    const newBalance = new BigNumber(amount);
    if (!this.liveBalanceSynced) {
      this.dayStartBalance = newBalance;
      this.peakBalance = newBalance;
      this.liveBalanceSynced = true;
      this.balanceHistory = [{ ts: new Date().toISOString(), balance: newBalance.toNumber() }];
    } else {
      this.peakBalance = BigNumber.maximum(this.peakBalance, newBalance);
    }
    this.balance = newBalance;
    this._recordBalancePoint();
    this._checkCircuitBreakerImmediately();
  }

  _rollDailyWindowIfNeeded() {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - this.dayStartedAt > ONE_DAY_MS) {
      this.dayStartBalance = this.balance;
      this.dayStartedAt = Date.now();
    }
  }

  currentDrawdownPct() {
    this._rollDailyWindowIfNeeded();
    if (this.dayStartBalance.isZero()) return new BigNumber(0);
    const drawdown = this.dayStartBalance.minus(this.balance).dividedBy(this.dayStartBalance).times(100);
    return BigNumber.maximum(drawdown, 0);
  }

  circuitBreakerTripped() {
    return this.currentDrawdownPct().isGreaterThanOrEqualTo(this._activeParams().maxDailyDrawdownPct);
  }

  _checkCircuitBreakerImmediately() {
    if (!this.killSwitchEngaged && this.circuitBreakerTripped()) {
      this.engageKillSwitch(`24h drawdown ${this.currentDrawdownPct().toFixed(2)}% >= ${this._activeParams().maxDailyDrawdownPct.toFixed(2)}% limit`);
    }
  }

  engageKillSwitch(reason) {
    this.killSwitchEngaged = true;
    this.killSwitchReason = reason;
    console.warn(`[riskEngine] KILL SWITCH ENGAGED: ${reason}`);
  }

  resetKillSwitch() {
    this.killSwitchEngaged = false;
    this.killSwitchReason = null;
    this.dayStartBalance = this.balance;
    this.dayStartedAt = Date.now();
    console.log('[riskEngine] kill switch reset -- trading resumed');
  }

  computeQuarterKellySize({ pWin, rewardTarget = config.rewardTarget, riskTarget = config.riskTarget }) {
    const params = this._activeParams();
    const p = new BigNumber(pWin);
    const pLoss = new BigNumber(1).minus(p);

    const fStar = p.dividedBy(riskTarget).minus(pLoss.dividedBy(rewardTarget));
    const clampedF = BigNumber.maximum(fStar, 0);
    const scaledF = clampedF.times(params.kellyFraction);

    let positionSize = this.balance.times(scaledF);
    const hardCap = this.balance.times(params.maxPositionPctOfBalance);
    const cappedByStatisticalLimit = positionSize.isGreaterThan(hardCap);
    if (cappedByStatisticalLimit) positionSize = hardCap;

    return {
      fStar: fStar.toNumber(),
      quarterKellyFraction: scaledF.toNumber(),
      positionSize: positionSize.toNumber(),
      cappedByStatisticalLimit,
    };
  }

  evaluate({ symbol, pWin, ev }) {
    this._rollDailyWindowIfNeeded();

    if (this.killSwitchEngaged) {
      return { approved: false, reason: `Kill switch engaged: ${this.killSwitchReason}`, size: 0 };
    }
    if (this.circuitBreakerTripped()) {
      this._checkCircuitBreakerImmediately();
      return { approved: false, reason: `Circuit breaker tripped: ${this.killSwitchReason}`, size: 0 };
    }

    if (this.openPositionCount >= config.risk.maxConcurrentPositions) {
      return { approved: false, reason: `Max concurrent positions reached (${this.openPositionCount}/${config.risk.maxConcurrentPositions})`, size: 0 };
    }

    const sizing = this.computeQuarterKellySize({ pWin });
    let size = sizing.positionSize;

    if (size < config.risk.minStake) {
      return { approved: false, reason: `Position size ${size.toFixed(2)} below minimum stake ${config.risk.minStake}`, size: 0 };
    }

    const params = this._activeParams();
    const reasonSuffix = sizing.cappedByStatisticalLimit
      ? ` (capped at ${(params.maxPositionPctOfBalance * 100).toFixed(1)}% of balance, ${this.activeProfile} profile)`
      : ` (${this.activeProfile} profile)`;

    return {
      approved: true,
      reason: `Approved: EV=${ev.toFixed(4)}, Quarter-Kelly f*=${sizing.quarterKellyFraction.toFixed(4)}${reasonSuffix}`,
      size: Number(size.toFixed(2)),
      fStar: sizing.fStar,
    };
  }

  recordFill({ symbol, size, pnl, live = false, reason = null }) {
    if (!live) {
      this.balance = this.balance.plus(pnl);
      this.peakBalance = BigNumber.maximum(this.peakBalance, this.balance);
    }
    this.tradeLog.unshift({
      symbol, size,
      pnl: Number(new BigNumber(pnl).toFixed(2)),
      balance: Number(this.balance.toFixed(2)),
      reason: reason || (pnl >= 0 ? 'Closed in profit' : 'Closed at a loss'),
      timestamp: new Date().toISOString(),
    });
    this.tradeLog = this.tradeLog.slice(0, 50);
    this.decrementOpenPositions();

    this._recordBalancePoint();
    this._checkCircuitBreakerImmediately();
  }

  snapshot() {
    return {
      balance: Number(this.balance.toFixed(2)),
      balanceHistory: this.balanceHistory,
      liveBalanceSynced: this.liveBalanceSynced,
      drawdownPct: Number(this.currentDrawdownPct().toFixed(2)),
      maxDrawdownPct: Number(this._activeParams().maxDailyDrawdownPct.toFixed(2)),
      circuitBreakerTripped: this.circuitBreakerTripped(),
      killSwitchEngaged: this.killSwitchEngaged,
      killSwitchReason: this.killSwitchReason,
      recentTrades: this.tradeLog,
      riskProfile: this.getProfileSummary(),
      realizedPnl: Number(this.balance.minus(config.risk.startingBalance).toFixed(2)),
      openPositionCount: this.openPositionCount,
      maxConcurrentPositions: config.risk.maxConcurrentPositions,
    };
  }
}

module.exports = new RiskEngine();
