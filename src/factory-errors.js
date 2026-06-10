/**
 * Errors and heuristics for Claude Code CLI quota / credit exhaustion.
 */

class CreditsExhaustedError extends Error {
  constructor(message, output = "") {
    super(message);
    this.name = "CreditsExhaustedError";
    this.output = output;
  }
}

const CREDIT_EXHAUSTION_PATTERNS = [
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
  /session limit/i,
  /try again later/i,
];

/**
 * Return true if the given CLI output likely indicates credits/quota exhaustion
 * rather than a generic build or coding failure.
 */
function detectCreditsExhausted(text) {
  if (!text) return false;
  return CREDIT_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = {
  CreditsExhaustedError,
  detectCreditsExhausted,
};
