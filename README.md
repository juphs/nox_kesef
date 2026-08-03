# Nox Kesef v2 ("נוקס כסף")

A single-process, live Deriv trading bot: one dashboard, one command to run
it, a real statistical ensemble model, an NVIDIA AI reasoning layer, and a
persistent trade journal your bot actually learns from over time.

```bash
npm install
npm start
```

That's it. Open **http://localhost:3000**, press **Start**. No Python, no
separate processes, no manual orchestration.

> **This is trading software, not financial advice, and it is not a
> profit guarantee.** See "Realistic expectations" below before you read
> anything else -- it directly addresses what a system like this can and
> can't do.

---

## What changed from v1

v1 was a Node.js dashboard talking to a separate Python engine over
ZeroMQ. v2 is one Node.js process, full stop:

- **The XGBoost/pandas statistical layer was ported to a pure-JS ensemble**
  (logistic regression + mean-reversion + momentum sub-models) -- no
  Python, no native compilation, `npm install` pulls exactly 5 packages.
- **The NVIDIA AI matrix now discovers your actual available models live**
  via NVIDIA's real `/v1/models` endpoint, instead of a hardcoded guess at
  what's in the catalog this month.
- **Start/Stop is real.** `npm start` boots the dashboard only -- no feed,
  no Deriv connection, no trading -- until you press Start.
- **Paper mode is a real simulated broker now**, not an instant coin-flip
  fill: contracts open with genuine stop/target price levels and only
  close when a later tick's price actually crosses one of them.
- **Every decision is journaled permanently** (`data/trade-journal.jsonl`)
  and is exactly what `npm run train` reads back in to retrain the model
  on your bot's own real history -- see "Learning from experience" below.
- **One page, everything on it.** Balance + chart, open contracts, trade
  history, AI health, and a live reasoning feed, with Settings tucked into
  a collapsible panel rather than a separate view.

---

## Realistic expectations

You mentioned wanting something like $10 -> $15 in a month (a 50%
monthly return). It's worth being direct about this rather than letting
it sit unaddressed: **no legitimate trading system, automated or human,
delivers that consistently.** A few concrete reference points:

- Renaissance Technologies' Medallion fund -- widely considered the best
  trading track record that has ever existed -- averaged roughly 30-40%
  **annually** (not monthly) net of fees in its best years, run by a
  hundred-plus PhDs with proprietary data most institutions can't buy.
- The research document you shared earlier in this project cites that
  **~90% of retail algo-traders underperform simple buy-and-hold** in
  their first year, and that top quant firms scrap the overwhelming
  majority of their own strategy ideas after testing.
- 50%/month compounded is over 100x/year. No public strategy at any
  scale has ever sustained that.

None of this means the bot is useless -- it means the honest goal is
**steady, modest, risk-controlled performance, if any edge exists at
all**, validated empirically over weeks/months of paper trading before
you'd ever consider putting real capital behind it. That's exactly what
the risk engine (Quarter-Kelly sizing, drawdown limits, position caps)
and the validation gates in `train.js` (walk-forward analysis, shuffle
testing) are built to support -- they can't manufacture an edge that
isn't there, but they make sure you'd actually notice if one wasn't.

---

## Architecture

```
nox-kesef-v2/
├── package.json              -- npm install && npm start, nothing else
├── train.js                  -- npm run train
├── data/
│   ├── historical_ticks.csv  -- synthetic seed data (for a cold start)
│   └── trade-journal.jsonl   -- your bot's permanent decision/outcome log
├── models/
│   └── ensemble-weights.json -- the trained logistic-regression component
└── src/
    ├── server.js              -- single entry point
    ├── config/systemConfig.js
    ├── engine/
    │   ├── features.js         -- log returns, OBI, volatility, z-score, momentum
    │   ├── ensembleModel.js     -- logistic regression + mean-reversion + momentum
    │   ├── modelStore.js        -- loads/saves trained weights (plain JSON)
    │   └── marketHours.js       -- forex market open/closed
    ├── ai/
    │   ├── modelCatalog.js      -- live NVIDIA model discovery + the 10 functions
    │   └── aiReasoning.js       -- walks the fallback matrix via fetch()
    ├── deriv/derivClient.js     -- real Deriv WebSocket API client
    ├── controllers/
    │   ├── botController.js     -- owns Start/Stop lifecycle
    │   ├── marketData.js        -- mock generator OR real Deriv ticks
    │   ├── executionEngine.js   -- feature -> ensemble -> AI -> risk -> order
    │   ├── riskEngine.js        -- Kelly sizing, kill switch, position caps
    │   ├── paperBroker.js       -- realistic simulated contract lifecycle
    │   ├── dashboardState.js    -- single in-memory state for the whole UI
    │   └── tradingSettings.js   -- runtime pair selection
    ├── services/
    │   ├── journal.js           -- the permanent JSONL trade journal
    │   ├── newsFeed.js          -- ForexFactory + Frankfurter (free, keyless)
    │   └── broadcastHub.js
    ├── routes/indexRoutes.js
    ├── views/                   -- the one dashboard page + partials
    └── public/                  -- css/js/img
```

