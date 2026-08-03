// routes/indexRoutes.js
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const router = express.Router();
const dashboardState = require('../controllers/dashboardState');
const riskEngine = require('../controllers/riskEngine');
const tradingSettings = require('../controllers/tradingSettings');
const botController = require('../controllers/botController');
const aiReasoning = require('../ai/aiReasoning');
const broadcastHub = require('../services/broadcastHub');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

router.get('/', (req, res) => {
  res.render('dashboard', { state: dashboardState.snapshot() });
});

router.get('/api/state', (req, res) => {
  res.json(dashboardState.snapshot());
});

// --- Bot lifecycle -----------------------------------------------------
router.post('/api/bot/start', (req, res) => {
  const snapshot = botController.start();
  broadcastHub.broadcastState(snapshot);
  res.json(snapshot);
});

router.post('/api/bot/stop', (req, res) => {
  const snapshot = botController.stop();
  broadcastHub.broadcastState(snapshot);
  res.json(snapshot);
});

// --- Kill switch ---------------------------------------------------------
router.post('/api/kill-switch/engage', (req, res) => {
  riskEngine.engageKillSwitch('Manually engaged from dashboard');
  const snapshot = dashboardState.applyKillSwitchChange();
  broadcastHub.broadcastState(snapshot);
  res.json(snapshot);
});

router.post('/api/kill-switch/reset', (req, res) => {
  riskEngine.resetKillSwitch();
  const snapshot = dashboardState.applyKillSwitchChange();
  broadcastHub.broadcastState(snapshot);
  res.json(snapshot);
});

// --- Risk profile --------------------------------------------------------
router.post('/api/risk-profile', (req, res) => {
  try {
    riskEngine.setRiskProfile(req.body.profile);
    const snapshot = dashboardState.applyRiskProfileChange();
    broadcastHub.broadcastState(snapshot);
    res.json(snapshot);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Trading pairs ---------------------------------------------------------
router.post('/api/pairs', (req, res) => {
  try {
    tradingSettings.setSelectedPairs(req.body.pairs || []);
    const snapshot = dashboardState.applyPairsChange();
    broadcastHub.broadcastState(snapshot);
    res.json(snapshot);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- AI model catalog ------------------------------------------------------
router.post('/api/ai/refresh', async (req, res) => {
  try {
    const result = await aiReasoning.refreshModels();
    dashboardState.pushLog(`AI model catalog refreshed -- ${result.discovered ? `${result.poolSize} models discovered live` : 'using static fallback list'}`);
    const snapshot = dashboardState.snapshot();
    broadcastHub.broadcastState(snapshot);
    res.json({ ...result, state: snapshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Model training --------------------------------------------------------
// Spawns `node train.js` (the same script `npm run train` runs) as a child
// process so you can retrain from the browser without touching a
// terminal. The trained model is read fresh from disk on every single
// evaluate() call (see ensembleModel.js), so a successful retrain takes
// effect on the very next tick -- no restart needed.
router.post('/api/train', (req, res) => {
  execFile('node', ['train.js'], { cwd: PROJECT_ROOT, timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({ success: false, output: `${stdout}\n${stderr}` });
    }
    dashboardState.pushLog('Model retrained from the dashboard -- takes effect on the next tick.');
    const snapshot = dashboardState.snapshot();
    broadcastHub.broadcastState(snapshot);
    res.json({ success: true, output: stdout, state: snapshot });
  });
});

module.exports = router;
