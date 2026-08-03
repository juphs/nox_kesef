// services/broadcastHub.js
// Shared pub point so modules without a direct WebSocketServer reference
// (routes, contractMonitor, botController) can push a live update to
// every connected dashboard.

let broadcastFn = null;

function setBroadcast(fn) {
  broadcastFn = fn;
}

function broadcast(message) {
  if (broadcastFn) broadcastFn(message);
}

function broadcastState(snapshot) {
  if (snapshot) broadcast({ type: 'update', state: snapshot });
}

module.exports = { setBroadcast, broadcast, broadcastState };
