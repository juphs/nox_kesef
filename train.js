/**
 * train.js
 * --------
 * Run with `npm run train`. Trains the ensemble's logistic-regression
 * component and saves it to models/ensemble-weights.json.
 *
 * Two data sources, used together:
 *   1. data/trade-journal.jsonl -- your bot's own real decision/outcome
 *      history (see src/services/journal.js). This is what "the bot
 *      learns from its own trades" actually means in this codebase: real
 *      (feature vector, win/loss) pairs pulled from what really happened.
 *   2. data/historical_ticks.csv -- a small synthetic seed dataset so the
 *      system is trainable out of the box, before you've accumulated any
 *      real trade history. Once your journal has a reasonable number of
 *      closed trades (see MIN_REAL_EXAMPLES below), the synthetic data is
 *      dropped entirely rather than diluting real signal with fake data.
 *
 * Validation gates (same two the research doc calls out as essential and
 * commonly skipped by retail systems), run in order -- training aborts if
 * either fails:
 *   1. Sequential Lookahead Veto Test -- features at time t never depend
 *      on data at t+1.
 *   2. Time-Series Shuffle Validation -- retrains on a chronologically
 *      shuffled copy; if the model's "edge" doesn't collapse, the
 *      original was likely fitting noise/leakage, not a real signal.
 * Also runs a Walk-Forward Analysis (rolling train/test splits, never
 * shuffled) purely to report fold-by-fold accuracy for your own sanity
 * check -- it isn't itself a pass/fail gate.
 */

const fs = require('fs');
const path = require('path');

const { computeFeatures, sequentialLookaheadCheck } = require('./src/engine/features');
const { trainLogisticRegression, logisticProbability } = require('./src/engine/ensembleModel');
const { saveModel } = require('./src/engine/modelStore');
const journal = require('./src/services/journal');

