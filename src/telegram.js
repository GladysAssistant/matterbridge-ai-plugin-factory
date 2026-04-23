/**
 * Thin Telegram notification helper.
 *
 * Required env vars:
 *   - TELEGRAM_BOT_TOKEN : bot token from @BotFather
 *   - TELEGRAM_CHAT_ID   : chat/user/group ID to send messages to
 *
 * If either is missing, sendTelegram() is a silent no-op so the factory
 * keeps working even without Telegram configured.
 *
 * Uses Node 18+ built-in fetch — no extra dependencies.
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Escape characters that have special meaning in Telegram MarkdownV2.
 */
function escapeMarkdownV2(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/**
 * Send a plain-text Telegram message. Never throws.
 * Returns true on success, false if not configured or on network error.
 */
async function sendTelegram(message, { parseMode = null } = {}) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    // Not configured — silently skip
    return false;
  }

  // Telegram has a 4096-char limit per message
  const text =
    message.length > 4000 ? message.slice(0, 3990) + "\n…(truncated)" : message;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) body.parse_mode = parseMode;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "<no body>");
      console.error(
        `⚠️  Telegram notification failed: ${res.status} ${errBody}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`⚠️  Telegram notification error: ${err.message}`);
    return false;
  }
}

/**
 * Convenience helpers with consistent emoji prefixes.
 */
async function notifyStart(jobName, details = "") {
  const msg = `🤖 *Factory* — ${jobName} started${details ? `\n${details}` : ""}`;
  return sendTelegram(msg);
}

async function notifySuccess(jobName, details = "") {
  const msg = `✅ *Factory* — ${jobName} succeeded${details ? `\n${details}` : ""}`;
  return sendTelegram(msg);
}

async function notifyFailure(jobName, error) {
  const errText =
    error instanceof Error ? `${error.message}` : String(error || "unknown");
  const msg = `❌ *Factory* — ${jobName} failed\n${errText}`;
  return sendTelegram(msg);
}

async function notifyInfo(jobName, details = "") {
  const msg = `ℹ️  *Factory* — ${jobName}${details ? `\n${details}` : ""}`;
  return sendTelegram(msg);
}

module.exports = {
  sendTelegram,
  notifyStart,
  notifySuccess,
  notifyFailure,
  notifyInfo,
  escapeMarkdownV2,
};
