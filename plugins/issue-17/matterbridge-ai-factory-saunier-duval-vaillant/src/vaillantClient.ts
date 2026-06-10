/**
 * Minimal client for the myVAILLANT / MiGo (Saunier Duval) cloud API.
 *
 * Implements the Keycloak PKCE OAuth flow and the small subset of the
 * service-connected-control API needed to read zone state and control
 * heating operation mode and setpoint.
 *
 * @file vaillantClient.ts
 * @license Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';

import { AnsiLogger } from 'matterbridge/logger';

const AUTH_BASE = 'https://identity.vaillant-group.com/auth/realms';
const API_BASE = 'https://api.vaillant-group.com/service-connected-control/end-user-app-api/v1';
const CLIENT_ID = 'myvaillant';
const REDIRECT_URI = 'enduservaillant.page.link://login';
const SUBSCRIPTION_KEY = '1e0a2f3511fb4c5bbb1c7f9fedd20b1c';

/** Vaillant heating operation modes. */
export type OperationMode = 'OFF' | 'MANUAL' | 'TIME_CONTROLLED';

/** Logical device status exposed by the plugin. */
export type ZoneStatus = 'off' | 'program' | 'manual' | 'away';

/** Parsed state of a single heating zone. */
export interface ZoneState {
  index: number;
  name: string;
  currentTemperature: number | null;
  setpoint: number | null;
  humidity: number | null;
  status: ZoneStatus;
}

/** Parsed state of a whole heating system. */
export interface SystemState {
  systemId: string;
  outdoorTemperature: number | null;
  zones: ZoneState[];
}

/** Credentials / connection options. */
export interface VaillantOptions {
  username: string;
  password: string;
  country: string; // e.g. "germany", "france"
  brand: string; // "vaillant" | "sdbg" | "bulex" | "glow-worm" | "demirdokum"
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Cloud API client. */
export class VaillantClient {
  private readonly opts: VaillantOptions;
  private readonly log: AnsiLogger;
  private accessToken = '';
  private refreshToken = '';
  private expiresAt = 0;

  /**
   * @param {VaillantOptions} opts - Credentials and connection options.
   * @param {AnsiLogger} log - Logger instance.
   */
  constructor(opts: VaillantOptions, log: AnsiLogger) {
    this.opts = opts;
    this.log = log;
  }

  private get realm(): string {
    return `${this.opts.brand}-${this.opts.country.toLowerCase()}-b2c`;
  }

