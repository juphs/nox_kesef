// controllers/tradingSettings.js
// Runtime-mutable settings changeable from the dashboard without a
// restart: which pairs are actively traded, and which risk profile is
// active.

const EventEmitter = require('events');
const config = require('../config/systemConfig');

const ALL_KNOWN_PAIRS = Object.keys(config.derivSymbolMap);

const state = new EventEmitter();
state.confirmedAvailablePairs = [...ALL_KNOWN_PAIRS];
state.selectedPairs = [...config.feed.pairs];

function getAllKnownPairs() {
  return [...ALL_KNOWN_PAIRS];
}

function getAvailablePairs() {
  return [...state.confirmedAvailablePairs];
}

function setAvailablePairs(pairs) {
  const valid = pairs.filter((p) => ALL_KNOWN_PAIRS.includes(p));
  if (valid.length > 0) state.confirmedAvailablePairs = valid;
  const before = state.selectedPairs;
  state.selectedPairs = state.selectedPairs.filter((p) => state.confirmedAvailablePairs.includes(p));
  if (state.selectedPairs.length === 0) state.selectedPairs = [state.confirmedAvailablePairs[0]];
  state.emit('availableChanged', getAvailablePairs());
  if (before.join() !== state.selectedPairs.join()) state.emit('selectedChanged', getSelectedPairs());
}

function getSelectedPairs() {
  return [...state.selectedPairs];
}

function setSelectedPairs(pairs) {
  const valid = [...new Set(pairs)].filter((p) => state.confirmedAvailablePairs.includes(p));
  if (valid.length === 0) throw new Error('At least one valid, available pair must be selected');
  state.selectedPairs = valid;
  state.emit('selectedChanged', getSelectedPairs());
  return getSelectedPairs();
}

function onSelectedChanged(fn) {
  state.on('selectedChanged', fn);
}

function onAvailableChanged(fn) {
  state.on('availableChanged', fn);
}

module.exports = {
  getAllKnownPairs, getAvailablePairs, setAvailablePairs,
  getSelectedPairs, setSelectedPairs, onSelectedChanged, onAvailableChanged,
};
