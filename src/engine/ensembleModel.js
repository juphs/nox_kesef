/**
 * ensembleModel.js
 * ----------------
 * A small, fully-interpretable ensemble (per the research doc's advice to
 * combine several weak, auditable signals rather than lean on one opaque
 * model): three independent sub-models blended into one win-probability
 * estimate. No deep learning, no RL, no exotic math -- deliberately
 * right-sized, not overkill.
 *
 *   1. Logistic regression over the full feature vector (the one
 *      component that's actually trained -- see train.js / modelStore.js)
 *   2. Mean-reversion: a sigmoid transform of the z-score. Price stretched
 *      far above its recent mean -> lean toward reversion down, and
 *      vice versa.
 *   3. Momentum: a sigmoid transform of the short/long moving-average
 *      spread. Short MA above long MA -> lean toward continuation up.
 *
 * The three are averaged (weights configurable). Each is independently
 * inspectable in the AI/model debug payload so a bad component doesn't
 * hide inside a black box.
 */

const { loadModel } = require('./modelStore');

function sigmoid(x) {
  // Clamp to avoid Math.exp overflow on extreme inputs.
  const clamped = Math.max(-60, Math.min(60, x));
  return 1 / (1 + Math.exp(-clamped));
}

function dot(weights, x) {
  return weights.reduce((sum, w, i) => sum + w * (x[i] ?? 0), 0);
}

/**
 * Raw features have wildly different scales (log returns ~0.0001, z-scores
 * ~1-3), which would make gradient descent converge unevenly across
 * dimensions. Both training and inference standardize each feature to
 * zero mean / unit variance using stats captured AT TRAINING TIME (stored
 * alongside the weights) -- inference never recomputes its own stats,
 * which would silently drift from what the model was actually trained on.
 */
function computeNormalization(featureMatrix) {
  const dim = featureMatrix[0].length;
  const means = new Array(dim).fill(0);
  const stds = new Array(dim).fill(1);

  for (let j = 0; j < dim; j += 1) {
    const col = featureMatrix.map((row) => row[j]);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    const variance = col.reduce((sum, x) => sum + (x - m) ** 2, 0) / Math.max(1, col.length - 1);
    means[j] = m;
    stds[j] = Math.sqrt(variance) || 1;
  }
  return { means, stds };
}

function normalizeVector(featureVector, means, stds) {
  return featureVector.map((x, i) => (stds[i] > 1e-12 ? (x - means[i]) / stds[i] : 0));
}

function logisticProbability(featureVector, model) {
  const normalized = model.featureMeans && model.featureStds
    ? normalizeVector(featureVector, model.featureMeans, model.featureStds)
    : featureVector;
  return sigmoid(dot(model.weights, normalized) + model.bias);
}

/**
 * Batch gradient descent with L2 regularization -- deliberately simple and
 * auditable (per the research doc's "avoid overkill" guidance) rather than
 * reaching for a heavier ML library for what is, at this data scale, a
 * small convex optimization problem with a well-understood closed-form
 * gradient.
 */
function trainLogisticRegression(featureMatrix, labels, { epochs = 800, learningRate = 0.15, l2 = 0.001 } = {}) {
  const { means, stds } = computeNormalization(featureMatrix);
  const X = featureMatrix.map((row) => normalizeVector(row, means, stds));
  const n = X.length;
  const dim = X[0].length;

  let weights = new Array(dim).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradW = new Array(dim).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i += 1) {
      const pred = sigmoid(dot(weights, X[i]) + bias);
      const error = pred - labels[i];
      for (let j = 0; j < dim; j += 1) gradW[j] += error * X[i][j];
      gradB += error;
    }

    for (let j = 0; j < dim; j += 1) weights[j] -= learningRate * (gradW[j] / n + l2 * weights[j]);
    bias -= learningRate * (gradB / n);
  }

  return { weights, bias, featureMeans: means, featureStds: stds };
}

// Scaling constants translate a raw statistic into a "reasonable sigmoid
// input" range -- tuned to be conservative (modest, not extreme
// probability swings) rather than to chase historical fit.
const MEAN_REVERSION_SCALE = 0.6;
const MOMENTUM_SCALE = 18;

function meanReversionProbability(zScore) {
  // High positive zScore (price stretched above mean) -> expect reversion
  // DOWN -> lower P(up). Hence the negative sign.
  return sigmoid(-zScore * MEAN_REVERSION_SCALE);
}

function momentumProbability(momentumSignal) {
  // Short MA above long MA -> lean toward continuation up.
  return sigmoid(momentumSignal * MOMENTUM_SCALE);
}

const DEFAULT_ENSEMBLE_WEIGHTS = { logistic: 1, meanReversion: 1, momentum: 1 };

/**
 * Combines the three sub-models into a final p_win + an Expected Value
 * estimate, and returns each sub-model's opinion for transparency.
 */
function evaluate(features, { rewardTarget = 1.5, riskTarget = 1.0, ensembleWeights = DEFAULT_ENSEMBLE_WEIGHTS } = {}) {
  const model = loadModel();

  const pLogistic = logisticProbability(features.featureVector, model);
  const pMeanReversion = meanReversionProbability(features.zScore);
  const pMomentum = momentumProbability(features.momentumSignal);

  const totalWeight = ensembleWeights.logistic + ensembleWeights.meanReversion + ensembleWeights.momentum;
  const pWin =
    (pLogistic * ensembleWeights.logistic +
      pMeanReversion * ensembleWeights.meanReversion +
      pMomentum * ensembleWeights.momentum) /
    totalWeight;

  const pLoss = 1 - pWin;
  const ev = pWin * rewardTarget - pLoss * riskTarget;

  return {
    pWin: Number(pWin.toFixed(4)),
    ev: Number(ev.toFixed(4)),
    evApproved: ev > 0.05,
    demoMode: model.demoMode,
    subModels: {
      logistic: Number(pLogistic.toFixed(4)),
      meanReversion: Number(pMeanReversion.toFixed(4)),
      momentum: Number(pMomentum.toFixed(4)),
    },
    modelMeta: {
      trainedAt: model.trainedAt,
      walkForwardAccuracy: model.walkForwardAccuracy,
    },
  };
}

module.exports = {
  evaluate,
  sigmoid,
  dot,
  logisticProbability,
  meanReversionProbability,
  momentumProbability,
  trainLogisticRegression,
  computeNormalization,
  normalizeVector,
  DEFAULT_ENSEMBLE_WEIGHTS,
};