  private apiHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-app-identifier': 'VAILLANT',
      'x-idm-identifier': 'KEYCLOAK',
      'ocp-apim-subscription-key': SUBSCRIPTION_KEY,
    };
  }

  /**
   * Perform the full PKCE login flow and store the tokens.
   *
   * @returns {Promise<void>} Resolves when authenticated.
   */
  async login(): Promise<void> {
    const codeVerifier = base64Url(randomBytes(32));
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());

    const authUrl =
      `${AUTH_BASE}/${this.realm}/protocol/openid-connect/auth?` +
      new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: REDIRECT_URI,
      }).toString();

    // 1. Get the login form to obtain the form action URL and session cookies.
    const authResp = await fetch(authUrl, { redirect: 'manual' });
    const html = await authResp.text();
    const cookies = authResp.headers.get('set-cookie') ?? '';
    const actionMatch = html.match(/action="([^"]+)"/);
    if (!actionMatch) throw new Error('Could not find login form action (check brand/country)');
    const loginUrl = actionMatch[1].replace(/&amp;/g, '&');

    // 2. Submit credentials. Keycloak answers with a 302 to the redirect_uri carrying the code.
    const loginResp = await fetch(loginUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
      body: new URLSearchParams({ username: this.opts.username, password: this.opts.password, credentialId: '' }).toString(),
    });
    const location = loginResp.headers.get('location') ?? '';
    const codeMatch = location.match(/[?&]code=([^&]+)/);
    if (!codeMatch) throw new Error('Login failed: no authorization code returned (check credentials)');

    // 3. Exchange the code for tokens.
    await this.exchange({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: decodeURIComponent(codeMatch[1]),
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    });
    this.log.info('Vaillant cloud authenticated');
  }

  private async exchange(params: Record<string, string>): Promise<void> {
    const resp = await fetch(`${AUTH_BASE}/${this.realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    if (!resp.ok) throw new Error(`Token request failed: ${resp.status}`);
    const data = (await resp.json()) as { access_token: string; refresh_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token;
    this.expiresAt = Date.now() + (data.expires_in - 30) * 1000;
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken) {
      await this.login();
      return;
    }
    if (Date.now() >= this.expiresAt) {
      try {
        await this.exchange({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: this.refreshToken });
      } catch {
        await this.login();
      }
    }
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureToken();
    const resp = await fetch(`${API_BASE}${path}`, {
      method,
      headers: this.apiHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`${method} ${path} failed: ${resp.status}`);
    const text = await resp.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Discover all systems (homes) on the account.
   *
   * @returns {Promise<string[]>} List of system ids.
   */
  async getSystemIds(): Promise<string[]> {
    const homes = await this.api<Array<{ systemId?: string; system_id?: string }>>('GET', '/homes');
    return homes.map((h) => h.systemId ?? h.system_id ?? '').filter(Boolean);
  }

  /**
   * Read and parse the full state of a system.
   *
   * @param {string} systemId - The system id.
   * @returns {Promise<SystemState>} Parsed system state.
   */
  async getSystemState(systemId: string): Promise<SystemState> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await this.api<any>('GET', `/systems/${systemId}/tli`);
    const state = raw.state ?? raw;
    const zonesRaw: unknown[] = state?.zones ?? raw?.zones ?? [];
    const propsZones: unknown[] = raw?.properties?.zones ?? [];

    const zones: ZoneState[] = zonesRaw.map((z, i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const zo = z as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pz = (propsZones[i] as any) ?? {};
      const mode: string = zo.heating?.operationMode ?? zo.operationMode ?? 'OFF';
      const special: string = zo.currentSpecialFunction ?? state?.system?.currentSpecialFunction ?? 'NONE';
      let status: ZoneStatus = 'off';
      if (special === 'HOLIDAY' || special === 'AWAY') status = 'away';
      else if (mode === 'TIME_CONTROLLED') status = 'program';
      else if (mode === 'MANUAL') status = 'manual';
      else status = 'off';
      return {
        index: pz.index ?? zo.index ?? i,
        name: pz.name ?? zo.name ?? `Zone ${i + 1}`,
        currentTemperature: num(zo.currentRoomTemperature ?? zo.currentTemperature),
        setpoint: num(zo.desiredRoomTemperatureSetpoint ?? zo.heating?.manualModeSetpoint ?? zo.setpoint),
        humidity: num(zo.currentRoomHumidity ?? zo.humidity),
        status,
      };
    });

    return {
      systemId,
      outdoorTemperature: num(state?.system?.outdoorTemperature ?? raw?.system?.outdoorTemperature),
      zones,
    };
  }

  /**
   * Set the heating operation mode of a zone.
   *
   * @param {string} systemId - The system id.
   * @param {number} zoneIndex - The zone index.
   * @param {OperationMode} mode - The desired operation mode.
   * @returns {Promise<void>} Resolves when applied.
   */
  async setOperationMode(systemId: string, zoneIndex: number, mode: OperationMode): Promise<void> {
    await this.api('PATCH', `/systems/${systemId}/zones/${zoneIndex}/heating-operation-mode`, { operationMode: mode });
  }

  /**
   * Set the manual-mode heating setpoint of a zone.
   *
   * @param {string} systemId - The system id.
   * @param {number} zoneIndex - The zone index.
   * @param {number} setpoint - The desired temperature in °C.
   * @returns {Promise<void>} Resolves when applied.
   */
  async setSetpoint(systemId: string, zoneIndex: number, setpoint: number): Promise<void> {
    await this.api('PATCH', `/systems/${systemId}/zones/${zoneIndex}/manual-mode-setpoint`, { setpoint, type: 'HEATING' });
  }

  /**
   * Enable away (holiday) mode for the whole system.
   *
   * @param {string} systemId - The system id.
   * @param {number} days - Number of days to stay away.
   * @returns {Promise<void>} Resolves when applied.
   */
  async setAway(systemId: string, days = 30): Promise<void> {
    const start = new Date();
    const end = new Date(start.getTime() + days * 86400000);
    await this.api('POST', `/systems/${systemId}/away-mode`, { startDateTime: start.toISOString(), endDateTime: end.toISOString() });
  }

  /**
   * Cancel away (holiday) mode for the whole system.
   *
   * @param {string} systemId - The system id.
   * @returns {Promise<void>} Resolves when applied.
   */
  async cancelAway(systemId: string): Promise<void> {
    await this.api('DELETE', `/systems/${systemId}/away-mode`);
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
