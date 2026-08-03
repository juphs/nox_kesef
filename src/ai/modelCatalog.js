/**
 * modelCatalog.js
 * ---------------
 * Two jobs:
 *   1. Discover which chat/reasoning models your NVIDIA_API_KEY can
 *      actually reach right now, via NVIDIA's real OpenAI-compatible
 *      `GET /v1/models` endpoint -- instead of hardcoding a guessed list
 *      that silently goes stale as NVIDIA's catalog changes.
 *   2. Build the 10-function x 3-tier fallback matrix from whatever was
 *      discovered (or a small, honestly-labeled static fallback list if
 *      discovery fails -- no key set, network error, etc).
 *
 * The static fallback list below reflects models confirmed reachable via
 * NVIDIA's catalog and hands-on API testing as of mid-2026 -- it exists
 * only as a safety net for when live discovery isn't possible, not as the
 * primary source of truth.
 */

const NVIDIA_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models';
const DISCOVERY_TIMEOUT_MS = 10000;

// Model IDs NOT suited to JSON-structured reasoning tasks (embeddings,
// rerankers, safety classifiers, translation, video/vision-only models,
// TTS/ASR, etc.) -- excluded from the pool a chat function could be
// assigned to, however they show up in the live catalog.
const EXCLUDE_PATTERNS = /embed|rerank|safety|translat|video|cosmos|ising-calibration|riva|guard|moderation|detector|-tts|-asr|\bocr\b|vila|clip|canary|reward|whisper/i;

// Fallback pool, used only if live discovery fails. Reflects models
// confirmed present in NVIDIA's catalog / working via hands-on API tests
// as of mid-2026 -- swap freely, nothing else in the codebase needs to
// change if these drift.
const STATIC_FALLBACK_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/llama-3.3-nemotron-super-49b-v1',
  'google/gemma-4-31b-it',
  'google/diffusiongemma-26b-a4b-it',
  'meta/llama-3.1-405b-instruct',
  'moonshotai/kimi-k2-instruct',
  'mistralai/mistral-large-3-675b-instruct-2512',
  'mistralai/mixtral-8x7b-instruct-v0.1',
  'qwen/qwen3-coder-480b-a35b-instruct',
  'bytedance/seed-oss-36b-instruct',
];

/**
 * Queries NVIDIA's live model catalog. Returns an array of model id
 * strings, or null if discovery wasn't possible (caller should fall back
 * to STATIC_FALLBACK_MODELS in that case).
 */
