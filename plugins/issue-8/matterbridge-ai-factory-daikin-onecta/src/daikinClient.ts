/**
 * Daikin Onecta cloud client using the official Developer Portal API.
 *
 * Uses the official OAuth2 authentication described at
 * https://developer.cloud.daikineurope.com. Users register an application,
 * complete the authorization code flow once, and provide the resulting
 * `clientId`, `clientSecret`, and `refreshToken` to this plugin. The plugin
 * then uses the refresh token to obtain short-lived access tokens for the
 * Onecta API.
 *
 * @file daikinClient.ts
 * @license Apache-2.0
 */

import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';

import { AnsiLogger } from 'matterbridge/logger';

const HTTP_TIMEOUT_MS = 30000;
const TOKEN_FILE_MODE = 0o600;

const DAIKIN_API = {
  idpTokenEndpoint: 'https://idp.onecta.daikineurope.com/v1/oidc/token',
  apiBaseUrl: 'https://api.onecta.daikineurope.com',
} as const;

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  expires_at?: number;
  scope?: string;
}

export interface DaikinDevice {
  id: string;
  name: string;
  model?: string;
  power: boolean;
  mode: 'heating' | 'cooling' | 'auto' | 'off';
  indoorTemperature: number;
  heatingSetpoint: number;
  coolingSetpoint: number;
  embeddedId: string;
}

export interface DaikinClientOptions {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  tokenFile?: string;
}

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface ManagementPoint {
  embeddedId: string;
  managementPointType: string;
  name?: { value?: string };
  modelInfo?: { value?: string };
  onOffMode?: { value?: string };
  operationMode?: { value?: string };
  temperatureControl?: {
    value?: {
      operationModes?: Record<
        string,
        { setpoints?: Record<string, { value?: number }> }
      >;
    };
  };
  sensoryData?: { value?: { roomTemperature?: { value?: number } } };
}

interface GatewayDevice {
  id: string;
  deviceModel?: string;
  managementPoints?: ManagementPoint[];
}

/**
 * Daikin Onecta cloud client using the official Developer Portal OAuth2 flow.
 */
export class DaikinClient {
  private tokenSet: TokenSet | null = null;
  private refreshPromise: Promise<TokenSet> | null = null;
  private readonly demo: boolean;
  private readonly devices = new Map<string, DaikinDevice>();
  private readonly tokenFile: string;

  /**
   * @param {DaikinClientOptions} options - Client options.
   * @param {AnsiLogger} log - Logger.
   * @param {string} defaultTokenDir - Default directory used when `tokenFile` is not provided.
   */
  constructor(
    private readonly options: DaikinClientOptions,
    private readonly log: AnsiLogger,
    defaultTokenDir: string,
  ) {
    this.demo = !options.clientId || !options.clientSecret || !options.refreshToken;
    this.tokenFile = options.tokenFile && options.tokenFile.length > 0 ? options.tokenFile : path.join(defaultTokenDir, 'daikin-onecta-tokens.json');
  }

