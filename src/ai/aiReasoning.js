/**
 * aiReasoning.js
 * --------------
 * Executes the 10-function NVIDIA AI matrix. Each function walks
 * PRIMARY -> BACKUP_1 -> BACKUP_2 on timeout/error/malformed JSON, exactly
 * like v1, but now via plain `fetch()` (native in Node 18+) instead of
 * langchain-nvidia-ai-endpoints -- one less dependency, and AbortSignal
 * gives a precise, unconditional timeout with none of the "client
 * construction itself can block" issues v1 had to work around.
 *
 * Functions run concurrently (Promise.all) rather than through a thread
 * pool -- fetch is natively async, so there's no blocking to work around
 * in the first place.
 */

const { discoverModels, buildFallbackMatrix, FUNCTION_DEFINITIONS } = require('./modelCatalog');

const CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const TIER_NAMES = ['PRIMARY', 'BACKUP_1', 'BACKUP_2'];

let apiKey = null;
let callTimeoutMs = 6000;
let matrix = buildFallbackMatrix(null); // static fallback until init() runs
let discoveredPool = null;

const statusMatrix = {};
FUNCTION_DEFINITIONS.forEach((fn) => {
  statusMatrix[fn.id] = {
    label: fn.label,
    active_model: null,
    tier: null,
    state: 'IDLE', // IDLE | ACTIVE | DEGRADED | OFFLINE
    last_updated: null,
  };
});

async function init({ nvidiaApiKey, timeoutMs }) {
  apiKey = nvidiaApiKey || null;
  if (timeoutMs) callTimeoutMs = timeoutMs;
  discoveredPool = await discoverModels(apiKey);
  matrix = buildFallbackMatrix(discoveredPool);
  return { discovered: !!discoveredPool, poolSize: (discoveredPool || []).length, matrix };
}

/** Lets the dashboard trigger a fresh catalog check without restarting. */
async function refreshModels() {
  return init({ nvidiaApiKey: apiKey, timeoutMs: callTimeoutMs });
}

function getFunction(functionId) {
  return matrix.find((fn) => fn.id === functionId);
}

class ModelUnavailable extends Error {}

async function invokeTier(model, systemPrompt, userPayload) {
  if (!apiKey) throw new ModelUnavailable('NVIDIA_API_KEY is not set');

  let response;
  try {
    response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(userPayload) },
        ],
        max_tokens: 400,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(callTimeoutMs),
    });
  } catch (err) {
    throw new ModelUnavailable(err.name === 'TimeoutError' ? `timeout after ${callTimeoutMs}ms` : err.message);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new ModelUnavailable(`HTTP ${response.status}: ${bodyText.slice(0, 200)}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content?.trim() || '';
  const cleaned = rawText.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new ModelUnavailable(`malformed JSON from model: ${err.message}`);
  }
}

async function runAiFunction(functionId, payload) {
  const fn = getFunction(functionId);
  if (!fn) throw new Error(`Unknown AI function: ${functionId}`);

  const errors = [];

  for (let tierIndex = 0; tierIndex < fn.tiers.length; tierIndex += 1) {
    const tier = fn.tiers[tierIndex];
    const started = Date.now();
    try {
      const output = await invokeTier(tier.model, fn.systemPrompt, payload);
      const latencyMs = Date.now() - started;

      statusMatrix[functionId] = {
        label: fn.label,
        active_model: tier.model,
        tier: TIER_NAMES[tierIndex],
        state: tierIndex === 0 ? 'ACTIVE' : 'DEGRADED',
        last_updated: new Date().toISOString(),
      };

      return {
        functionId,
        label: fn.label,
        activeModel: tier.model,
        tier: TIER_NAMES[tierIndex],
        latencyMs,
        output,
        errors,
      };
    } catch (err) {
      errors.push({ model: tier.model, reason: err.message });
    }
  }

  statusMatrix[functionId] = {
    label: fn.label,
    active_model: null,
    tier: null,
    state: 'OFFLINE',
    last_updated: new Date().toISOString(),
  };

  return { functionId, label: fn.label, activeModel: null, tier: 'OFFLINE', latencyMs: null, output: null, errors };
}

async function runAllAiFunctions(payload) {
  const results = await Promise.all(FUNCTION_DEFINITIONS.map((fn) => runAiFunction(fn.id, payload)));
  return Object.fromEntries(results.map((r) => [r.functionId, r]));
}

function getStatusMatrix() {
  return statusMatrix;
}

function getCatalogInfo() {
  return { discovered: !!discoveredPool, poolSize: (discoveredPool || []).length };
}

module.exports = { init, refreshModels, runAiFunction, runAllAiFunctions, getStatusMatrix, getCatalogInfo };