async function discoverModels(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(NVIDIA_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[modelCatalog] /v1/models returned HTTP ${res.status} -- using static fallback list`);
      return null;
    }
    const body = await res.json();
    const ids = (body.data || []).map((m) => m.id).filter(Boolean);
    const usable = ids.filter((id) => !EXCLUDE_PATTERNS.test(id));
    if (usable.length < 3) {
      console.warn('[modelCatalog] fewer than 3 usable chat models discovered -- using static fallback list');
      return null;
    }
    console.log(`[modelCatalog] discovered ${usable.length} usable chat models from your live NVIDIA catalog`);
    return usable;
  } catch (err) {
    console.warn('[modelCatalog] live model discovery failed, using static fallback list:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// The 10 AI functions. Tiers are filled in by buildFallbackMatrix() below
// from whatever pool (discovered or static) is available at startup.
// ---------------------------------------------------------------------
const FUNCTION_DEFINITIONS = [
  {
    id: 'MARKET_REGIME',
    label: 'Market Regime Classifier',
    systemPrompt:
      'You are a quantitative market-regime classifier. Given log returns, order book imbalance (OBI), ' +
      'realized volatility and a z-score, respond with ONLY a JSON object: ' +
      '{"regime": "TRENDING|RANGING|VOLATILE|QUIET", "confidence": 0-1}. No prose, no markdown fences.',
  },
  {
    id: 'SIGNAL_SYNTHESIS',
    label: 'Signal Synthesis Engine',
    systemPrompt:
      'You synthesize a directional trade bias from statistical features and the ensemble sub-model outputs. ' +
      'Respond with ONLY JSON: {"bias": "LONG|SHORT|FLAT", "strength": 0-1, "rationale": "<12 words"}.',
  },
  {
    id: 'NEWS_SENTIMENT',
    label: 'News Sentiment Analyzer',
    systemPrompt:
      'You are a macro news-risk analyzer for FX pairs. Given upcoming economic calendar events, respond with ' +
      'ONLY JSON: {"news_risk": "LOW|MEDIUM|HIGH", "blackout_minutes": int, "reason": "<15 words"}.',
  },
  {
    id: 'RISK_ASSESSMENT',
    label: 'Risk Assessment Narrator',
    systemPrompt:
      'You are a risk officer reviewing a proposed FX trade against portfolio risk state. Respond with ONLY ' +
      'JSON: {"verdict": "APPROVE|REJECT", "reason": "<20 words"}.',
  },
  {
    id: 'POSITION_SIZE_ADVISOR',
    label: 'Position Size Advisor',
    systemPrompt:
      'You advise on adjusting a Kelly-derived position size given qualitative context (news risk, regime, ' +
      'correlation exposure). Respond with ONLY JSON: {"adjustment": "SHRINK|HOLD|EXPAND", "multiplier": 0.0-1.5}.',
  },
  {
    id: 'ANOMALY_DETECTION',
    label: 'Anomaly / Black-Swan Detector',
    systemPrompt:
      'You detect abnormal market microstructure conditions (spread spikes, stale ticks, gaps). Respond with ' +
      'ONLY JSON: {"anomaly": true|false, "type": "NONE|STALE_FEED|SPREAD_SPIKE|GAP", "halt_trading": true|false}.',
  },
  {
    id: 'CORRELATION_ANALYSIS',
    label: 'Cross-Pair Correlation Analyzer',
    systemPrompt:
      'You analyze cross-pair correlation and exposure concentration risk. Respond with ONLY JSON: ' +
      '{"concentration_risk": "LOW|MEDIUM|HIGH", "correlated_pairs": ["..."]}.',
  },
  {
    id: 'TRADE_RATIONALE',
    label: 'Trade Rationale Generator',
    systemPrompt:
      'You write a single, concise sentence explaining a trade decision for a live log. Respond with ONLY ' +
      'JSON: {"summary": "<25 words"}.',
  },
  {
    id: 'EXECUTION_TIMING',
    label: 'Execution Timing Optimizer',
    systemPrompt:
      'You recommend execution timing to minimize slippage given current spread/volatility context. Respond ' +
      'with ONLY JSON: {"timing": "IMMEDIATE|WAIT_SHORT|WAIT_FOR_SPREAD", "wait_ms": int}.',
  },
  {
    id: 'POST_TRADE_REVIEW',
    label: 'Post-Trade Review Journalist',
    systemPrompt:
      'You are a trading journal analyst reviewing a closed trade\'s outcome vs its original thesis. Respond ' +
      'with ONLY JSON: {"lesson": "<20 words", "thesis_held": true|false}.',
  },
];

/**
 * Builds the 10-function x 3-tier matrix from a pool of model ids. Each
 * function gets a different rotation offset through the pool so tiers
 * aren't identical across every function even when the pool is small.
 */
function buildFallbackMatrix(pool) {
  const models = pool && pool.length >= 3 ? pool : STATIC_FALLBACK_MODELS;

  return FUNCTION_DEFINITIONS.map((fn, index) => {
    const tiers = [0, 1, 2].map((tierOffset) => {
      const poolIndex = (index + tierOffset) % models.length;
      return { model: models[poolIndex] };
    });
    return { ...fn, tiers };
  });
}

module.exports = {
  discoverModels,
  buildFallbackMatrix,
  FUNCTION_DEFINITIONS,
  STATIC_FALLBACK_MODELS,
};