  /**
   * Initialize the client. Loads cached tokens from disk; falls back to demo
   * mode when API credentials are missing.
   *
   * @returns {Promise<void>} Resolves when the client is ready.
   */
  async initialize(): Promise<void> {
    if (this.demo) {
      this.log.warn('Daikin Onecta API credentials missing — running in demo mode with a simulated device.');
      this.log.warn('Register an app at https://developer.cloud.daikineurope.com and provide clientId, clientSecret and refreshToken in the plugin config.');
      this.devices.set('demo-ac', {
        id: 'demo-ac',
        name: 'Daikin Living Room',
        model: 'Onecta Demo AC',
        power: false,
        mode: 'off',
        indoorTemperature: 22,
        heatingSetpoint: 21,
        coolingSetpoint: 25,
        embeddedId: 'climateControl',
      });
      return;
    }

    this.loadTokenFromFile();
    // Seed in-memory token set with the configured refresh token if no cached
    // token is available (or if the cache lacks a refresh token).
    if (!this.tokenSet?.refresh_token) {
      this.tokenSet = { access_token: '', refresh_token: this.options.refreshToken, expires_at: 0 };
    }

    try {
      this.log.info('Authenticating to Daikin Onecta cloud (Developer Portal API)...');
      await this.refreshAccessToken();
      this.log.info('Daikin Onecta authentication successful.');
    } catch (error) {
      this.log.error(`Daikin Onecta authentication failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await this.loadDevices();
  }

  /**
   * Returns the list of devices currently known to the client.
   *
   * @returns {Promise<DaikinDevice[]>} List of devices.
   */
  async getDevices(): Promise<DaikinDevice[]> {
    if (!this.demo && this.isAuthenticated() && this.devices.size === 0) {
      await this.loadDevices();
    }
    return Array.from(this.devices.values());
  }

  /**
   * Toggles the power state of the given device.
   *
   * @param {string} id - Device id.
   * @param {boolean} power - Desired power state.
   * @returns {Promise<void>} Resolves when the request completes.
   */
  async setPower(id: string, power: boolean): Promise<void> {
    const device = this.devices.get(id);
    if (!device) return;
    device.power = power;
    if (!power) device.mode = 'off';
    if (this.demo) return;
    await this.patchDevice(device, 'onOffMode', power ? 'on' : 'off');
  }

  /**
   * Sets the operation mode of the given device.
   *
   * @param {string} id - Device id.
   * @param {'heating' | 'cooling' | 'auto' | 'off'} mode - Desired mode.
   * @returns {Promise<void>} Resolves when the request completes.
   */
  async setMode(id: string, mode: 'heating' | 'cooling' | 'auto' | 'off'): Promise<void> {
    const device = this.devices.get(id);
    if (!device) return;
    device.mode = mode;
    device.power = mode !== 'off';
    if (this.demo) return;
    if (mode === 'off') {
      await this.patchDevice(device, 'onOffMode', 'off');
      return;
    }
    await this.patchDevice(device, 'onOffMode', 'on');
    await this.patchDevice(device, 'operationMode', mode);
  }

  /**
   * Sets the heating or cooling setpoint of the given device.
   *
   * @param {string} id - Device id.
   * @param {'heating' | 'cooling'} kind - Setpoint kind.
   * @param {number} celsius - Setpoint value in Celsius.
   * @returns {Promise<void>} Resolves when the request completes.
   */
  async setSetpoint(id: string, kind: 'heating' | 'cooling', celsius: number): Promise<void> {
    const device = this.devices.get(id);
    if (!device) return;
    if (kind === 'heating') device.heatingSetpoint = celsius;
    else device.coolingSetpoint = celsius;
    if (this.demo) return;
    const dataPath = `/operationModes/${kind}/setpoints/roomTemperature`;
    await this.patchDevice(device, 'temperatureControl', celsius, dataPath);
  }

  /**
   * Refresh the in-memory device snapshot from the Daikin cloud.
   *
   * @returns {Promise<void>} Resolves when the snapshot has been refreshed.
   */
  async refresh(): Promise<void> {
    if (this.demo) return;
    if (!this.isAuthenticated()) return;
    await this.loadDevices();
  }

  // =====================================================================
  // Auth
  // =====================================================================

  /**
   * Whether the client currently has a valid (non-expired) access token.
   *
   * @returns {boolean} True when authenticated.
   */
  isAuthenticated(): boolean {
    if (!this.tokenSet?.access_token) return false;
    if (!this.tokenSet.expires_at) return true;
    return this.tokenSet.expires_at > Math.floor(Date.now() / 1000) + 30;
  }

  private async getAccessToken(): Promise<string> {
    if (!this.tokenSet?.refresh_token) throw new Error('Not authenticated.');
    if (!this.tokenSet.access_token || (this.tokenSet.expires_at && this.tokenSet.expires_at < Math.floor(Date.now() / 1000) + 30)) {
      await this.refreshAccessToken();
    }
    return this.tokenSet.access_token;
  }

  private async refreshAccessToken(): Promise<TokenSet> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      if (!this.tokenSet?.refresh_token) throw new Error('No refresh token configured.');
      const basicAuth = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64');
      const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.tokenSet.refresh_token });
      const response = await this.httpsRequest(
        DAIKIN_API.idpTokenEndpoint,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` } },
        params.toString(),
      );
      let result: TokenSet & { error?: string; error_description?: string };
      try {
        result = JSON.parse(response.body) as TokenSet & { error?: string; error_description?: string };
      } catch {
        throw new Error(`Token refresh failed (HTTP ${response.statusCode}): ${response.body}`);
      }
      if (result.error || response.statusCode >= 400) {
        throw new Error(`Token refresh failed: ${result.error_description ?? result.error ?? `HTTP ${response.statusCode}`}`);
      }
      // Preserve the existing refresh token if Daikin does not rotate it.
      if (!result.refresh_token) result.refresh_token = this.tokenSet!.refresh_token;
      this.storeTokenSet(result);
      return result;
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  // =====================================================================
  // Token persistence
  // =====================================================================

