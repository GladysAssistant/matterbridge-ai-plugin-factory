/**
 * Yoto Cloud API client.
 *
 * Implements OAuth2 device authorization flow, token refresh, device listing,
 * status polling and command sending. Real-time updates are handled separately
 * by {@link YotoMqtt}.
 *
 * Base URL: https://api.yotoplay.com
 */

import { AnsiLogger } from 'matterbridge/logger';

const BASE_URL = 'https://api.yotoplay.com';

export interface YotoTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface YotoDeviceInfo {
  deviceId: string;
  name: string;
  deviceType?: string;
  description?: string;
  online?: boolean;
}

/**
 * Status payload reported by the Yoto cloud for a device.
 * Fields are optional because not every model exposes every sensor.
 */
export interface YotoDeviceStatus {
  isOnline?: boolean;
  batteryLevelPercentage?: number;
  isCharging?: boolean;
  powerSource?: number; // 0=battery, 1=V2 dock, 2=USB-C, 3=Qi dock
  userVolumePercentage?: number;
  systemVolumePercentage?: number;
  activeCard?: string | null | { cardId?: string; title?: string };
  cardInsertionState?: number; // 0=none, 1=physical, 2=remote
  nightlightMode?: string; // hex color or 'off'
  dayMode?: number; // -1 unknown, 0 night, 1 day
  ambientLightSensorReading?: number;
  temperatureCelcius?: number; // sic from API
  wifiStrength?: number;
  isBluetoothAudioConnected?: boolean;
  isAudioDeviceConnected?: boolean;
  isPlaying?: boolean;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
}

export interface TokenPersist {
  saveTokens(tokens: YotoTokens): Promise<void>;
}

/**
 * Yoto cloud API client.
 */
export class YotoApi {
  private readonly log: AnsiLogger;
  private readonly clientId: string;
  private tokens: YotoTokens | null;
  private readonly persist: TokenPersist;

  constructor(log: AnsiLogger, clientId: string, tokens: YotoTokens | null, persist: TokenPersist) {
    this.log = log;
    this.clientId = clientId;
    this.tokens = tokens;
    this.persist = persist;
  }

  hasTokens(): boolean {
    return !!(this.tokens && this.tokens.accessToken && this.tokens.refreshToken);
  }

  getTokens(): YotoTokens | null {
    return this.tokens;
  }

  /**
   * Begin the OAuth2 device authorization flow.
   */
  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const res = await fetch(`${BASE_URL}/oauth/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, scope: 'openid offline_access profile family:devices:control' }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`device/code failed: ${res.status} ${body}`);
    }
    return (await res.json()) as DeviceCodeResponse;
  }

  /**
   * Poll the token endpoint until the user authorizes or the device code expires.
   * Returns the resulting tokens once granted.
   */
  async pollForToken(deviceCode: string, intervalSeconds: number, expiresInSeconds: number): Promise<YotoTokens> {
    const deadline = Date.now() + expiresInSeconds * 1000;
    let delay = Math.max(intervalSeconds, 5) * 1000;
    while (Date.now() < deadline) {
      await sleep(delay);
      const res = await fetch(`${BASE_URL}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: this.clientId,
        }),
      });
      if (res.ok) {
        const tokenRes = (await res.json()) as TokenResponse;
        return this.storeTokenResponse(tokenRes);
      }
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      if (errBody.error === 'authorization_pending') {
        continue;
      }
      if (errBody.error === 'slow_down') {
        delay += 5000;
        continue;
      }
      throw new Error(`Token poll failed: ${res.status} ${JSON.stringify(errBody)}`);
    }
    throw new Error('Device authorization timed out — please re-start the plugin and re-authorize.');
  }

  /**
   * Exchange the refresh token for a fresh access token.
   */
  async refresh(): Promise<YotoTokens> {
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token available');
    }
    const res = await fetch(`${BASE_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
        client_id: this.clientId,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token refresh failed: ${res.status} ${body}`);
    }
    return this.storeTokenResponse((await res.json()) as TokenResponse);
  }

  private async storeTokenResponse(tokenRes: TokenResponse): Promise<YotoTokens> {
    const expiresAt = Date.now() + Math.max(60, tokenRes.expires_in - 60) * 1000;
    this.tokens = {
      accessToken: tokenRes.access_token,
      refreshToken: tokenRes.refresh_token ?? this.tokens?.refreshToken ?? '',
      expiresAt,
    };
    await this.persist.saveTokens(this.tokens);
    return this.tokens;
  }

  private async ensureFreshToken(): Promise<string> {
    if (!this.tokens) throw new Error('Not authenticated');
    if (Date.now() >= this.tokens.expiresAt - 30_000) {
      this.log.debug('Access token expired, refreshing…');
      await this.refresh();
    }
    return this.tokens.accessToken;
  }

  private async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.ensureFreshToken();
    const headers = {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    let res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
    if (res.status === 401) {
      this.log.debug('401 from Yoto API, refreshing token and retrying…');
      await this.refresh();
      const retryHeaders = { ...headers, Authorization: `Bearer ${this.tokens!.accessToken}` };
      res = await fetch(`${BASE_URL}${path}`, { ...init, headers: retryHeaders });
    }
    return res;
  }

  /**
   * List all Yoto devices on the authenticated account.
   */
  async listDevices(): Promise<YotoDeviceInfo[]> {
    const res = await this.authedFetch('/device-v2/devices/mine');
    if (!res.ok) {
      // Some accounts use /device-v2 directly.
      const alt = await this.authedFetch('/device-v2');
      if (!alt.ok) {
        throw new Error(`listDevices failed: ${res.status}`);
      }
      return parseDeviceList(await alt.json());
    }
    return parseDeviceList(await res.json());
  }

  /**
   * Fetch the latest status snapshot for a device.
   */
  async getStatus(deviceId: string): Promise<YotoDeviceStatus> {
    const res = await this.authedFetch(`/device-v2/${encodeURIComponent(deviceId)}/status`);
    if (!res.ok) {
      throw new Error(`getStatus failed: ${res.status}`);
    }
    const body = (await res.json()) as { status?: YotoDeviceStatus } & YotoDeviceStatus;
    return body.status ?? body;
  }

  /**
   * Send a command to a device via the cloud bridge.
   * Body matches the MQTT command format expected by the player.
   */
  async sendCommand(deviceId: string, command: Record<string, unknown>): Promise<void> {
    const res = await this.authedFetch(`/device-v2/${encodeURIComponent(deviceId)}/command/status`, {
      method: 'POST',
      body: JSON.stringify(command),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`sendCommand failed: ${res.status} ${body}`);
    }
  }

  /**
   * Update device config (volume, day/night, nightlight color, …).
   */
  async updateConfig(deviceId: string, config: Record<string, unknown>): Promise<void> {
    const res = await this.authedFetch(`/device-v2/${encodeURIComponent(deviceId)}/config`, {
      method: 'POST',
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`updateConfig failed: ${res.status} ${body}`);
    }
  }
}

function parseDeviceList(payload: unknown): YotoDeviceInfo[] {
  if (Array.isArray(payload)) return payload as YotoDeviceInfo[];
  const obj = payload as { devices?: YotoDeviceInfo[] };
  return obj.devices ?? [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
