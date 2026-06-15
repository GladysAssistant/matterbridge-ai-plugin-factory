/**
 * Minimal Withings Cloud API client (OAuth2 Authorization Code flow).
 *
 * @file withingsClient.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';

/** OAuth2 + API base endpoints. */
const OAUTH_URL = 'https://wbsapi.withings.net/v2/oauth2';
const AUTHORIZE_URL = 'https://account.withings.com/oauth2_user/authorize2';
/** Scopes requested for the Withings integration. */
const SCOPE = 'user.info,user.metrics,user.activity';
const MEASURE_URL = 'https://wbsapi.withings.net/measure';
const USER_URL = 'https://wbsapi.withings.net/v2/user';
const SLEEP_URL = 'https://wbsapi.withings.net/v2/sleep';

/** Persisted OAuth tokens. */
export interface WithingsTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds when the access token expires. */
  expiresAt: number;
}

/** A physical Withings device returned by getdevice. */
export interface WithingsDevice {
  deviceid: string;
  type: string;
  model: string;
  battery?: string;
}

/** Withings measure type ids. */
export const MeasType = {
  weight: 1, // kg
  height: 4, // m
  fatMass: 8, // kg
  fatRatio: 6, // %
  muscleMass: 76, // kg
  diastolic: 9, // mmHg
  systolic: 10, // mmHg
  heartRate: 11, // bpm
  temperature: 12, // °C
  bodyTemperature: 71, // °C
  spo2: 54, // %
} as const;

/** Wraps the raw Withings cloud API with automatic token refresh. */
export class WithingsClient {
  private tokens: WithingsTokens;

