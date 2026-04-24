/**
 * Daikin Onecta cloud client with Mobile App Authentication.
 *
 * Implements the Daikin Onecta authentication flow used by the official mobile
 * app (Gigya + OAuth2 PKCE). This avoids the Developer Portal limitations
 * (200 calls/day, manual redirect URI dance) and lets the user log in with
 * their normal Daikin email/password as documented in
 * `@mp-consulting/homebridge-daikin-cloud`.
 *
 * @file daikinClient.ts
 * @license Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';

import { AnsiLogger } from 'matterbridge/logger';

const HTTP_TIMEOUT_MS = 30000;
const TOKEN_FILE_MODE = 0o600;

const DAIKIN_MOBILE_CONFIG = {
  apiKey: '3_xRB3jaQ62bVjqXU1omaEsPDVYC0Twi1zfq1zHPu_5HFT0zWkDvZJS97Yw1loJnTm',
  clientId: 'FjS6T5oZHvzpZENIDybFRdtK',
  clientSecret: '_yWGLBGUnQFrN-u7uIOAZhSBsJOfcnBs0IS87wTgUvUmnLnEOs4NQmaKagqZBpQpG0XYl07KeCx8XHHKxAn24w',
  redirectUri: 'daikinunified://cdc/',
  gigyaBaseUrl: 'https://cdc.daikin.eu',
  idpTokenEndpoint: 'https://idp.onecta.daikineurope.com/v1/oidc/token',
  scope: 'openid onecta:onecta.application offline_access',
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
  email?: string;
  password?: string;
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
 * Daikin Onecta cloud client.
 */
