/**
 * Headless OIDC login for the MELCloud Home mobile BFF.
 *
 * Flow: PAR (Pushed Authorization Request) -> IdentityServer authorize ->
 * AWS Cognito credential form -> callback -> token exchange (PKCE).
 *
 * Ported from the public reference implementation in
 * OlivierZal/melcloud-api (`src/api/token-auth.ts`), reworked to use the
 * global `fetch` and the local {@link CookieJar} so the plugin needs no extra
 * runtime dependency.
 *
 * @file home-oidc.ts
 * @license Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';

import { CookieJar } from './cookie-jar.js';

const CLIENT_ID = 'homemobile';
const REDIRECT_URI = 'melcloudhome://';
const SCOPES = 'openid profile email offline_access IdentityServerApi';
const AUTH_BASIC = 'Basic aG9tZW1vYmlsZTo=';
const AUTH_BASE_URL = 'https://auth.melcloudhome.com';
const COGNITO_AUTHORITY = 'https://live-melcloudhome.auth.eu-west-1.amazoncognito.com';
const PAR_PATH = '/connect/par';
const TOKEN_PATH = '/connect/token';
const MAX_REDIRECTS = 20;

/** Token bundle returned by the IdentityServer token endpoint. */
export interface HomeTokens {
  accessToken: string;
  refreshToken: string;
  /** Lifetime of the access token in seconds. */
  expiresIn: number;
}

interface RawResponse {
  body: string;
  status: number;
  location: string;
}

function generatePkce(): { challenge: string; verifier: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { challenge, verifier };
}

async function rawRequest(
  jar: CookieJar,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawResponse> {
  const cookie = jar.cookieHeader(url);
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(cookie === '' ? {} : { Cookie: cookie }) },
    ...(body === undefined ? {} : { body }),
  });
  jar.storeFromHeaders(response.headers, url);
  return { body: await response.text(), status: response.status, location: response.headers.get('location') ?? '' };
}

function resolveUrl(base: string, location: string): string {
  return location.startsWith('http') ? location : new URL(location, base).href;
}

function extractPageRedirect(html: string): string | null {
  const js = /window\.location\s*=\s*['"]([^'"]+)/u.exec(html)?.[1];
  if (js !== undefined) return js.split('&amp;').join('&');
  const meta = /<meta[^>]+http-equiv="refresh"[^>]+content="[^"]*url=([^"]+)/iu.exec(html)?.[1];
  return meta === undefined ? null : meta.split('&amp;').join('&');
}

async function followRedirects(jar: CookieJar, startUrl: string): Promise<{ body: string; url: string }> {
  let url = startUrl;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    if (url.startsWith(REDIRECT_URI)) return { body: '', url };
    const response = await rawRequest(jar, 'GET', url);
    if (response.status >= 300 && response.status < 400 && response.location !== '') {
      url = resolveUrl(url, response.location);
      continue;
    }
    const page = extractPageRedirect(response.body);
    if (page === null) return { body: response.body, url };
    url = resolveUrl(url, page);
  }
  throw new Error(`MELCloud Home OIDC: too many redirects (max ${String(MAX_REDIRECTS)})`);
}

function extractFormAction(html: string): string | null {
  const encoded = /<form[^>]+action="([^"]+)"/iu.exec(html)?.[1];
  if (encoded === undefined) return null;
  const action = encoded.split('&amp;').join('&');
  return action.startsWith('/') ? `${COGNITO_AUTHORITY}${action}` : action;
}

function extractHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [tag] of html.matchAll(/<input[^>]+type="hidden"[^>]*>/giu)) {
    const name = /name="([^"]+)"/u.exec(tag)?.[1];
    const value = /value="([^"]*)"/u.exec(tag)?.[1] ?? '';
    if (name !== undefined) fields[name] = value;
  }
  return fields;
}

async function par(challenge: string): Promise<string> {
  const response = await fetch(`${AUTH_BASE_URL}${PAR_PATH}`, {
    method: 'POST',
    headers: { Authorization: AUTH_BASIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES,
      state: randomBytes(16).toString('base64url'),
    }).toString(),
  });
  if (!response.ok) throw new Error(`MELCloud Home OIDC PAR failed (${String(response.status)})`);
  const data = (await response.json()) as { request_uri?: string };
  if (data.request_uri === undefined) throw new Error('MELCloud Home OIDC PAR: missing request_uri');
  return data.request_uri;
}

async function submitCredentials(jar: CookieJar, authorizeUrl: string, username: string, password: string): Promise<string> {
  const { body: html } = await followRedirects(jar, authorizeUrl);
  const action = extractFormAction(html);
  if (action === null) throw new Error('MELCloud Home OIDC: login form not found');
  const response = await rawRequest(
    jar,
    'POST',
    action,
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({ ...extractHiddenFields(html), cognitoAsfData: '', username, password }).toString(),
  );
  if (response.location === '') throw new Error('MELCloud Home: invalid credentials');
  return resolveUrl(action, response.location);
}

async function tokenRequest(params: Record<string, string>): Promise<HomeTokens> {
  const response = await fetch(`${AUTH_BASE_URL}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { Authorization: AUTH_BASIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) throw new Error(`MELCloud Home token exchange failed (${String(response.status)})`);
  const data = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (data.access_token === undefined) throw new Error('MELCloud Home token exchange: missing access_token');
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? '', expiresIn: data.expires_in ?? 3600 };
}

/**
 * Run the full headless OIDC login and return the token bundle.
 *
 * @param username - The MELCloud Home account email.
 * @param password - The MELCloud Home account password.
 * @returns The access/refresh token bundle.
 */
export async function performHomeLogin(username: string, password: string): Promise<HomeTokens> {
  const { challenge, verifier } = generatePkce();
  const jar = new CookieJar();
  const requestUri = await par(challenge);
  const authorizeUrl = `${AUTH_BASE_URL}/connect/authorize?client_id=${CLIENT_ID}&request_uri=${encodeURIComponent(requestUri)}`;
  const callbackUrl = await submitCredentials(jar, authorizeUrl, username, password);
  const { url } = await followRedirects(jar, callbackUrl);
  const code = new URL(url).searchParams.get('code');
  if (code === null) throw new Error('MELCloud Home OIDC: no authorization code in callback');
  return tokenRequest({
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * @param refreshToken - The stored refresh token.
 * @returns The refreshed token bundle, or `null` when the refresh failed.
 */
export async function refreshHomeTokens(refreshToken: string): Promise<HomeTokens | null> {
  try {
    return await tokenRequest({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken });
  } catch {
    return null;
  }
}