  /**
   * @param {string} clientId - Withings application client id.
   * @param {string} clientSecret - Withings application client secret.
   * @param {WithingsTokens} tokens - Initial OAuth tokens.
   * @param {AnsiLogger} log - Logger instance.
   * @param {(tokens: WithingsTokens) => void} [onTokens] - Callback invoked when tokens are refreshed so the caller can persist them.
   */
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    tokens: WithingsTokens,
    private readonly log: AnsiLogger,
    private readonly onTokens?: (tokens: WithingsTokens) => void,
  ) {
    this.tokens = tokens;
  }

  /**
   * Returns the current tokens (for persistence).
   *
   * @returns {WithingsTokens} The current OAuth tokens.
   */
  getTokens(): WithingsTokens {
    return this.tokens;
  }

  /**
   * Ensures a valid access token, refreshing it when expired.
   *
   * @returns {Promise<string>} A valid access token.
   */
  private async ensureToken(): Promise<string> {
    if (this.tokens.accessToken && Date.now() / 1000 < this.tokens.expiresAt - 60) {
      return this.tokens.accessToken;
    }
    return this.refreshToken();
  }

  /**
   * Builds the Withings OAuth2 authorization URL the user must open to obtain an authorization code.
   *
   * @param {string} clientId - Withings application client id.
   * @param {string} redirectUri - The redirect URI registered with the Withings app.
   * @param {string} [state] - Opaque state value echoed back on the redirect.
   * @returns {string} The fully built authorize URL.
   */
  static buildAuthorizeUrl(clientId: string, redirectUri: string, state = 'matterbridge'): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: SCOPE,
      redirect_uri: redirectUri,
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  /**
   * Exchanges an OAuth2 authorization code for an access token and refresh token.
   *
   * This performs the initial step of the Authorization Code flow so the user
   * does not have to obtain the refresh token manually.
   *
   * @param {string} clientId - Withings application client id.
   * @param {string} clientSecret - Withings application client secret.
   * @param {string} code - Authorization code returned on the redirect URI.
   * @param {string} redirectUri - The redirect URI registered with the Withings app.
   * @param {AnsiLogger} log - Logger instance.
   * @returns {Promise<WithingsTokens>} The obtained tokens.
   */
  static async exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string, log: AnsiLogger): Promise<WithingsTokens> {
    log.debug('Exchanging Withings authorization code for tokens');
    const params = new URLSearchParams({
      action: 'requesttoken',
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    const res = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const json = (await res.json()) as { status: number; body?: { access_token: string; refresh_token: string; expires_in: number }; error?: string };
    if (json.status !== 0 || !json.body) {
      throw new Error(`Withings authorization code exchange failed: status=${json.status} ${json.error ?? ''}`);
    }
    return {
      accessToken: json.body.access_token,
      refreshToken: json.body.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + json.body.expires_in,
    };
  }

  /**
   * Exchanges the refresh token for a new access token.
   *
   * @returns {Promise<string>} The new access token.
   */
  async refreshToken(): Promise<string> {
    this.log.debug('Refreshing Withings access token');
    const params = new URLSearchParams({
      action: 'requesttoken',
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.tokens.refreshToken,
    });
    const res = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const json = (await res.json()) as { status: number; body?: { access_token: string; refresh_token: string; expires_in: number }; error?: string };
    if (json.status !== 0 || !json.body) {
      throw new Error(`Withings token refresh failed: status=${json.status} ${json.error ?? ''}`);
    }
    this.tokens = {
      accessToken: json.body.access_token,
      refreshToken: json.body.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + json.body.expires_in,
    };
    this.onTokens?.(this.tokens);
    return this.tokens.accessToken;
  }

  /**
   * Performs an authenticated GET-style request to the Withings API.
   *
   * @param {string} url - Endpoint url.
   * @param {Record<string, string>} params - Request parameters.
   * @returns {Promise<unknown>} The `body` field of the API response.
   */
  private async request(url: string, params: Record<string, string>): Promise<unknown> {
    const token = await this.ensureToken();
    const body = new URLSearchParams(params).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` },
      body,
    });
    const json = (await res.json()) as { status: number; body?: unknown; error?: string };
    if (json.status !== 0) {
      throw new Error(`Withings API error: status=${json.status} ${json.error ?? ''}`);
    }
    return json.body;
  }

  /**
   * Lists the user's physical Withings devices.
   *
   * @returns {Promise<WithingsDevice[]>} The user's devices.
   */
  async getDevices(): Promise<WithingsDevice[]> {
    const body = (await this.request(USER_URL, { action: 'getdevice' })) as { devices?: WithingsDevice[] };
    return body.devices ?? [];
  }

  /**
   * Fetches the latest value for each requested measure type.
   *
   * @param {number[]} meastypes - Withings measure type ids.
   * @returns {Promise<Map<number, number>>} Map of measure type id to latest real value.
   */
  async getLatestMeasures(meastypes: number[]): Promise<Map<number, number>> {
    const body = (await this.request(MEASURE_URL, {
      action: 'getmeas',
      meastypes: meastypes.join(','),
      category: '1',
    })) as { measuregrps?: { date: number; measures: { value: number; type: number; unit: number }[] }[] };

    const result = new Map<number, number>();
    const latestDate = new Map<number, number>();
    for (const grp of body.measuregrps ?? []) {
      for (const m of grp.measures) {
        if (!latestDate.has(m.type) || grp.date > (latestDate.get(m.type) as number)) {
          latestDate.set(m.type, grp.date);
          result.set(m.type, m.value * Math.pow(10, m.unit));
        }
      }
    }
    return result;
  }

  /**
   * Fetches the most recent sleep summary.
   *
   * @returns {Promise<{ durationMin?: number; quality?: number } | undefined>} Sleep duration in minutes and a 0-100 quality score.
   */
  async getSleepSummary(): Promise<{ durationMin?: number; quality?: number } | undefined> {
    const today = new Date();
    const start = new Date(today.getTime() - 2 * 24 * 3600 * 1000);
    const fmt = (d: Date): string => d.toISOString().slice(0, 10);
    const body = (await this.request(SLEEP_URL, {
      action: 'getsummary',
      startdateymd: fmt(start),
      enddateymd: fmt(today),
      data_fields: 'total_sleep_time,sleep_score',
    })) as { series?: { data: { total_sleep_time?: number; sleep_score?: number } }[] };

    const last = body.series?.[body.series.length - 1]?.data;
    if (!last) return undefined;
    return {
      durationMin: last.total_sleep_time !== undefined ? Math.round(last.total_sleep_time / 60) : undefined,
      quality: last.sleep_score,
    };
  }
}
