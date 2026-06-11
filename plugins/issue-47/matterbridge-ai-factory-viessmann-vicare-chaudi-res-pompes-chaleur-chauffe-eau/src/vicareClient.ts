/**
 * Viessmann ViCare IoT API client (OAuth2 Authorization Code + PKCE / refresh token).
 *
 * @file vicareClient.ts
 * @license Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';

import { AnsiLogger } from 'matterbridge/logger';

/** Default Viessmann Climate Solutions endpoints. */
export const VICARE_IAM_BASE = 'https://iam.viessmann-climatesolutions.com/idp/v3';
export const VICARE_API_BASE = 'https://api.viessmann-climatesolutions.com/iot/v2';
export const VICARE_REDIRECT_URI = 'vicare://oauth-callback/everest';

/** A single ViCare feature data point as returned by the API. */
export interface ViCareFeature {
  feature: string;
  isEnabled: boolean;
  isReady: boolean;
  properties: Record<string, { type: string; value: unknown; unit?: string }>;
  commands: Record<string, { uri: string; isExecutable: boolean; params: Record<string, unknown> }>;
}

/** A ViCare device (boiler, heat pump, gateway, ventilation, ...). */
export interface ViCareDevice {
  installationId: number;
  gatewaySerial: string;
  deviceId: string;
  modelId: string;
  deviceType: string;
  features: Map<string, ViCareFeature>;
}

/** Tokens persisted between runs. */
export interface ViCareTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/** PKCE pair for the interactive authorization flow. */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  authorizeUrl: string;
}

/**
 * Build a PKCE code verifier/challenge and the authorize URL.
 *
 * @param {string} clientId - The registered ViCare client id.
 * @param {string} redirectUri - The redirect URI registered for the client.
 * @returns {PkcePair} The PKCE pair and the authorize URL to open in a browser/app.
 */
export function buildPkceAuthorizeUrl(clientId: string, redirectUri: string = VICARE_REDIRECT_URI): PkcePair {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: 'IoT User offline_access',
  });
  return { codeVerifier, codeChallenge, authorizeUrl: `${VICARE_IAM_BASE}/authorize?${params.toString()}` };
}

/** ViCare REST API client with automatic token refresh. */
export class ViCareClient {
  private tokens: ViCareTokens | null = null;

  constructor(
    private readonly clientId: string,
    private readonly log: AnsiLogger,
    private readonly apiBase: string = VICARE_API_BASE,
    private readonly iamBase: string = VICARE_IAM_BASE,
  ) {}

  /**
   * Seed the client with an existing refresh token (and optional access token).
   *
   * @param {string} refreshToken - The OAuth2 refresh token from a prior login.
   * @param {string} [accessToken] - An optional still-valid access token.
   * @param {number} [expiresAt] - Epoch ms when the access token expires.
   * @returns {void}
   */
  setTokens(refreshToken: string, accessToken = '', expiresAt = 0): void {
    this.tokens = { refreshToken, accessToken, expiresAt };
  }

  /**
   * Get the current refresh token (to persist it across restarts).
   *
   * @returns {string | undefined} The refresh token, if any.
   */
  getRefreshToken(): string | undefined {
    return this.tokens?.refreshToken;
  }

