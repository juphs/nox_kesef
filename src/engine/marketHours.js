/**
 * marketHours.js
 * --------------
 * Forex trades ~24h/day Monday-Friday, closed on weekends: opens Sunday
 * 22:00 UTC (Sydney session) and closes Friday 22:00 UTC (New York
 * session close). The real boundary shifts to 21:00 UTC during northern-
 * hemisphere summer DST -- this uses the simpler, fixed 22:00 UTC
 * boundary year-round, which is accurate to within an hour around DST
 * transitions. Good enough for a dashboard "MARKET OPEN/CLOSED" indicator
 * and a trading gate; not a substitute for checking Deriv's own contract
 * availability, which the bot always does anyway via the proposal call.
 */

const CLOSE_HOUR_UTC = 22;

function isForexMarketOpen(date = new Date()) {
  const day = date.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const hour = date.getUTCHours();

  if (day === 6) return false; // Saturday: always closed
  if (day === 0) return hour >= CLOSE_HOUR_UTC; // Sunday: opens at 22:00 UTC
  if (day === 5) return hour < CLOSE_HOUR_UTC; // Friday: closes at 22:00 UTC
  return true; // Monday-Thursday: open
}

module.exports = { isForexMarketOpen };
