/**
 * journal.js
 * ----------
 * Every decision the bot makes (WAIT or trade) and every contract outcome
 * gets appended, permanently, to data/trade-journal.jsonl -- one JSON
 * object per line (JSONL). This survives restarts, is plain text (readable
 * in any editor, greppable, diffable), and is the exact format train.js
 * reads back in to retrain the ensemble's logistic-regression component
 * on your bot's own real history instead of only the synthetic seed data.
 *
 * Portability: this file is completely self-contained -- copy
 * data/trade-journal.jsonl into a fresh Nox Kesef install's data/ folder
 * and `npm run train` there will pick it up and train that instance on
 * this one's accumulated experience.
 *
 * Why JSONL instead of a single JSON array: appending a line is an O(1),
 * crash-safe operation (fs.appendFileSync), whereas appending to a JSON
 * array means rewriting the whole file every time. Every line is still
 * independently valid JSON, so it's trivial to read back with a
 * line-by-line parser (or `cat file.jsonl | jq .` from a shell).
 */

const fs = require('fs');
const path = require('path');

const JOURNAL_PATH = path.join(__dirname, '..', '..', 'data', 'trade-journal.jsonl');

function ensureDataDir() {
  fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
}

function appendEvent(event) {
  try {
    ensureDataDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(JOURNAL_PATH, line + '\n');
  } catch (err) {
    // The journal is important but must never be allowed to crash the
    // trading loop -- log and move on.
    console.error('[journal] failed to append event:', err.message);
  }
}

function logDecision({ symbol, featureVector, pWin, ev, subModels, status, reason, contractId, executionMode }) {
  appendEvent({ type: 'decision', symbol, featureVector, pWin, ev, subModels, status, reason, contractId: contractId || null, executionMode });
}

function logContractClosed({ symbol, contractId, pnl, reason }) {
  appendEvent({ type: 'contract_closed', symbol, contractId, pnl, outcome: pnl >= 0 ? 'WON' : 'LOST', reason });
}

/** Reads the full journal back as an array of parsed records (skips any malformed lines rather than failing the whole read). */
function readAll() {
  if (!fs.existsSync(JOURNAL_PATH)) return [];
  const raw = fs.readFileSync(JOURNAL_PATH, 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      // skip malformed line
    }
  }
  return records;
}

/** Joins decision <-> contract_closed records by contractId into labeled (featureVector, label) training examples. */
function buildLabeledExamples() {
  const records = readAll();
  const decisionsByContract = new Map();
  for (const r of records) {
    if (r.type === 'decision' && r.contractId) decisionsByContract.set(r.contractId, r);
  }

  const examples = [];
  for (const r of records) {
    if (r.type !== 'contract_closed') continue;
    const decision = decisionsByContract.get(r.contractId);
    if (!decision || !Array.isArray(decision.featureVector)) continue;
    examples.push({ featureVector: decision.featureVector, label: r.outcome === 'WON' ? 1 : 0, symbol: r.symbol, ts: r.ts });
  }
  return examples;
}

function getStats() {
  const records = readAll();
  const decisions = records.filter((r) => r.type === 'decision');
  const closes = records.filter((r) => r.type === 'contract_closed');
  const wins = closes.filter((c) => c.outcome === 'WON').length;
  let fileSizeBytes = 0;
  try {
    fileSizeBytes = fs.statSync(JOURNAL_PATH).size;
  } catch (err) {
    /* file doesn't exist yet */
  }

  return {
    path: JOURNAL_PATH,
    totalRecords: records.length,
    totalDecisions: decisions.length,
    totalDispatched: decisions.filter((d) => d.status === 'DISPATCHED').length,
    totalClosedTrades: closes.length,
    wins,
    losses: closes.length - wins,
    winRatePct: closes.length > 0 ? Number(((wins / closes.length) * 100).toFixed(1)) : null,
    fileSizeBytes,
  };
}

module.exports = { JOURNAL_PATH, appendEvent, logDecision, logContractClosed, readAll, buildLabeledExamples, getStats };