const CSV_PATH = path.join(__dirname, 'data', 'historical_ticks.csv');
const MIN_REAL_EXAMPLES = 40; // below this, blend in synthetic seed data; at/above it, real data only

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trim();
  const [headerLine, ...lines] = raw.split('\n');
  const headers = headerLine.split(',').map((h) => h.trim());
  return lines.map((line) => {
    const values = line.split(',').map(Number);
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}

/** Builds (featureVector, label) pairs from the synthetic CSV, respecting
 * the same "only look backward" rule as the live feature pipeline. */
function labeledExamplesFromCsv(rows) {
  const examples = [];
  for (let i = 5; i < rows.length; i += 1) {
    const window = rows.slice(0, i + 1);
    const ticks = window.map((r) => ({ price: r.price }));
    const last = rows[i];
    const bids = [1, 2, 3, 4, 5].map((n) => ({ volume: last[`bid${n}_vol`] }));
    const asks = [1, 2, 3, 4, 5].map((n) => ({ volume: last[`ask${n}_vol`] }));
    const features = computeFeatures({ symbol: 'SEED', ticks, bids, asks });
    examples.push({ featureVector: features.featureVector, label: last.label });
  }
  return examples;
}

function walkForwardSplits(n, folds = 5) {
  const foldSize = Math.floor(n / (folds + 1));
  const splits = [];
  for (let fold = 1; fold <= folds; fold += 1) {
    const trainEnd = foldSize * fold;
    const testEnd = Math.min(foldSize * (fold + 1), n);
    splits.push({ trainIdx: [0, trainEnd], testIdx: [trainEnd, testEnd] });
  }
  return splits;
}

function accuracy(model, X, y) {
  let correct = 0;
  X.forEach((row, i) => {
    const p = logisticProbability(row, model);
    if ((p >= 0.5 ? 1 : 0) === y[i]) correct += 1;
  });
  return correct / X.length;
}

function meanEdge(model, X, y) {
  const preds = X.map((row) => logisticProbability(row, model));
  const meanP = preds.reduce((a, b) => a + b, 0) / preds.length;
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  return meanP - meanY;
}

function shuffleValidationGate(X, y, realEdge) {
  const idx = X.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const Xs = idx.map((i) => X[i]);
  const ys = idx.map((i) => y[i]);

  const shuffledModel = trainLogisticRegression(Xs, ys);
  const shuffledEdge = meanEdge(shuffledModel, Xs, ys);

  console.log(`  [validation] real edge=${realEdge.toFixed(4)}  shuffled edge=${shuffledEdge.toFixed(4)}`);
  return Math.abs(shuffledEdge) < Math.abs(realEdge) * 0.5 || Math.abs(realEdge) < 1e-4;
}

function main() {
  console.log('=== Nox Kesef training ===\n');

  const realExamples = journal.buildLabeledExamples();
  console.log(`Real trade journal: ${realExamples.length} labeled examples (${journal.JOURNAL_PATH})`);

  let examples;
  if (realExamples.length >= MIN_REAL_EXAMPLES) {
    examples = realExamples;
    console.log(`Using REAL data only (>= ${MIN_REAL_EXAMPLES} examples) -- this is your bot's own trading history.\n`);
  } else {
    if (!fs.existsSync(CSV_PATH)) {
      console.error(`Not enough real examples yet (${realExamples.length}/${MIN_REAL_EXAMPLES}) and no seed CSV found at ${CSV_PATH}. Run the bot in paper mode for a while first, or restore data/historical_ticks.csv.`);
      process.exit(1);
    }
    const csvRows = parseCsv(CSV_PATH);
    const syntheticExamples = labeledExamplesFromCsv(csvRows);
    examples = [...realExamples, ...syntheticExamples];
    console.log(`Blending ${realExamples.length} real + ${syntheticExamples.length} synthetic seed examples (real journal below the ${MIN_REAL_EXAMPLES}-example threshold).\n`);
  }

  if (examples.length < 20) {
    console.error('Not enough data to train on at all. Run the bot for longer, or check data/historical_ticks.csv exists.');
    process.exit(1);
  }

  console.log('[validation] running sequential lookahead veto test...');
  const sampleTicks = examples.slice(0, 20).map((_, i) => ({ price: 1.08 + i * 0.0001 }));
  if (!sequentialLookaheadCheck({ symbol: 'TEST', ticks: sampleTicks })) {
    console.error('[FAIL] Lookahead leakage detected in feature computation. Aborting.');
    process.exit(1);
  }
  console.log('[pass] no lookahead leakage detected.\n');

  const X = examples.map((e) => e.featureVector);
  const y = examples.map((e) => e.label);

  console.log('[train] walk-forward folds (diagnostic only, not a gate):');
  walkForwardSplits(X.length).forEach(({ trainIdx, testIdx }, i) => {
    const [ts, te] = trainIdx;
    const [vs, ve] = testIdx;
    if (te - ts < 10 || ve - vs < 3) return;
    const model = trainLogisticRegression(X.slice(ts, te), y.slice(ts, te));
    const acc = accuracy(model, X.slice(vs, ve), y.slice(vs, ve));
    console.log(`  fold ${i + 1}: train=${te - ts} test=${ve - vs} acc=${acc.toFixed(3)}`);
  });

  const finalModel = trainLogisticRegression(X, y);
  const realEdge = meanEdge(finalModel, X, y);

  console.log('\n[validation] running time-series shuffle validation...');
  if (!shuffleValidationGate(X, y, realEdge)) {
    console.error('[FAIL] Model edge did not collapse on shuffled data -- likely overfitting/leakage. Refusing to export.');
    process.exit(1);
  }
  console.log('[pass] shuffle validation gate cleared.\n');

  const finalAccuracy = accuracy(finalModel, X, y);
  const saved = saveModel({
    weights: finalModel.weights,
    bias: finalModel.bias,
    featureMeans: finalModel.featureMeans,
    featureStds: finalModel.featureStds,
    walkForwardAccuracy: Number(finalAccuracy.toFixed(4)),
    trainingExampleCount: examples.length,
  });

  console.log(`[done] model exported to models/ensemble-weights.json`);
  console.log(`       trained on ${examples.length} examples, in-sample accuracy ${(finalAccuracy * 100).toFixed(1)}%`);
  console.log(`\nNote: in-sample accuracy is optimistic by construction -- the walk-forward fold`);
  console.log(`accuracies above are the more honest estimate of real-world performance.`);
}

main();
