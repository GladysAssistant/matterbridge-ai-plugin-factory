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
 * Escape HTML special characters for Telegram HTML parse mode.
 * Telegram only requires escaping `<`, `>` and `&` in text nodes.
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
 *
 * `details` may contain one or more of the following pseudo-tags that will
 * be converted to proper Telegram HTML formatting:
 *   - {b}...{/b}    → bold
 *   - {i}...{/i}    → italic
 *   - {code}...{/code} → inline code
 *   - {link:URL}TEXT{/link} → hyperlink
 * All other text is HTML-escaped automatically.
 */
function formatDetails(raw) {
  if (!raw) return "";
  // Split on our pseudo-tags while preserving them
  const tokens = raw.split(
    /(\{b\}|\{\/b\}|\{i\}|\{\/i\}|\{code\}|\{\/code\}|\{link:[^}]+\}|\{\/link\})/,
  );
  let out = "";
  const stack = [];
  for (const tok of tokens) {
    if (tok === "{b}") {
      out += "<b>";
      stack.push("b");
    } else if (tok === "{/b}") {
      out += "</b>";
      stack.pop();
    } else if (tok === "{i}") {
      out += "<i>";
      stack.push("i");
    } else if (tok === "{/i}") {
      out += "</i>";
      stack.pop();
    } else if (tok === "{code}") {
      out += "<code>";
      stack.push("code");
    } else if (tok === "{/code}") {
      out += "</code>";
      stack.pop();
    } else if (tok.startsWith("{link:")) {
      const url = tok.slice(6, -1);
      out += `<a href="${escapeHtml(url)}">`;
      stack.push("a");
    } else if (tok === "{/link}") {
      out += "</a>";
      stack.pop();
    } else {
      out += escapeHtml(tok);
    }
  }
  return out;
}

async function notifyStart(jobName, details = "") {
  const msg = `🤖 <b>Factory</b> — ${escapeHtml(jobName)} started${details ? `\n${formatDetails(details)}` : ""}`;
  return sendTelegram(msg, { parseMode: "HTML" });
}

async function notifySuccess(jobName, details = "") {
  const msg = `✅ <b>Factory</b> — ${escapeHtml(jobName)} succeeded${details ? `\n${formatDetails(details)}` : ""}`;
  return sendTelegram(msg, { parseMode: "HTML" });
}

async function notifyFailure(jobName, error) {
  const errText =
    error instanceof Error ? `${error.message}` : String(error || "unknown");
  const msg = `❌ <b>Factory</b> — ${escapeHtml(jobName)} failed\n<code>${escapeHtml(errText)}</code>`;
  return sendTelegram(msg, { parseMode: "HTML" });
}

async function notifyInfo(jobName, details = "") {
  const msg = `ℹ️ <b>Factory</b> — ${escapeHtml(jobName)}${details ? `\n${formatDetails(details)}` : ""}`;
  return sendTelegram(msg, { parseMode: "HTML" });
}

module.exports = {
  sendTelegram,
  notifyStart,
  notifySuccess,
  notifyFailure,
  notifyInfo,
  escapeMarkdownV2,
};
