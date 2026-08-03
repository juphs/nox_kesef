// server.js
// Single entry point. `npm start` runs this and ONLY this -- no Python,
// no separate engine process, no manual orchestration. The dashboard
// comes up immediately; the bot itself stays idle (no feed, no Deriv
// connection, no trading) until you press Start.

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config/systemConfig');
const indexRoutes = require('./routes/indexRoutes');
const dashboardState = require('./controllers/dashboardState');
const tradingSettings = require('./controllers/tradingSettings');
const aiReasoning = require('./ai/aiReasoning');
const broadcastHub = require('./services/broadcastHub');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use('/', indexRoutes);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(message) {
  const payload = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(payload);
  });
}
broadcastHub.setBroadcast(broadcast);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', state: dashboardState.snapshot() }));
});

tradingSettings.onAvailableChanged(() => {
  broadcastHub.broadcastState(dashboardState.applyPairsChange());
});

// Refresh the "MARKET OPEN/CLOSED" indicator and push it out periodically
// even when the bot isn't running -- it's a fact about the world, not
// about the bot's state.
setInterval(() => broadcastHub.broadcastState(dashboardState.snapshot()), 60000);

server.listen(config.port, async () => {
  console.log(`\n  NOX KESEF v2 -- dashboard running at http://localhost:${config.port}`);
  console.log(`  Execution mode: ${config.execution.mode.toUpperCase()} -- press Start on the dashboard to begin.\n`);

  // AI model discovery happens once at boot, independent of the bot's
  // start/stop state, so the AI Health panel is informative even before
  // you press Start.
  const aiInit = await aiReasoning.init({ nvidiaApiKey: config.nvidia.apiKey, timeoutMs: config.nvidia.callTimeoutMs });
  console.log(
    aiInit.discovered
      ? `  NVIDIA catalog: ${aiInit.poolSize} usable models discovered live`
      : '  NVIDIA catalog: using the static fallback model list (no key set, or discovery failed)'
  );
});

process.on('SIGINT', () => {
  console.log('\n[server] shutting down...');
  process.exit(0);
});