  private storeTokenSet(tokenSet: TokenSet): void {
    if (tokenSet.expires_in && !tokenSet.expires_at) {
      tokenSet.expires_at = Math.floor(Date.now() / 1000) + tokenSet.expires_in;
    }
    this.tokenSet = tokenSet;
    try {
      fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
      fs.writeFileSync(this.tokenFile, JSON.stringify(tokenSet, null, 2), { encoding: 'utf8', mode: TOKEN_FILE_MODE });
    } catch (error) {
      this.log.warn(`Failed to persist Daikin token file ${this.tokenFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private loadTokenFromFile(): void {
    try {
      if (!fs.existsSync(this.tokenFile)) return;
      const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')) as TokenSet;
      if (data && typeof data.access_token === 'string') {
        this.tokenSet = data;
      }
    } catch {
      // ignore corrupt token file
    }
  }

  // =====================================================================
  // Devices
  // =====================================================================

  private async loadDevices(): Promise<void> {
    try {
      const gateways = await this.apiRequest<GatewayDevice[]>('/v1/gateway-devices');
      this.devices.clear();
      for (const gateway of gateways ?? []) {
        const climate = (gateway.managementPoints ?? []).find((p) => p.managementPointType === 'climateControl');
        if (!climate) continue;
        const tempControl = climate.temperatureControl?.value?.operationModes ?? {};
        const heating = tempControl.heating?.setpoints?.roomTemperature?.value;
        const cooling = tempControl.cooling?.setpoints?.roomTemperature?.value;
        const indoor = climate.sensoryData?.value?.roomTemperature?.value;
        const opMode = (climate.operationMode?.value ?? 'off').toLowerCase();
        const power = (climate.onOffMode?.value ?? 'off') === 'on';
        const mode: DaikinDevice['mode'] = power ? this.normalizeMode(opMode) : 'off';
        this.devices.set(gateway.id, {
          id: gateway.id,
          name: climate.name?.value ?? `Daikin ${gateway.id.slice(0, 6)}`,
          model: gateway.deviceModel ?? climate.modelInfo?.value,
          power,
          mode,
          indoorTemperature: typeof indoor === 'number' ? indoor : 22,
          heatingSetpoint: typeof heating === 'number' ? heating : 21,
          coolingSetpoint: typeof cooling === 'number' ? cooling : 25,
          embeddedId: climate.embeddedId,
        });
      }
      this.log.info(`Discovered ${this.devices.size} Daikin Onecta climate device(s).`);
    } catch (error) {
      this.log.error(`Failed to load Daikin devices: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private normalizeMode(mode: string): DaikinDevice['mode'] {
    if (mode === 'heating') return 'heating';
    if (mode === 'cooling') return 'cooling';
    if (mode === 'auto') return 'auto';
    return 'off';
  }

  private async patchDevice(device: DaikinDevice, dataPoint: string, value: unknown, dataPath?: string): Promise<void> {
    const url = `${DAIKIN_API.apiBaseUrl}/v1/gateway-devices/${device.id}/management-points/${device.embeddedId}/characteristics/${dataPoint}`;
    const body = JSON.stringify(dataPath ? { value, path: dataPath } : { value });
    const accessToken = await this.getAccessToken();
    const response = await this.httpsRequest(
      url,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
      body,
    );
    if (response.statusCode >= 400) {
      throw new Error(`Daikin API PATCH ${dataPoint} failed (${response.statusCode}): ${response.body}`);
    }
  }

  private async apiRequest<T>(path: string): Promise<T> {
    const accessToken = await this.getAccessToken();
    const response = await this.httpsRequest(`${DAIKIN_API.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (response.statusCode === 401 && this.tokenSet?.refresh_token) {
      await this.refreshAccessToken();
      return this.apiRequest<T>(path);
    }
    if (response.statusCode >= 400) {
      throw new Error(`Daikin API GET ${path} failed (${response.statusCode}): ${response.body}`);
    }
    return JSON.parse(response.body) as T;
  }

  // =====================================================================
  // HTTP helper
  // =====================================================================

  private httpsRequest(url: string, options: { method: string; headers?: Record<string, string> }, postData?: string): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (postData) headers['Content-Length'] = Buffer.byteLength(postData).toString();
      const req = https.request(
        {
          hostname: urlObj.hostname,
          port: 443,
          path: urlObj.pathname + urlObj.search,
          method: options.method,
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data }));
        },
      );
      req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error(`Request timed out after ${HTTP_TIMEOUT_MS}ms`)));
      req.on('error', reject);
      if (postData) req.write(postData);
      req.end();
    });
  }
}
