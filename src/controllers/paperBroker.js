// controllers/paperBroker.js
// A real (simulated) broker for paper mode: opens a contract with genuine
// stop/target PRICE levels (derived the same way a Deriv Multiplier
// contract's P&L works), and only closes it when a subsequent tick's
// price actually crosses one of those levels -- not an instant random
// number. This makes paper mode behave like a faithful stand-in for the
// real Deriv execution path (contracts open, sit, and close later) rather
// than a fire-and-forget coin flip, and means the Open Contracts / Trade
// History tables are meaningfully populated even before you ever connect
// a Deriv account.

const MAX_HOLD_MS = 15 * 60 * 1000; // force-close a contract after 15 simulated minutes either way

let contractCounter = 0;
const openContracts = new Map(); // contractId -> contract record

/**
 * Multiplier P&L: pnl = stake * multiplier * (priceChange / entryPrice) * direction_sign
 * Solving for the price at which pnl hits +takeProfitValue / -stopLossValue
 * gives the exact target/stop price levels.
 */
function priceLevelsFor({ entryPrice, direction, stake, multiplier, takeProfitValue, stopLossValue }) {
  const unitMove = entryPrice / (stake * multiplier); // price change per $1 of P&L
  if (direction === 'MULTUP') {
    return {
      targetPrice: entryPrice + takeProfitValue * unitMove,
      stopPrice: entryPrice - stopLossValue * unitMove,
    };
  }
  return {
    targetPrice: entryPrice - takeProfitValue * unitMove,
    stopPrice: entryPrice + stopLossValue * unitMove,
  };
}

function pnlAtPrice({ entryPrice, direction, stake, multiplier, currentPrice }) {
  const pctMove = (currentPrice - entryPrice) / entryPrice;
  const signedMove = direction === 'MULTUP' ? pctMove : -pctMove;
  return stake * multiplier * signedMove;
}

function openContract({ symbol, direction, stake, multiplier, entryPrice, stopLossValue, takeProfitValue, confidence }) {
  contractCounter += 1;
  const contractId = `paper-${Date.now()}-${contractCounter}`;
  const { targetPrice, stopPrice } = priceLevelsFor({ entryPrice, direction, stake, multiplier, takeProfitValue, stopLossValue });

  const contract = {
    contractId, symbol, direction, stake, multiplier,
    entryPrice, targetPrice, stopPrice,
    stopLossValue, takeProfitValue, confidence,
    openedAt: Date.now(),
  };
  openContracts.set(contractId, contract);
  return contract;
}

/**
 * Called on every tick for a symbol. Checks all open paper contracts on
 * that symbol against the new price and closes any that have hit their
 * target, stop, or max hold time. Returns the list of newly-closed
 * contracts (each with a final `pnl` and `reason`).
 */
function checkContracts(symbol, currentPrice) {
  const closed = [];
  for (const contract of openContracts.values()) {
    if (contract.symbol !== symbol) continue;

    const hitTarget = contract.direction === 'MULTUP' ? currentPrice >= contract.targetPrice : currentPrice <= contract.targetPrice;
    const hitStop = contract.direction === 'MULTUP' ? currentPrice <= contract.stopPrice : currentPrice >= contract.stopPrice;
    const expired = Date.now() - contract.openedAt > MAX_HOLD_MS;

    if (hitTarget || hitStop || expired) {
      const closePrice = hitTarget ? contract.targetPrice : hitStop ? contract.stopPrice : currentPrice;
      const pnl = pnlAtPrice({ entryPrice: contract.entryPrice, direction: contract.direction, stake: contract.stake, multiplier: contract.multiplier, currentPrice: closePrice });
      const reason = hitTarget ? 'Closed (paper -- hit target)' : hitStop ? 'Closed (paper -- hit stop)' : 'Closed (paper -- max hold time)';

      openContracts.delete(contract.contractId);
      closed.push({ contractId: contract.contractId, symbol, pnl: Number(pnl.toFixed(2)), reason });
    }
  }
  return closed;
}

function getOpenContracts() {
  return [...openContracts.values()];
}

module.exports = { openContract, checkContracts, getOpenContracts };