**Data flow:** the feed (mock or real Deriv ticks) emits a tick ->
`executionEngine.js` computes features -> the ensemble model estimates a
win probability and EV -> if it clears the approval threshold, the
10-function NVIDIA AI matrix runs and a news-calendar check happens ->
`riskEngine.js` applies the kill switch, circuit breaker, concurrency cap,
and Quarter-Kelly sizing -> a real Deriv Multiplier contract opens (or a
realistic paper one) -> every step is journaled -> the dashboard updates
live over WebSocket.

---

## The statistical ensemble (no Python required)

Three small, fully auditable sub-models, blended:

1. **Logistic regression** over `[logReturn, OBI, rollingVolatility,
   zScore, momentumSignal]` -- the one component that's actually trained.
   Out of the box its weights are all zero (contributes a neutral 0.5,
   not a fake opinion) until you run `npm run train`.
2. **Mean-reversion** -- a sigmoid transform of the z-score: price
   stretched far above its recent mean leans toward reversion down.
3. **Momentum** -- a sigmoid transform of the short/long moving-average
   spread: short MA above long MA leans toward continuation up.

This is deliberately simple (per general quant-research guidance on
right-sizing model complexity): no deep learning, no reinforcement
learning, no black box. Every sub-model's individual output is visible in
the reasoning feed for every single decision.

**Known limitation, stated plainly:** Deriv's retail forex API (like
every retail broker's public API) doesn't expose Level 2 order-book
depth. "OBI" is approximated from recent tick-direction momentum, not
real resting-order volume. This is disclosed in `marketData.js`, not
hidden.

---

## Learning from experience (the trade journal)

Every decision the bot makes -- trade or wait -- is appended permanently
to `data/trade-journal.jsonl`, one JSON object per line:

```json
{"ts":"...","type":"decision","symbol":"EURUSD","featureVector":[...],"pWin":0.57,"ev":0.12,"status":"DISPATCHED","contractId":"...", ...}
{"ts":"...","type":"contract_closed","contractId":"...","pnl":12.40,"outcome":"WON","reason":"Closed by Deriv (target/expiry)"}
```

Run `npm run train` (or click **Retrain Model Now** on the dashboard) and
it:

1. Joins `DISPATCHED` decisions to their eventual outcome by `contractId`
   to build real `(features, win/loss)` training examples.
2. Runs a **Sequential Lookahead Veto Test** (features at time *t* never
   see data at *t+1*).
3. Runs a **Walk-Forward Analysis** (chronological train/test folds,
   reported per-fold for your own sanity check).
4. Runs a **Time-Series Shuffle Validation gate** -- retrains on a
   shuffled copy and refuses to export if the "edge" doesn't collapse,
   since that pattern usually means overfitting or leakage, not a real
   signal.
5. Saves the result to `models/ensemble-weights.json`, which is read
   fresh from disk on every single evaluation -- a successful retrain
   takes effect on the very next tick, no restart needed.

Below 40 real closed trades, training blends in `data/historical_ticks.csv`
(synthetic random-walk data) so the pipeline is exercised end to end from
a cold start; at 40+, it trains on your real history alone.

**Portability:** `data/trade-journal.jsonl` is plain text and completely
self-contained. Copy it into another Nox Kesef install's `data/` folder
and `npm run train` there to teach a second bot instance from this one's
accumulated experience.

---

## Setting up live Deriv trading

