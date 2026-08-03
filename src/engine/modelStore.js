/**
 * modelStore.js
 * -------------
 * Persists/loads the logistic-regression component's trained weights as
 * plain JSON (no pickle, no joblib, no binary model format -- just an
 * array of floats, fully human-inspectable).
 *
 * Out of the box (before you ever run `npm run train`), the weights are
 * all zero. sigmoid(0*x + 0) = 0.5 exactly -- meaning the trained
 * component honestly contributes NO directional opinion until it's
 * actually been fit to real data. This is deliberate: a set of
 * plausible-looking but untrained "default" weights would be
 * indistinguishable from a real trained model in the UI, which is exactly
 * the kind of unearned confidence the research doc warns retail systems
 * fall into. The mean-reversion and momentum sub-models (see
 * ensembleModel.js) are simple enough to be honestly meaningful without
 * training, so the ensemble as a whole isn't a coin flip even before you
 * train it -- just its ML component is inert until you do.
 */

const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'ensemble-weights.json');

const DEFAULT_MODEL = {
  weights: [0, 0, 0, 0, 0], // [logReturn, obi, rollingVolatility, zScore, momentumSignal]
  bias: 0,
  featureMeans: null,
  featureStds: null,
  demoMode: true,
  trainedAt: null,
  walkForwardAccuracy: null,
  trainingExampleCount: null,
};

function loadModel() {
  try {
    if (fs.existsSync(MODEL_PATH)) {
      const raw = fs.readFileSync(MODEL_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.weights) && parsed.weights.length === 5) {
        return { ...DEFAULT_MODEL, ...parsed, demoMode: false };
      }
    }
  } catch (err) {
    console.warn('[modelStore] failed to load trained weights, using demo defaults:', err.message);
  }
  return { ...DEFAULT_MODEL };
}

function saveModel({ weights, bias, featureMeans, featureStds, walkForwardAccuracy, trainingExampleCount }) {
  const payload = {
    weights,
    bias,
    featureMeans,
    featureStds,
    demoMode: false,
    trainedAt: new Date().toISOString(),
    walkForwardAccuracy,
    trainingExampleCount,
  };
  fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
  fs.writeFileSync(MODEL_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

module.exports = { loadModel, saveModel, MODEL_PATH };
