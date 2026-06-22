/**
 * Minimal cross-domain cookie jar for the MELCloud Home OIDC redirect chain.
 *
 * The headless OIDC login bounces between `auth.melcloudhome.com` and the AWS
 * Cognito host, so cookies must be tracked per host. This is intentionally a
 * tiny subset of RFC 6265 (no expiry, no secure/samesite handling) — enough to
 * carry the session cookies through the redirect chain without pulling in a
 * dependency.
 *
 * @file cookie-jar.ts
 * @license Apache-2.0
 */

interface StoredCookie {
  value: string;
  domain: string;
}

/** A naive host-scoped cookie store. */
export class CookieJar {
  readonly #cookies = new Map<string, StoredCookie>();

  /**
   * Store one `Set-Cookie` header value, scoped against the request URL.
   *
   * @param raw - The raw `Set-Cookie` header value.
   * @param url - The URL the cookie was received from.
   */
  setCookie(raw: string, url: string): void {
    const [pair, ...attrs] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let domain = safeHost(url);
    for (const attr of attrs) {
      const [k, v] = attr.split('=');
      if (k.trim().toLowerCase() === 'domain' && v) {
        domain = v.trim().replace(/^\./u, '').toLowerCase();
      }
    }
    this.#cookies.set(`${domain}|${name}`, { value, domain });
  }

  /**
   * Store every `Set-Cookie` header from a fetch `Headers` object.
   *
   * @param headers - The response headers.
   * @param url - The URL the response came from.
   */
  storeFromHeaders(headers: Headers, url: string): void {
    const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const raw of setCookies) {
      this.setCookie(raw, url);
    }
  }

  /**
   * Build the `Cookie` request header for the given URL.
   *
   * @param url - The target URL.
   * @returns The `Cookie` header value, or an empty string when none apply.
   */
  cookieHeader(url: string): string {
    const host = safeHost(url);
    const parts: string[] = [];
    for (const [key, cookie] of this.#cookies) {
      if (host === cookie.domain || host.endsWith(`.${cookie.domain}`)) {
        parts.push(`${key.split('|').slice(1).join('|')}=${cookie.value}`);
      }
    }
    return parts.join('; ');
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}
