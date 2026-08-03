// controllers/botController.js
// Owns the bot's run lifecycle. npm start boots the dashboard/server ONLY
// -- no feed, no Deriv connection, no trading -- until you press Start.
// A fresh DerivClient + MarketDataFeed are created on every Start and torn
// down on every Stop, so there's never a stale listener or a lingering
// socket left over from a previous run.

const config = require('../config/systemConfig');
const { DerivClient } = require('../deriv/derivClient');
const MarketDataFeed = require('./marketData');
const executionEngine = require('./executionEngine');
const riskEngine = require('./riskEngine');
const dashboardState = require('./dashboardState');
const broadcastHub = require('../services/broadcastHub');
const journal = require('../services/journal');

let derivClient = null;
let marketData = null;
let running = false;

function _broadcast(snapshot) {
  broadcastHub.broadcastState(snapshot);
}

function _wireDerivEvents(client) {
  client.on('authorized', (account) => {
    riskEngine.syncLiveBalance(account.balance);
    _broadcast(dashboardState.applyDerivAuthorized(account));
  });

  client.on('disconnected', () => {
    _broadcast(dashboardState.applyDerivDisconnected());
  });

  client.on('balance', ({ balance }) => {
    riskEngine.syncLiveBalance(balance);
    _broadcast(dashboardState.snapshot());
  });

  client.on('contract_update', (contract) => {
    _broadcast(dashboardState.applyContractUpdate(contract));
  });

  client.on('contract_closed', (contract) => {
    const pnl = Number(contract.profit || 0);
    const reason = pnl >= 0 ? 'Closed by Deriv (target/expiry)' : 'Closed by Deriv (stop-out)';
    riskEngine.recordFill({
      symbol: contract.underlying || contract.symbol,
      size: contract.buy_price,
      pnl,
      live: true,
      reason,
    });
    journal.logContractClosed({ symbol: contract.underlying || contract.symbol, contractId: contract.contract_id, pnl, reason });
    _broadcast(dashboardState.applyContractClosed(contract));
  });

  client.on('error', (err) => {
    console.error('[botController] Deriv error:', err.message);
    dashboardState.pushLog(`Deriv error: ${err.message}`, 'error');
    _broadcast(dashboardState.snapshot());
  });
}

function isRunning() {
  return running;
}

function start() {
  if (running) return dashboardState.snapshot();

  if (config.execution.mode === 'deriv') {
    derivClient = new DerivClient({ appId: config.deriv.appId, apiToken: config.deriv.apiToken });
    _wireDerivEvents(derivClient);
  }

  marketData = new MarketDataFeed(derivClient);
  marketData.on('tick', async (tickPayload) => {
    try {
      const result = await executionEngine.processTick(tickPayload, { derivClient });
      const snapshot = dashboardState.applyExecutionResult(result);
      _broadcast(snapshot);
    } catch (err) {
      console.error('[botController] tick pipeline error:', err);
      dashboardState.pushLog(`Tick pipeline error: ${err.message}`, 'error');
      _broadcast(dashboardState.snapshot());
    }
  });

  marketData.start();
  running = true;
  return dashboardState.applyBotRunning(true);
}

function stop() {
  if (!running) return dashboardState.snapshot();

  if (marketData) marketData.stop();
  marketData = null;
  derivClient = null;
  running = false;

  return dashboardState.applyBotRunning(false);
}

module.exports = { start, stop, isRunning };