1. Log into [app.deriv.com](https://app.deriv.com), switch the account
   selector to your **Demo** account, go to **Settings -> API token**,
   and create one with **Read** + **Trade** scopes.
2. `cp .env.example .env`, then set:
   ```
   FEED_MODE=deriv
   DERIV_API_TOKEN=your_demo_token_here
   ```
3. `npm start`, open the dashboard, press **Start**.

The top bar shows `DERIV: CONNECTING...` then `DEMO LIVE` once
authorized, and your real demo balance populates within a couple of
seconds.

### How trades are placed
Every approved signal opens a **Multiplier** contract (`MULTUP`/`MULTDOWN`
based on the ensemble's win probability), sized by Quarter-Kelly (capped
by your risk profile and the absolute statistical ceilings in
`riskEngine.js`), with take-profit/stop-loss levels scaled to the pair's
own recently-measured volatility rather than an arbitrary flat number --
see the comment block at the top of `executionEngine.js` for why that
distinction matters.

### Going live with real money (optional, at your own risk)
The bot checks Deriv's own `is_virtual` flag -- if your token belongs to
a real-money account, it refuses to trade unless you also set
`ALLOW_REAL_MONEY_TRADING=true`. This is a code-level check against
Deriv's own answer, not something that trusts a config file's claim.

---

## The NVIDIA AI reasoning matrix

Ten functions (market regime, signal synthesis, news sentiment, risk
narration, position sizing advice, anomaly detection, correlation
analysis, trade rationale, execution timing, post-trade review), each
walking PRIMARY -> BACKUP_1 -> BACKUP_2 on timeout/error/malformed output.

Unlike v1, the model roster isn't hardcoded: on boot (and via the
**Refresh AI Model Catalog** button), the bot calls NVIDIA's real
`GET /v1/models` endpoint with your key and builds the fallback matrix
from whatever you can actually reach right now, filtering out
non-chat models (embeddings, safety classifiers, translation, vision-only,
etc.) by name pattern. Without a key, it falls back to a small static list
and everything reports OFFLINE in the AI Health panel -- the bot still
trades on the statistical ensemble alone, which is a complete signal on
its own, not a crippled fallback.

Get a free key at [build.nvidia.com](https://build.nvidia.com) and set
`NVIDIA_API_KEY` in `.env`.

**Latency note:** the AI matrix only runs for genuine trade candidates
(EV already cleared the approval bar) -- LLM calls are hundreds of ms to
seconds each, so running all 10 on every tick of market noise would both
wreck the fast statistical path and burn free-tier rate limits for
nothing.

---

## Dashboard tour

- **Top bar:** which pairs are being scanned, execution mode (paper/demo
  live/real money), market open/closed, running/stopped, a **Settings**
  toggle, the kill switch, and **Start/Stop**.
- **Balance panel:** current balance, realized P&L, and a live chart.
- **Open Contracts / Trade History:** stake, leverage, stop/target
  levels, model confidence, P&L, and (in history) why each trade closed.
- **AI Health:** which model is answering each of the 10 functions, or
  `down`/`idle` if none are.
- **Reasoning Feed:** a live narration of every WAIT and every trade,
  including each ensemble sub-model's individual read.
- **Settings (collapsible):** risk profile (Conservative/Balanced/
  Aggressive), pair selection (all 28 of Deriv's standard forex pairs,
  auto-validated against your account when connected live), training
  data stats + a one-click retrain, and connection info.

---

## Risk controls

- **Kill switch** -- persistent, not self-resetting. Trips automatically
  on a drawdown breach and stays halted until you explicitly resume.
- **Quarter-Kelly sizing**, scaled by risk profile, hard-capped at an
  absolute % of balance no profile can exceed (15%).
- **Max concurrent positions** (default 8) -- a portfolio-level cap
  independent of per-trade sizing, so the bot can't quietly accumulate
  unbounded simultaneous exposure across pairs.
- **Volatility-scaled stops** -- take-profit/stop-loss distances derived
  from the pair's own recent volatility, not an arbitrary fixed number.

All of the above are enforced in code, not left to hope.

---

## Design notes
- All money math uses `bignumber.js`, never raw floats.
- Both the Deriv client and (implicitly, via the concurrency cap) the
  execution pipeline self-heal from disconnects/errors rather than going
  stale silently.
- `train.js` and the runtime both import the exact same
  `computeFeatures`/`logisticProbability` code from `src/engine/` -- there
  is no separate "training version" of the math that could drift from
  what actually runs live.
