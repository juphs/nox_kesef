// controllers/dashboardState.js
// Single in-memory source of truth for the dashboard. One page, everything
// on it: bot run state, balance, open contracts, trade history, a
// narrated reasoning feed (why each tick was traded or passed on), AI
// model health, and trading configuration.

const config = require('../config/systemConfig');
const riskEngine = require('./riskEngine');
const tradingSettings = require('./tradingSettings');
const { isForexMarketOpen } = require('../engine/marketHours');
const { FUNCTION_DEFINITIONS } = require('../ai/modelCatalog');
const journal = require('../services/journal');

const state = {
  bot: { running: false },
  connection: {
    executionMode: config.execution.mode.toUpperCase(), // DERIV | PAPER
    derivAuthorized: false,
    derivLoginId: null,
    derivIsVirtual: null,
  },
  orderFlow: {},
  contracts: {},
  logs: [], // the "reasoning feed"
  aiStatus: Object.fromEntries(
    FUNCTION_DEFINITIONS.map((fn) => [fn.id, { label: fn.label, active_model: null, tier: null, state: 'IDLE', last_updated: null }])
  ),
};

const MAX_LOGS = 60;
const MAX_CONTRACTS = 30;

function pushLog(line, level = 'info') {
  state.logs.unshift({ line, level, ts: new Date().toISOString() });
  state.logs = state.logs.slice(0, MAX_LOGS);
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function contractKey(contract) {
  return contract?.contractId || contract?.contract_id || null;
}

function reasoningLine(result) {
  const sm = result.subModels || {};
  const smText = `logistic ${pct(sm.logistic ?? 0.5)}, mean-rev ${pct(sm.meanReversion ?? 0.5)}, momentum ${pct(sm.momentum ?? 0.5)}`;

  if (result.status === 'REJECTED' && result.reason === 'EV below approval threshold') {
    return `[${result.symbol}] WAIT -- p_win=${pct(result.pWin)} (${smText}); EV ${result.ev >= 0 ? '+' : ''}${result.ev.toFixed(4)} below threshold`;
  }
  if (result.status === 'REJECTED') {
    return `[${result.symbol}] WAIT -- ${result.reason}`;
  }
  if (result.status === 'DISPATCHED' && result.contract) {
    const c = result.contract;
    return `[${result.symbol}] ${c.direction} $${c.stake} x${c.multiplier} -- p_win=${pct(result.pWin)}, target $${c.takeProfitValue}, stop $${c.stopLossValue}`;
  }
  if (result.status === 'DISPATCHED') {
    return `[${result.symbol}] DISPATCHED $${result.size} -- p_win=${pct(result.pWin)} (${smText})`;
  }
  return `[${result.symbol}] ${result.status}: ${result.error || ''}`;
}

function applyExecutionResult(result) {
  state.orderFlow[result.symbol] = {
    symbol: result.symbol,
    pWin: result.pWin ?? null,
    ev: result.ev ?? null,
    status: result.status,
    size: result.size ?? 0,
    subModels: result.subModels ?? null,
    timestamp: result.timestamp,
  };

  if (result.aiStatus) {
    for (const [functionId, status] of Object.entries(result.aiStatus)) {
      if (state.aiStatus[functionId]) {
        state.aiStatus[functionId] = { label: status.label || state.aiStatus[functionId].label, ...status };
      }
    }
  }

  if (result.status === 'DISPATCHED' && result.contract) {
    const c = result.contract;
    const id = contractKey(c);
    if (id) {
      state.contracts[id] = {
        contractId: id,
        contract_id: id,
        symbol: result.symbol,
        direction: c.direction,
        stake: c.stake,
        multiplier: c.multiplier,
        stopLossValue: c.stopLossValue,
        takeProfitValue: c.takeProfitValue,
        confidence: c.confidence,
        status: 'OPEN',
        pnl: null,
        reason: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
      };
      _trimContracts();
    }
  }

  // Paper-mode contracts close INSIDE executionEngine.processTick (a
  // future tick's price crossing the stop/target), not via a separate
  // async event like Deriv's contract_closed -- so those closures arrive
  // bundled in this same result and need the same table update applied
  // here rather than through applyContractClosed().
  (result.closedContracts || []).forEach((c) => {
    const existing = state.contracts[c.contractId];
    if (existing) {
      existing.status = c.pnl >= 0 ? 'WON' : 'LOST';
      existing.pnl = c.pnl;
      existing.reason = c.reason;
      existing.closedAt = new Date().toISOString();
    }
  });
  _trimContracts();

  pushLog(reasoningLine(result), result.status === 'DISPATCHED' ? 'trade' : 'info');
  (result.closedContracts || []).forEach((c) => {
    pushLog(`[${c.symbol}] CLOSED #${c.contractId} -- ${c.pnl >= 0 ? '+' : ''}${c.pnl.toFixed(2)} (${c.pnl >= 0 ? 'WON' : 'LOST'}) -- ${c.reason}`, 'trade');
  });

  return snapshot();
}

function applyDerivAuthorized(account) {
  state.connection.derivAuthorized = true;
  state.connection.derivLoginId = account.loginid;
  state.connection.derivIsVirtual = account.isVirtual;
  pushLog(`Deriv authorized: ${account.loginid} (${account.isVirtual ? 'DEMO' : 'REAL MONEY'}), balance ${account.balance} ${account.currency}`);
  return snapshot();
}

function applyDerivDisconnected() {
  state.connection.derivAuthorized = false;
  pushLog('Deriv connection lost -- attempting to reconnect...');
  return snapshot();
}

function applyContractUpdate(contract) {
  const id = contractKey(contract);
  const existing = id ? state.contracts[id] : null;
  if (!existing) return null;
  existing.pnl = Number(contract.profit ?? existing.pnl ?? 0);
  return snapshot();
}

function applyContractClosed(contract) {
  const id = contractKey(contract);
  const existing = id ? state.contracts[id] : null;
  const pnl = Number(contract.profit ?? 0);
  const reason = pnl >= 0 ? 'Closed by Deriv (target/expiry)' : 'Closed by Deriv (stop-out)';
  if (existing) {
    existing.status = pnl >= 0 ? 'WON' : 'LOST';
    existing.pnl = pnl;
    existing.reason = reason;
    existing.closedAt = new Date().toISOString();
  }
  pushLog(
    `[${existing?.symbol || contract.symbol || '?'}] CLOSED #${id || contract.contract_id || '?'} -- ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnl >= 0 ? 'WON' : 'LOST'}) -- ${reason}`,
    'trade'
  );
  return snapshot();
}

function applyKillSwitchChange() {
  const s = riskEngine.snapshot();
  pushLog(s.killSwitchEngaged ? `Kill switch ENGAGED: ${s.killSwitchReason}` : 'Kill switch RESET -- trading resumed', 'warn');
  return snapshot();
}

function applyRiskProfileChange() {
  const p = riskEngine.getProfileSummary();
  pushLog(`Risk profile set to ${p.label} (Kelly x${p.effective.kellyFraction}, max position ${p.effective.maxPositionPctOfBalance}%, max drawdown ${p.effective.maxDailyDrawdownPct}%, leverage x${p.effective.leverage})`);
  return snapshot();
}

function applyPairsChange() {
  pushLog(`Trading pairs updated: ${tradingSettings.getSelectedPairs().join(', ')}`);
  return snapshot();
}

function applyBotRunning(running) {
  state.bot.running = running;
  pushLog(running ? 'Bot started -- scanning selected pairs.' : 'Bot stopped -- no new entries will be opened.', 'warn');
  return snapshot();
}

function _trimContracts() {
  // OPEN contracts are NEVER trimmed -- with the max-concurrent-positions
  // cap in riskEngine.js, these can no longer grow unbounded anyway, and
  // silently hiding a real open position from the dashboard would be
  // actively dangerous (the user needs to see their real exposure).
  // Only closed history is capped, for display tidiness.
  const closedIds = Object.keys(state.contracts).filter((id) => state.contracts[id].status !== 'OPEN');
  if (closedIds.length <= MAX_CONTRACTS) return;
  closedIds
    .sort((a, b) => (state.contracts[a].closedAt < state.contracts[b].closedAt ? -1 : 1))
    .slice(0, closedIds.length - MAX_CONTRACTS)
    .forEach((id) => delete state.contracts[id]);
}

function snapshot() {
  return {
    bot: state.bot,
    connection: state.connection,
    marketOpen: isForexMarketOpen(),
    risk: riskEngine.snapshot(),
    orderFlow: Object.values(state.orderFlow),
    contracts: Object.values(state.contracts).sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1)),
    logs: state.logs,
    aiStatus: state.aiStatus,
    journal: journal.getStats(),
    pairs: {
      all: tradingSettings.getAllKnownPairs(),
      available: tradingSettings.getAvailablePairs(),
      selected: tradingSettings.getSelectedPairs(),
    },
  };
}

module.exports = {
  applyExecutionResult, applyDerivAuthorized, applyDerivDisconnected,
  applyContractUpdate, applyContractClosed, applyKillSwitchChange,
  applyRiskProfileChange, applyPairsChange, applyBotRunning,
  snapshot, pushLog,
};