export class DaikinClient {
  private tokenSet: TokenSet | null = null;
  private cookies = '';
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
    this.demo = !options.email || !options.password;
    this.tokenFile = options.tokenFile && options.tokenFile.length > 0 ? options.tokenFile : path.join(defaultTokenDir, 'daikin-onecta-tokens.json');
  }

  /**
   * Initialize the client. Loads cached tokens from disk; falls back to demo
   * mode when credentials are missing.
   *
   * @returns {Promise<void>} Resolves when the client is ready.
   */
  async initialize(): Promise<void> {
    if (this.demo) {
      this.log.warn('Daikin Onecta credentials missing — running in demo mode with a simulated device.');
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
    if (this.isAuthenticated()) {
      this.log.info(`Loaded cached Daikin Onecta tokens from ${this.tokenFile}`);
    } else {
      this.log.info('Authenticating to Daikin Onecta cloud (mobile app flow)...');
      try {
        await this.authenticate();
        this.log.info('Daikin Onecta authentication successful.');
      } catch (error) {
        this.log.error(`Daikin Onecta authentication failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
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
    if (!this.tokenSet) throw new Error('Not authenticated.');
    if (this.tokenSet.expires_at && this.tokenSet.expires_at < Math.floor(Date.now() / 1000) + 30) {
      if (!this.tokenSet.refresh_token) throw new Error('Token expired and no refresh token.');
      await this.refreshAccessToken();
    }
    return this.tokenSet!.access_token;
  }

  private async refreshAccessToken(): Promise<TokenSet> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const basicAuth = Buffer.from(`${DAIKIN_MOBILE_CONFIG.clientId}:${DAIKIN_MOBILE_CONFIG.clientSecret}`).toString('base64');
      const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.tokenSet!.refresh_token! });
      const response = await this.httpsRequest(
        DAIKIN_MOBILE_CONFIG.idpTokenEndpoint,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` } },
        params.toString(),
      );
      const result = JSON.parse(response.body) as TokenSet & { error?: string; error_description?: string };
      if (result.error) throw new Error(`Token refresh failed: ${result.error_description ?? result.error}`);
      this.storeTokenSet(result);
      return result;
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async authenticate(): Promise<TokenSet> {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const context = await this.getOidcContext(challenge);
    this.cookies = await this.initGigyaSdk(context);
    const loginToken = await this.gigyaLogin();
    const code = await this.authorizeWithToken(context, loginToken);
    const tokenSet = await this.exchangeCodeForTokens(code, verifier);
    this.storeTokenSet(tokenSet);
    return tokenSet;
  }

  private async getOidcContext(challenge: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: DAIKIN_MOBILE_CONFIG.clientId,
      redirect_uri: DAIKIN_MOBILE_CONFIG.redirectUri,
      response_type: 'code',
      scope: DAIKIN_MOBILE_CONFIG.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: crypto.randomBytes(16).toString('hex'),
    });
    const url = `${DAIKIN_MOBILE_CONFIG.gigyaBaseUrl}/oidc/op/v1.0/${DAIKIN_MOBILE_CONFIG.apiKey}/authorize?${params.toString()}`;
    const response = await this.httpsRequest(url, { method: 'GET' });
    if (response.statusCode === 302 && response.headers.location) {
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
      const match = location.match(/context=([^&]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    throw new Error('Failed to get OIDC context');
  }

  private async initGigyaSdk(context: string): Promise<string> {
    const proxyUrl = `https://id.daikin.eu/cdc/onecta/oidc/proxy.html?context=${encodeURIComponent(context)}&client_id=${DAIKIN_MOBILE_CONFIG.clientId}&mode=login&scope=${encodeURIComponent(DAIKIN_MOBILE_CONFIG.scope)}&gig_skipConsent=true`;
    const params = new URLSearchParams({
      apiKey: DAIKIN_MOBILE_CONFIG.apiKey,
      pageURL: proxyUrl,
      sdk: 'js_latest',
      sdkBuild: '18305',
      format: 'json',
    });
    const response = await this.httpsRequest(`${DAIKIN_MOBILE_CONFIG.gigyaBaseUrl}/accounts.webSdkBootstrap?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: '*/*', Origin: 'https://id.daikin.eu', Referer: 'https://id.daikin.eu/' },
    });
    const cookies: string[] = [];
    const setCookies = response.headers['set-cookie'];
    if (setCookies) {
      const cookieArray = Array.isArray(setCookies) ? setCookies : [setCookies];
      for (const cookie of cookieArray) {
        const match = cookie.match(/^([^=]+=[^;]+)/);
        if (match) cookies.push(match[1]);
      }
    }
    cookies.push(`gig_bootstrap_${DAIKIN_MOBILE_CONFIG.apiKey}=cdc_ver4`);
    return cookies.join('; ');
  }

  private gigyaSdkParams(): Record<string, string> {
    return {
      targetEnv: 'jssdk',
      include: 'profile,data,emails,subscriptions,preferences,',
      APIKey: DAIKIN_MOBILE_CONFIG.apiKey,
      source: 'showScreenSet',
      sdk: 'js_latest',
      authMode: 'cookie',
      pageURL: `https://id.daikin.eu/cdc/onecta/oidc/registration-login.html?gig_client_id=${DAIKIN_MOBILE_CONFIG.clientId}`,
      sdkBuild: '18305',
      format: 'json',
    };
  }

  private async gigyaLogin(): Promise<string> {
    const params = new URLSearchParams({
      ...this.gigyaSdkParams(),
      loginID: this.options.email!,
      password: this.options.password!,
      sessionExpiration: '31536000',
      includeUserInfo: 'true',
      loginMode: 'standard',
      lang: 'en',
    });
    const response = await this.httpsRequest(
      `${DAIKIN_MOBILE_CONFIG.gigyaBaseUrl}/accounts.login`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://id.daikin.eu',
          Referer: 'https://id.daikin.eu/',
          Cookie: this.cookies,
        },
      },
      params.toString(),
    );
    const result = JSON.parse(response.body) as {
      errorCode: number;
      errorMessage?: string;
      errorDetails?: string;
      sessionInfo?: { login_token?: string };
    };
    // 206001: Account Pending Registration, 206002: Account Pending Verification.
    // Daikin requires the account to be verified via a link sent by email; trigger the resend flow
    // like the Homebridge plugin does, then surface a clear, actionable error to the user.
    if (result.errorCode === 206001 || result.errorCode === 206002) {
      await this.resendVerificationEmail(this.options.email!);
      throw new Error(
        `Daikin account "${this.options.email}" is not verified. A verification email has been sent. ` +
          `Please click "Verify my account" in the email from Daikin, then restart Matterbridge.`,
      );
    }
    if (result.errorCode !== 0 || !result.sessionInfo?.login_token) {
      throw new Error(`Gigya login failed (${result.errorCode}): ${result.errorMessage ?? result.errorDetails ?? 'unknown error'}`);
    }
    return result.sessionInfo.login_token;
  }

  private async resendVerificationEmail(loginID: string): Promise<void> {
    try {
      const params = new URLSearchParams({
        ...this.gigyaSdkParams(),
        loginID,
        lang: 'en',
      });
      const response = await this.httpsRequest(
        `${DAIKIN_MOBILE_CONFIG.gigyaBaseUrl}/accounts.resendVerificationCode`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: 'https://id.daikin.eu',
            Referer: 'https://id.daikin.eu/',
            Cookie: this.cookies,
          },
        },
        params.toString(),
      );
      const result = JSON.parse(response.body) as { errorCode: number; errorMessage?: string };
      if (result.errorCode === 0) {
        this.log.warn(`Daikin sent a verification email to ${loginID}. Click "Verify my account", then restart Matterbridge.`);
      } else {
        this.log.warn(`Failed to resend Daikin verification email (${result.errorCode}): ${result.errorMessage ?? 'unknown error'}`);
      }
    } catch (error) {
      this.log.warn(`Failed to resend Daikin verification email: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async authorizeWithToken(context: string, loginToken: string): Promise<string> {
    const params = new URLSearchParams({ context, login_token: loginToken });
    const cookieStr = `${this.cookies}; glt_${DAIKIN_MOBILE_CONFIG.apiKey}=${loginToken}`;
    const url = `${DAIKIN_MOBILE_CONFIG.gigyaBaseUrl}/oidc/op/v1.0/${DAIKIN_MOBILE_CONFIG.apiKey}/authorize/continue?${params.toString()}`;
    const response = await this.httpsRequest(url, {
      method: 'GET',
      headers: { Cookie: cookieStr, Referer: 'https://id.daikin.eu/' },
    });
    if (response.statusCode === 302 && response.headers.location) {
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
      const match = location.match(/code=([^&]+)/);
      if (match) return match[1];
    }
    throw new Error('Failed to get authorization code');
  }

  private async exchangeCodeForTokens(code: string, verifier: string): Promise<TokenSet> {
    const basicAuth = Buffer.from(`${DAIKIN_MOBILE_CONFIG.clientId}:${DAIKIN_MOBILE_CONFIG.clientSecret}`).toString('base64');
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: DAIKIN_MOBILE_CONFIG.redirectUri,
      code_verifier: verifier,
    });
    const response = await this.httpsRequest(
      DAIKIN_MOBILE_CONFIG.idpTokenEndpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basicAuth}` } },
      params.toString(),
    );
    const result = JSON.parse(response.body) as TokenSet & { error?: string; error_description?: string };
    if (result.error) throw new Error(`Token exchange failed: ${result.error_description ?? result.error}`);
    return result;
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
    const url = `${DAIKIN_MOBILE_CONFIG.apiBaseUrl}/v1/gateway-devices/${device.id}/management-points/${device.embeddedId}/characteristics/${dataPoint}`;
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
    const response = await this.httpsRequest(`${DAIKIN_MOBILE_CONFIG.apiBaseUrl}${path}`, {
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
