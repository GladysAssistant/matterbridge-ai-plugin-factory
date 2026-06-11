/**
 * Errors and heuristics for Claude Code CLI quota / usage limit exhaustion.
 */

class CreditsExhaustedError extends Error {
  constructor(message, output = "") {
    super(message);
    this.name = "CreditsExhaustedError";
    this.output = output;
  }
}

const USAGE_LIMIT_PATTERNS = [
  /you'?ve hit your session limit/i,
  /session limit/i,
  /usage limit/i,
  /rate.?limit/i,
  /out of credits/i,
  /credit balance/i,
  /quota exceeded/i,
  /exceeded.*limit/i,
  /too many requests/i,
  /\b429\b/,
  /billing/i,
  /subscription.*limit/i,
  /upgrade your plan/i,
  /wait until.*reset/i,
  /capacity.*reached/i,
  /limit reached/i,
  /not enough credits/i,
  /weekly limit/i,
  /try again later/i,
];

/**
 * Return true if CLI output indicates credits/quota/session limit exhaustion.
 */
function detectCreditsExhausted(text) {
  if (!text) return false;
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Parse "resets 7am (UTC)" from Claude limit messages → ms until resume.
 * Returns null if not parseable.
 */
function parseUsageLimitResumeMs(text, now = new Date()) {
  if (!text) return null;

  let hours;
  let minutes = 0;
  let ampm = "";

  const withMinutesAmPm = text.match(
    /resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/i,
  );
  const compactAmPm = text.match(/resets\s+(\d{1,2})(am|pm)\s*\(UTC\)/i);
  const twentyFourHour = text.match(/resets\s+(\d{1,2}):(\d{2})\s*\(UTC\)/i);

  if (withMinutesAmPm) {
    hours = parseInt(withMinutesAmPm[1], 10);
    minutes = parseInt(withMinutesAmPm[2], 10);
    ampm = withMinutesAmPm[3].toLowerCase();
  } else if (compactAmPm) {
    hours = parseInt(compactAmPm[1], 10);
    ampm = compactAmPm[2].toLowerCase();
  } else if (twentyFourHour) {
    hours = parseInt(twentyFourHour[1], 10);
    minutes = parseInt(twentyFourHour[2], 10);
  } else {
    return null;
  }

  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const reset = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hours,
      minutes,
      0,
    ),
  );
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }

  const ms = reset.getTime() - now.getTime();
  // At least 5 min, at most 24h
  if (ms < 5 * 60 * 1000 || ms > 24 * 60 * 60 * 1000) return null;
  return ms;
}

module.exports = {
  CreditsExhaustedError,
  detectCreditsExhausted,
  parseUsageLimitResumeMs,
};
