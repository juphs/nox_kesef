/**
 * newsFeed.js
 * -----------
 * Free, keyless data sources feeding the NEWS_SENTIMENT and
 * CORRELATION_ANALYSIS AI functions.
 *
 *   - ForexFactory economic calendar (community JSON mirror, no auth):
 *       https://nfs.faireconomy.media/ff_calendar_thisweek.json
 *   - Frankfurter (frankfurter.dev) -- free, keyless ECB reference rates,
 *     used as a lightweight cross-pair correlation baseline.
 *
 * Both fail soft (return the last-known-good, possibly-empty structure) so
 * a flaky free API never takes the trading loop down with it.
 */

const FOREXFACTORY_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest';
const HTTP_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = {
  calendar: { data: [], fetchedAt: 0 },
  rates: { data: {}, fetchedAt: 0, base: null },
};

async function fetchJson(url, params) {
  const u = new URL(url);
  if (params) Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getForexFactoryCalendar() {
  const now = Date.now();
  if (now - cache.calendar.fetchedAt < CACHE_TTL_MS) return cache.calendar.data;
  try {
    const events = await fetchJson(FOREXFACTORY_URL);
    cache.calendar = { data: events, fetchedAt: now };
    return events;
  } catch (err) {
    return cache.calendar.data;
  }
}

async function eventsForCurrency(currency) {
  const events = await getForexFactoryCalendar();
  return events.filter((e) => String(e.country || '').toUpperCase() === currency.toUpperCase());
}

async function getReferenceRates(base = 'USD') {
  const now = Date.now();
  if (now - cache.rates.fetchedAt < CACHE_TTL_MS && cache.rates.base === base) return cache.rates.data;
  try {
    const data = await fetchJson(FRANKFURTER_URL, { base });
    cache.rates = { data, fetchedAt: now, base };
    return data;
  } catch (err) {
    return cache.rates.data;
  }
}

async function newsContextForSymbol(symbol) {
  const base = symbol.slice(0, 3);
  const quote = symbol.slice(3, 6);
  const [baseEvents, quoteEvents] = await Promise.all([eventsForCurrency(base), eventsForCurrency(quote)]);
  return { symbol, baseEvents, quoteEvents };
}

module.exports = { getForexFactoryCalendar, eventsForCurrency, getReferenceRates, newsContextForSymbol };
