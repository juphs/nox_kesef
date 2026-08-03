// public/js/dashboard.js
// WebSocket-driven live updates for the single-page dashboard. No page
// refresh, ever -- every control (Start/Stop, kill switch, risk profile,
// pairs, AI refresh) round-trips through a small REST call and the
// resulting state is re-applied to the DOM the same way a push update is.

(function () {
  const WS_RECONNECT_DELAY_MS = 1500;
  let balanceChart = null;

  function fmtMoney(n) {
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------------------------------------------------------------- chart
  function updateBalanceChart(balanceHistory) {
    const canvas = document.getElementById('balanceChart');
    if (!canvas || !balanceHistory || !window.Chart) return;

    const labels = balanceHistory.map((p) => new Date(p.ts).toLocaleTimeString());
    const data = balanceHistory.map((p) => p.balance);
    const trendingUp = data.length < 2 || data[data.length - 1] >= data[0];
    const lineColor = trendingUp ? '#3ECF8E' : '#E5545B';
    const fillColor = trendingUp ? 'rgba(62,207,142,0.10)' : 'rgba(229,84,91,0.10)';

    if (!balanceChart) {
      balanceChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels, datasets: [{ data, borderColor: lineColor, backgroundColor: fillColor, borderWidth: 2, pointRadius: 0, tension: 0.25, fill: true }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false } },
          scales: { x: { display: false }, y: { display: false } },
        },
      });
    } else {
      balanceChart.data.labels = labels;
      balanceChart.data.datasets[0].data = data;
      balanceChart.data.datasets[0].borderColor = lineColor;
      balanceChart.data.datasets[0].backgroundColor = fillColor;
      balanceChart.update('none');
    }
  }

  // ---------------------------------------------------------------- top bar
  function updateTopBar(state) {
    const scanningPill = document.getElementById('scanningPill');
    if (scanningPill) scanningPill.textContent = `SCANNING: ${state.pairs.selected.join(', ')}`;

    const modePill = document.getElementById('modePill');
    if (modePill) {
      modePill.className = `pill ${state.connection.executionMode === 'DERIV' ? 'live' : 'paper'}`;
      modePill.textContent = state.connection.executionMode === 'DERIV'
        ? (state.connection.derivIsVirtual === false ? 'REAL MONEY' : 'DEMO LIVE')
        : 'PAPER';
    }

    const marketPill = document.getElementById('marketPill');
    if (marketPill) {
      marketPill.className = `pill ${state.marketOpen ? 'market-open' : 'market-closed'}`;
      marketPill.textContent = state.marketOpen ? 'MARKET OPEN' : 'MARKET CLOSED';
    }

    const runningDot = document.getElementById('runningDot');
    const runningLabel = document.getElementById('runningLabel');
    if (runningDot) runningDot.className = `status-dot ${state.bot.running ? 'running' : 'stopped'}`;
    if (runningLabel) runningLabel.textContent = state.bot.running ? 'running' : 'stopped';

    const botToggleBtn = document.getElementById('botToggleBtn');
    if (botToggleBtn) {
      botToggleBtn.textContent = state.bot.running ? 'STOP' : 'START';
      botToggleBtn.className = `btn ${state.bot.running ? 'btn-stop' : 'btn-start'}`;
    }

    const killBtn = document.getElementById('killSwitchBtn');
    if (killBtn) {
      killBtn.textContent = state.risk.killSwitchEngaged ? 'RESUME' : 'KILL SWITCH';
      killBtn.classList.toggle('engaged', state.risk.killSwitchEngaged);
    }

    const banner = document.getElementById('warningBanner');
    if (banner) {
      banner.classList.toggle('visible', state.risk.killSwitchEngaged);
      banner.textContent = state.risk.killSwitchEngaged
        ? `Daily loss limit reached -- new entries paused. ${state.risk.killSwitchReason || ''} Existing positions are still being managed.`
        : '';
    }
  }

  // ---------------------------------------------------------------- balance
  function updateBalancePanel(risk, connection) {
    const balanceEl = document.getElementById('statBalance');
    if (balanceEl) {
      balanceEl.textContent = connection.executionMode === 'DERIV' && !risk.liveBalanceSynced ? 'syncing…' : fmtMoney(risk.balance);
    }
    const realizedEl = document.getElementById('statRealized');
    if (realizedEl) {
      realizedEl.textContent = `${risk.realizedPnl >= 0 ? '+' : ''}$${risk.realizedPnl.toFixed(2)} realized`;
      realizedEl.className = `balance-realized ${risk.realizedPnl >= 0 ? 'positive' : 'negative'}`;
    }
    const profileLabel = document.getElementById('riskProfileLabel');
    if (profileLabel && risk.riskProfile) profileLabel.textContent = risk.riskProfile.label.toLowerCase();

    const openCount = document.getElementById('openContractsCount');
    if (openCount) openCount.textContent = `${risk.openPositionCount}/${risk.maxConcurrentPositions}`;

    if (risk.balanceHistory) updateBalanceChart(risk.balanceHistory);
    if (risk.riskProfile) updateRiskProfileUI(risk.riskProfile);
  }

  function updateRiskProfileUI(riskProfile) {
    const selector = document.getElementById('riskProfileSelector');
    if (selector) {
      selector.querySelectorAll('.risk-profile-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.profile === riskProfile.active));
    }
    const effectiveEl = document.getElementById('riskProfileEffective');
    if (effectiveEl) {
      const e = riskProfile.effective;
      effectiveEl.textContent = `Kelly x${e.kellyFraction} · max position ${e.maxPositionPctOfBalance}% · max drawdown ${e.maxDailyDrawdownPct}% · leverage x${e.leverage}`;
    }
  }

  // ---------------------------------------------------------------- contracts
  function contractRowHtml(c, isHistory) {
    const contractId = escapeHtml(c.contractId || c.contract_id || '');
    const symbol = escapeHtml(c.symbol);
    const direction = c.direction === 'MULTUP' ? 'MULTUP' : 'MULTDOWN';
    const sideClass = `side-${direction.toLowerCase()}`;
    const sideLabel = direction === 'MULTUP' ? 'BUY' : 'SELL';
    const pnlValue = Number(c.pnl);
    const hasPnl = Number.isFinite(pnlValue);
    const pnlText = hasPnl ? `${pnlValue >= 0 ? '+' : ''}${pnlValue.toFixed(2)}` : '—';
    const pnlClass = hasPnl && pnlValue < 0 ? 'negative' : 'positive';

    if (isHistory) {
      return `<tr data-contract-id="${contractId}">
        <td>${symbol}</td><td class="${sideClass}">${sideLabel}</td><td>$${escapeHtml(c.stake)}</td><td>x${escapeHtml(c.multiplier)}</td>
        <td class="ev-value ${pnlClass}">${escapeHtml(pnlText)}</td><td>${escapeHtml(c.reason || '')}</td>
      </tr>`;
    }
    return `<tr data-contract-id="${contractId}">
      <td>${symbol}</td><td class="${sideClass}">${sideLabel}</td><td>$${escapeHtml(c.stake)}</td><td>x${escapeHtml(c.multiplier)}</td>
      <td>$${escapeHtml(c.stopLossValue)}</td><td>$${escapeHtml(c.takeProfitValue)}</td><td>${Math.round((Number(c.confidence) || 0) * 100)}%</td>
      <td class="ev-value ${pnlClass}">${escapeHtml(pnlText)}</td>
    </tr>`;
  }

  function updateContracts(contracts) {
    const open = contracts.filter((c) => c.status === 'OPEN');
    const closed = contracts.filter((c) => c.status !== 'OPEN');

    const openBody = document.getElementById('contractsBody');
    const openEmptyRow = document.getElementById('contractsEmptyRow');
    if (openBody) {
      if (open.length > 0 && openEmptyRow) openEmptyRow.remove();
      if (open.length === 0 && !document.getElementById('contractsEmptyRow')) {
        openBody.innerHTML = '<tr id="contractsEmptyRow"><td colspan="8" class="empty-state">No open contracts.</td></tr>';
      }
      open.forEach((c) => {
        const existing = openBody.querySelector(`tr[data-contract-id="${c.contractId}"]`);
        const html = contractRowHtml(c, false);
        if (existing) existing.outerHTML = html;
        else openBody.insertAdjacentHTML('afterbegin', html);
      });
      // Move any row that closed out of the open table.
      openBody.querySelectorAll('tr[data-contract-id]').forEach((row) => {
        if (!open.find((c) => String(c.contractId) === row.dataset.contractId)) row.remove();
      });
      if (openBody.querySelectorAll('tr[data-contract-id]').length === 0 && !document.getElementById('contractsEmptyRow')) {
        openBody.insertAdjacentHTML('afterbegin', '<tr id="contractsEmptyRow"><td colspan="8" class="empty-state">No open contracts.</td></tr>');
      }
    }

    const historyBody = document.getElementById('historyBody');
    const historyEmptyRow = document.getElementById('historyEmptyRow');
    if (historyBody) {
      if (closed.length > 0 && historyEmptyRow) historyEmptyRow.remove();
      closed.forEach((c) => {
        const existing = historyBody.querySelector(`tr[data-contract-id="${c.contractId}"]`);
        const html = contractRowHtml(c, true);
        if (existing) existing.outerHTML = html;
        else historyBody.insertAdjacentHTML('afterbegin', html);
      });
    }
  }

  // ---------------------------------------------------------------- AI health
  function updateAiHealth(aiStatus) {
    Object.entries(aiStatus).forEach(([functionId, fn]) => {
      const item = document.querySelector(`.ai-health-item[data-function="${functionId}"]`);
      if (!item) return;
      const dot = item.querySelector('[data-role="dot"]');
      const name = item.querySelector('[data-role="model-name"]');
      const tag = item.querySelector('[data-role="tag"]');
      const isOk = fn.state === 'ACTIVE' || fn.state === 'DEGRADED';
      if (dot) dot.className = `status-dot ${isOk ? 'online' : 'offline'}`;
      if (name) name.textContent = fn.active_model || fn.label;
      if (tag) {
        const label = fn.state === 'ACTIVE' ? 'ok' : fn.state === 'DEGRADED' ? 'fallback' : fn.state === 'IDLE' ? 'idle' : 'down';
        tag.textContent = label;
        tag.className = `tag ${fn.state === 'ACTIVE' ? 'ok' : fn.state === 'DEGRADED' ? 'degraded' : 'down'}`;
      }
    });
    const online = Object.values(aiStatus).filter((fn) => fn.state === 'ACTIVE' || fn.state === 'DEGRADED').length;
    const total = Object.keys(aiStatus).length;
    const countEl = document.getElementById('aiHealthCount');
    if (countEl) countEl.textContent = `${online}/${total} online`;
  }

  // ---------------------------------------------------------------- logs
  function updateLogs(logs) {
    const panel = document.getElementById('logPanel');
    if (!panel || !logs) return;
    panel.innerHTML = logs.length === 0
      ? '<div class="empty-state" id="logEmptyState">Press START to begin scanning.</div>'
      : logs.map((entry) => `<div class="log-line ${escapeHtml(entry.level)}"><span class="ts">[${new Date(entry.ts).toLocaleTimeString()}]</span>${escapeHtml(entry.line)}</div>`).join('');
  }

  // ---------------------------------------------------------------- pairs
  function updatePairsUI(pairs) {
    const grid = document.getElementById('pairsGrid');
    const note = document.getElementById('pairsAvailableNote');
    if (note) note.textContent = `(${pairs.available.length} available)`;
    if (!grid) return;

    const currentValues = [...grid.querySelectorAll('input[type="checkbox"]')].map((el) => el.value);
    const availableChanged = currentValues.length !== pairs.available.length || !pairs.available.every((p) => currentValues.includes(p));

    if (availableChanged) {
      grid.innerHTML = pairs.available.map((pair) => `
        <label class="pair-chip"><input type="checkbox" value="${escapeHtml(pair)}" ${pairs.selected.includes(pair) ? 'checked' : ''} /><span>${escapeHtml(pair)}</span></label>
      `).join('');
    } else {
      grid.querySelectorAll('input[type="checkbox"]').forEach((el) => { el.checked = pairs.selected.includes(el.value); });
    }
  }

  // ---------------------------------------------------------------- journal
  function updateJournalStats(j) {
    const el = document.getElementById('journalStats');
    if (!el || !j) return;
    el.innerHTML = `
      Decisions logged: <strong>${j.totalDecisions}</strong> &middot;
      Closed trades: <strong>${j.totalClosedTrades}</strong> &middot;
      Win rate: <strong>${j.winRatePct !== null ? j.winRatePct + '%' : '&mdash;'}</strong><br/>
      Journal file: <code>${escapeHtml(j.path)}</code> (${(j.fileSizeBytes / 1024).toFixed(1)} KB)<br/>
      <span class="config-sub">This file is plain-text JSONL -- copy it into another Nox Kesef install's <code>data/</code> folder and retrain there to teach a second bot from this one's history.</span>
    `;
  }

  // ---------------------------------------------------------------- apply
  function applyState(state) {
    if (!state) return;
    updateTopBar(state);
    if (state.risk && state.connection) updateBalancePanel(state.risk, state.connection);
    if (state.aiStatus) updateAiHealth(state.aiStatus);
    if (state.contracts) updateContracts(state.contracts);
    if (state.logs) updateLogs(state.logs);
    if (state.pairs) updatePairsUI(state.pairs);
    if (state.journal) updateJournalStats(state.journal);
  }

  // ---------------------------------------------------------------- websocket
  function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'snapshot' || msg.type === 'update') applyState(msg.state);
      } catch (err) {
        console.error('[dashboard] failed to parse WS message', err);
      }
    });
    ws.addEventListener('close', () => setTimeout(connect, WS_RECONNECT_DELAY_MS));
    ws.addEventListener('error', () => ws.close());
  }

  // ---------------------------------------------------------------- controls
  async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    return { ok: res.ok, data };
  }

  function wireBotToggle() {
    const btn = document.getElementById('botToggleBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const starting = btn.textContent.trim() === 'START';
      const { data } = await postJson(starting ? '/api/bot/start' : '/api/bot/stop');
      applyState(data);
    });
  }

  function wireKillSwitch() {
    const btn = document.getElementById('killSwitchBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const engaging = !btn.classList.contains('engaged');
      if (engaging && !confirm('Halt all new trading immediately? Open contracts are left to close on their own take-profit/stop-loss.')) return;
      const { data } = await postJson(engaging ? '/api/kill-switch/engage' : '/api/kill-switch/reset');
      applyState(data);
    });
  }

  function wireSettingsToggle() {
    const btn = document.getElementById('settingsToggleBtn');
    const panel = document.getElementById('settingsPanel');
    if (!btn || !panel) return;
    btn.addEventListener('click', () => panel.classList.toggle('open'));
  }

  function wireRiskProfile() {
    const selector = document.getElementById('riskProfileSelector');
    if (!selector) return;
    selector.addEventListener('click', async (event) => {
      const btn = event.target.closest('.risk-profile-btn');
      if (!btn) return;
      const profile = btn.dataset.profile;
      if (profile === 'aggressive' && !confirm('Aggressive mode increases Kelly sizing, max position %, drawdown tolerance, and leverage. Continue?')) return;
      const { ok, data } = await postJson('/api/risk-profile', { profile });
      if (ok) applyState(data);
      else console.error('[dashboard] risk profile update rejected:', data.error);
    });
  }

  function wirePairsApply() {
    const btn = document.getElementById('applyPairsBtn');
    const grid = document.getElementById('pairsGrid');
    if (!btn || !grid) return;
    btn.addEventListener('click', async () => {
      const selected = [...grid.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.value);
      if (selected.length === 0) { alert('Select at least one pair.'); return; }
      const { ok, data } = await postJson('/api/pairs', { pairs: selected });
      if (ok) applyState(data);
      else alert(data.error || 'Could not update pairs');
    });
  }

  function wireAiRefresh() {
    const btn = document.getElementById('refreshAiBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.textContent = 'Refreshing…';
      const { data } = await postJson('/api/ai/refresh');
      if (data.state) applyState(data.state);
      btn.textContent = 'Refresh AI Model Catalog';
    });
  }

  function wireRetrain() {
    const btn = document.getElementById('retrainBtn');
    const status = document.getElementById('retrainStatus');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Training…';
      if (status) status.textContent = '';
      try {
        const { ok, data } = await postJson('/api/train');
        if (ok && data.state) applyState(data.state);
        if (status) status.textContent = ok ? 'Done -- takes effect on the next tick.' : 'Training failed -- see server console.';
      } catch (err) {
        if (status) status.textContent = 'Training request failed.';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Retrain Model Now';
      }
    });
  }

  connect();
  wireBotToggle();
  wireKillSwitch();
  wireSettingsToggle();
  wireRiskProfile();
  wirePairsApply();
  wireAiRefresh();
  wireRetrain();
})();
