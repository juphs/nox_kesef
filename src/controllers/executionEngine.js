// controllers/executionEngine.js
// Runs each tick through: feature extraction -> ensemble EV model -> (if a
// genuine candidate) the NVIDIA AI matrix -> risk engine -> real Deriv
// order or a realistic simulated paper contract. Everything in-process
// now -- v1 did this same pipeline over a ZeroMQ hop to a separate Python
// service; here it's just function calls, both simpler to run and
// genuinely faster.

const config = require('../config/systemConfig');
const { computeFeatures } = require('../engine/features');
const ensembleModel = require('../engine/ensembleModel');
const aiReasoning = require('../ai/aiReasoning');
const newsFeed = require('../services/newsFeed');
const riskEngine = require('./riskEngine');
const paperBroker = require('./paperBroker');
const journal = require('../services/journal');

// A flat multiple of stake for the take-profit/stop-loss dollar values
// (e.g. "target = 1.5x stake") looks reasonable in isolation, but combined
// with leverage it implies a specific required PRICE move -- and for
// typical Multiplier leverage (10-30x) that flat-stake approach implies
// unrealistically large moves (multiple percent on a forex pair) that
// would rarely if ever occur, meaning contracts would almost never
// actually reach their target/stop. Instead, the stop distance is scaled
// to the pair's OWN recently-measured volatility (rollingVolatility, the
// std of per-tick log returns) -- a standard volatility-based stop
// sizing approach -- and the reward:risk ratio is applied to that
// distance, not to the stake directly. The dollar take-profit/stop-loss
// values sent to Deriv (or used by the paper broker) are then whatever
// falls out of that realistic price move at the given stake and leverage.
const MIN_STOP_MOVE_PCT = 0.0008; // 8 basis points floor -- never absurdly tight
const MAX_STOP_MOVE_PCT = 0.006; // 60 basis points ceiling -- never absurdly wide
const VOLATILITY_STOP_MULTIPLIER = 12; // ~12x the recent one-tick volatility

function computeStopTakeProfitValues({ stake, multiplier, rollingVolatility, rewardTarget, riskTarget }) {
  const rawStopMovePct = (rollingVolatility || 0) * VOLATILITY_STOP_MULTIPLIER;
  const stopMovePct = Math.min(Math.max(rawStopMovePct, MIN_STOP_MOVE_PCT), MAX_STOP_MOVE_PCT);
  const targetMovePct = stopMovePct * (rewardTarget / riskTarget);
  const notional = stake * multiplier;

  return {
    stopLossValue: Number((notional * stopMovePct).toFixed(2)),
    takeProfitValue: Number((notional * targetMovePct).toFixed(2)),
  };
}

async function placeDerivTrade(derivClient, { symbol, pWin, size, rollingVolatility }) {
  if (!derivClient || !derivClient.authorized || !derivClient.account) {
    return { placed: false, reason: 'Deriv client is not authorized yet (still connecting?)' };
  }
  if (!derivClient.account.isVirtual && !config.deriv.allowRealMoneyTrading) {
    return {
      placed: false,
      reason: 'Refusing to trade: this Deriv token belongs to a REAL-MONEY account and ALLOW_REAL_MONEY_TRADING is not true.',
    };
  }

  const derivSymbol = config.derivSymbolMap[symbol];
  if (!derivSymbol) return { placed: false, reason: `No Deriv symbol mapping for ${symbol}` };

  const direction = pWin >= 0.5 ? 'MULTUP' : 'MULTDOWN';
  const stake = Math.max(config.risk.minStake, Number(size.toFixed(2)));
  const multiplier = riskEngine.getActiveDerivMultiplier();
  const { stopLossValue, takeProfitValue } = computeStopTakeProfitValues({
    stake, multiplier, rollingVolatility, rewardTarget: config.rewardTarget, riskTarget: config.riskTarget,
  });

  try {
    const proposal = await derivClient.getProposal({
      symbol: derivSymbol, contractType: direction, stake, multiplier,
      takeProfit: takeProfitValue, stopLoss: stopLossValue,
      currency: derivClient.account.currency,
    });
    const bought = await derivClient.buyContract(proposal.id, proposal.ask_price);
    derivClient.subscribeContract(bought.contract_id);

    return {
      placed: true,
      contractId: bought.contract_id,
      buyPrice: bought.buy_price,
      direction,
      stake,
      multiplier,
      stopLossValue,
      takeProfitValue,
      confidence: pWin,
    };
  } catch (err) {
    return { placed: false, reason: `Deriv API error: ${err.message}` };
  }
}

function currentPriceFromTicks(tickPayload) {
  const ticks = tickPayload.ticks || [];
  return ticks.length > 0 ? ticks[ticks.length - 1].price : null;
}