  /**
   * Exchange an authorization code (PKCE) for tokens.
   *
   * @param {string} code - The authorization code from the redirect.
   * @param {string} codeVerifier - The PKCE code verifier used to build the request.
   * @param {string} redirectUri - The redirect URI used in the authorize request.
   * @returns {Promise<ViCareTokens>} The obtained tokens.
   */
  async exchangeCode(code: string, codeVerifier: string, redirectUri: string = VICARE_REDIRECT_URI): Promise<ViCareTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      code,
    });
    return this.requestToken(body);
  }

  /**
   * Ensure a valid (non-expired) access token, refreshing if needed.
   *
   * @returns {Promise<string>} A valid access token.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new Error('ViCare: no tokens configured. Provide a refreshToken in the plugin config.');
    if (this.tokens.accessToken && Date.now() < this.tokens.expiresAt - 60_000) return this.tokens.accessToken;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: this.tokens.refreshToken,
    });
    const t = await this.requestToken(body);
    return t.accessToken;
  }

  /**
   * Perform an authenticated GET against the ViCare API.
   *
   * @param {string} path - The API path (relative to the API base).
   * @returns {Promise<any>} The parsed JSON response.
   */
  async apiGet(path: string): Promise<any> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiBase}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`ViCare GET ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  /**
   * Execute a ViCare feature command.
   *
   * @param {string} commandUri - The absolute command URI from the feature definition.
   * @param {Record<string, unknown>} payload - The command body.
   * @returns {Promise<void>} Resolves when the command completes.
   */
  async executeCommand(commandUri: string, payload: Record<string, unknown>): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(commandUri, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`ViCare command ${commandUri} failed: ${res.status} ${await res.text()}`);
  }

  /**
   * Discover all installations, gateways and devices, including their features.
   *
   * @returns {Promise<ViCareDevice[]>} The list of discovered devices.
   */
  async discoverDevices(): Promise<ViCareDevice[]> {
    const devices: ViCareDevice[] = [];
    const installations = (await this.apiGet('/equipment/installations?includeGateways=true')).data ?? [];
    for (const inst of installations) {
      const installationId: number = inst.id;
      const gateways = inst.gateways ?? (await this.apiGet(`/equipment/installations/${installationId}/gateways`)).data ?? [];
      for (const gw of gateways) {
        const gatewaySerial: string = gw.serial;
        const devList = gw.devices ?? (await this.apiGet(`/equipment/installations/${installationId}/gateways/${gatewaySerial}/devices`)).data ?? [];
        for (const dev of devList) {
          if (dev.deviceType === 'gateway' || dev.deviceType === 'vitoconnect') continue;
          const device: ViCareDevice = {
            installationId,
            gatewaySerial,
            deviceId: String(dev.id),
            modelId: dev.modelId ?? dev.deviceType ?? 'ViCare',
            deviceType: dev.deviceType ?? 'heating',
            features: new Map(),
          };
          await this.loadFeatures(device);
          devices.push(device);
        }
      }
    }
    return devices;
  }

  /**
   * Refresh the feature/data-point map of a device in place.
   *
   * @param {ViCareDevice} device - The device to refresh.
   * @returns {Promise<void>} Resolves when features are loaded.
   */
  async loadFeatures(device: ViCareDevice): Promise<void> {
    const path = `/features/installations/${device.installationId}/gateways/${device.gatewaySerial}/devices/${device.deviceId}/features`;
    const data = (await this.apiGet(path)).data ?? [];
    device.features.clear();
    for (const f of data as ViCareFeature[]) device.features.set(f.feature, f);
  }

  /**
   * Request tokens from the IAM token endpoint and store them.
   *
   * @param {URLSearchParams} body - The form-encoded request body.
   * @returns {Promise<ViCareTokens>} The obtained tokens.
   */
  private async requestToken(body: URLSearchParams): Promise<ViCareTokens> {
    const res = await fetch(`${this.iamBase}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`ViCare token request failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    this.tokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? this.tokens?.refreshToken ?? '',
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    this.log.debug(`ViCare token refreshed, expires in ${json.expires_in}s`);
    return this.tokens;
  }
}

/**
 * Read a numeric property value from a feature.
 *
 * @param {ViCareDevice} device - The device holding the features.
 * @param {string} feature - The feature id.
 * @param {string} [prop] - The property name (default 'value').
 * @returns {number | undefined} The numeric value, if present.
 */
export function getNumber(device: ViCareDevice, feature: string, prop = 'value'): number | undefined {
  const v = device.features.get(feature)?.properties?.[prop]?.value;
  return typeof v === 'number' ? v : undefined;
}

/**
 * Read a string property value from a feature.
 *
 * @param {ViCareDevice} device - The device holding the features.
 * @param {string} feature - The feature id.
 * @param {string} [prop] - The property name (default 'value').
 * @returns {string | undefined} The string value, if present.
 */
export function getString(device: ViCareDevice, feature: string, prop = 'value'): string | undefined {
  const v = device.features.get(feature)?.properties?.[prop]?.value;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Read a boolean property value from a feature.
 *
 * @param {ViCareDevice} device - The device holding the features.
 * @param {string} feature - The feature id.
 * @param {string} [prop] - The property name (default 'active').
 * @returns {boolean | undefined} The boolean value, if present.
 */
export function getBoolean(device: ViCareDevice, feature: string, prop = 'active'): boolean | undefined {
  const v = device.features.get(feature)?.properties?.[prop]?.value;
  return typeof v === 'boolean' ? v : undefined;
}