async function processTick(tickPayload, { derivClient } = {}) {
  const features = computeFeatures(tickPayload);
  const evResult = ensembleModel.evaluate(features, { rewardTarget: config.rewardTarget, riskTarget: config.riskTarget });

  // In paper mode, check every existing open paper contract on this symbol
  // against the fresh price BEFORE deciding on a new trade -- a contract
  // opened three ticks ago might hit its target or stop right now, whether
  // or not this tick also produces a fresh signal.
  let closedContracts = [];
  const price = currentPriceFromTicks(tickPayload);
  if (config.execution.mode === 'paper' && price) {
    closedContracts = paperBroker.checkContracts(tickPayload.symbol, price);
    closedContracts.forEach((c) => {
      riskEngine.recordFill({ symbol: c.symbol, size: null, pnl: c.pnl, live: false, reason: c.reason });
      journal.logContractClosed({ symbol: c.symbol, contractId: c.contractId, pnl: c.pnl, reason: c.reason });
    });
  }

  const record = {
    symbol: tickPayload.symbol,
    pWin: evResult.pWin,
    ev: evResult.ev,
    evApproved: evResult.evApproved,
    demoMode: evResult.demoMode,
    subModels: evResult.subModels,
    features,
    closedContracts,
    timestamp: new Date().toISOString(),
  };

  // Every decision -- WAIT or trade -- is journaled permanently to
  // data/trade-journal.jsonl. train.js later joins DISPATCHED decisions to
  // their eventual contract_closed outcome to build labeled training
  // examples from the bot's own real history.
  function finish(result) {
    journal.logDecision({
      symbol: result.symbol,
      featureVector: features.featureVector,
      pWin: result.pWin,
      ev: result.ev,
      subModels: result.subModels,
      status: result.status,
      reason: result.reason,
      contractId: result.contract?.contractId,
      executionMode: config.execution.mode,
    });
    return result;
  }

  if (!evResult.evApproved) {
    return finish({ ...record, status: 'REJECTED', reason: 'EV below approval threshold', size: 0 });
  }

  // Genuine candidate -- worth the slower AI reasoning pass and a news check.
  const [aiMatrix, newsContext] = await Promise.all([
    config.nvidia.runMatrixOnlyForCandidates ? aiReasoning.runAllAiFunctions({ symbol: tickPayload.symbol, features, evResult }) : Promise.resolve(null),
    newsFeed.newsContextForSymbol(tickPayload.symbol).catch(() => null),
  ]);
  record.aiMatrix = aiMatrix;
  record.aiStatus = aiReasoning.getStatusMatrix();
  record.newsContext = newsContext;

  const riskVerdict = riskEngine.evaluate({ symbol: tickPayload.symbol, pWin: evResult.pWin, ev: evResult.ev });
  if (!riskVerdict.approved) {
    return finish({ ...record, status: 'REJECTED', reason: riskVerdict.reason, size: 0 });
  }

  if (config.execution.mode === 'deriv') {
    const placement = await placeDerivTrade(derivClient, {
      symbol: tickPayload.symbol, pWin: evResult.pWin, size: riskVerdict.size, rollingVolatility: features.rollingVolatility,
    });
    if (!placement.placed) {
      return finish({ ...record, status: 'REJECTED', reason: placement.reason, size: 0 });
    }
    riskEngine.incrementOpenPositions();
    return finish({ ...record, status: 'DISPATCHED', reason: riskVerdict.reason, size: placement.stake, contract: placement });
  }

  // Paper mode: open a real simulated contract with genuine, volatility-scaled
  // stop/target price levels -- it will show as OPEN until a future tick's
  // price actually crosses one of those levels (see paperBroker.js).
  if (!price) {
    return finish({ ...record, status: 'REJECTED', reason: 'No price available to open a paper contract', size: 0 });
  }

  const direction = evResult.pWin >= 0.5 ? 'MULTUP' : 'MULTDOWN';
  const multiplier = riskEngine.getActiveDerivMultiplier();
  const stake = Math.max(config.risk.minStake, Number(riskVerdict.size.toFixed(2)));
  const { stopLossValue, takeProfitValue } = computeStopTakeProfitValues({
    stake, multiplier, rollingVolatility: features.rollingVolatility, rewardTarget: config.rewardTarget, riskTarget: config.riskTarget,
  });

  const paperContract = paperBroker.openContract({
    symbol: tickPayload.symbol, direction, stake, multiplier,
    entryPrice: price, stopLossValue, takeProfitValue, confidence: evResult.pWin,
  });
  riskEngine.incrementOpenPositions();

  return finish({
    ...record,
    status: 'DISPATCHED',
    reason: riskVerdict.reason,
    size: stake,
    contract: {
      contractId: paperContract.contractId, direction, stake, multiplier,
      stopLossValue, takeProfitValue, confidence: evResult.pWin,
    },
  });
}

module.exports = { processTick };
