/**
 * Minimal VeSync cloud API client (reverse-engineered, based on pyvesync).
 *
 * @file vesync.ts
 * @license Apache-2.0
 */

import { createHash } from 'node:crypto';

import { AnsiLogger } from 'matterbridge/logger';

const BASE_URL = 'https://smartapi.vesync.com';
const APP_VERSION = '2.8.6';
const PHONE_BRAND = 'SM N9005';
const PHONE_OS = 'Android';
const MOBILE_ID = '1234567890123456';
const USER_TYPE = '1';

/** A device returned by the VeSync cloud. */
export interface VeSyncDevice {
  cid: string;
  uuid: string;
  deviceName: string;
  deviceType: string;
  deviceStatus: string; // 'on' | 'off'
  connectionStatus: string;
  configModule: string;
  deviceRegion?: string;
  subDeviceNo?: number;
  type?: string; // e.g. 'wifi-switch', 'Outlet', 'fan', 'humidifier'
}

/** Categories used to map a VeSync device to Matter device types. */
export type VeSyncCategory = 'outlet' | 'purifier' | 'humidifier' | 'fan' | 'switch' | 'unknown';

/** Normalized live state of a device. */
export interface VeSyncState {
  on: boolean;
  power?: number; // W
  voltage?: number; // V
  energy?: number; // kWh
  mode?: string; // auto | sleep | manual | normal
  fanSpeed?: number; // 1..3
  maxFanSpeed?: number;
  airQuality?: number; // PM2.5 ug/m3
  filterLife?: number; // %
  humidity?: number; // % ambient
  targetHumidity?: number; // %
  mist?: number; // mist level
  nightLightBrightness?: number; // 0..100
}

/**
 * Lightweight VeSync cloud client.
 */
export class VeSyncClient {
  private token = '';
  private accountId = '';
  private readonly tz: string;

  /**
   * @param {string} username - VeSync account email.
   * @param {string} password - VeSync account password.
   * @param {AnsiLogger} log - Logger.
   * @param {string} timeZone - IANA time zone.
   */
  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: AnsiLogger,
    timeZone = 'America/New_York',
  ) {
    this.tz = timeZone;
  }

  /** @returns {boolean} Whether the client holds a session token. */
  get authenticated(): boolean {
    return this.token !== '' && this.accountId !== '';
  }

  private hashPassword(): string {
    return createHash('md5').update(this.password).digest('hex');
  }

  private baseBody(): Record<string, unknown> {
    return {
      timeZone: this.tz,
      acceptLanguage: 'en',
      appVersion: APP_VERSION,
      phoneBrand: PHONE_BRAND,
      phoneOS: PHONE_OS,
      traceId: Date.now().toString(),
    };
  }

  private authBody(): Record<string, unknown> {
    return {
      ...this.baseBody(),
      accountID: this.accountId,
      token: this.token,
    };
  }

  private async post<T>(path: string, body: Record<string, unknown>, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'User-Agent': 'okhttp/3.12.1',
        'tk': this.token,
        'accountId': this.accountId,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`VeSync ${path} HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Authenticate against the VeSync cloud.
   *
   * @returns {Promise<void>} Resolves when a token has been obtained.
   */
  async login(): Promise<void> {
    const body = {
      ...this.baseBody(),
      email: this.username,
      password: this.hashPassword(),
      devToken: '',
      userType: USER_TYPE,
      method: 'login',
    };
    const json = await this.post<{ code: number; msg?: string; result?: { token: string; accountID: string } }>('/cloud/v1/user/login', body);
    if (json.code !== 0 || !json.result?.token) {
      throw new Error(`VeSync login failed: ${json.msg ?? 'code ' + json.code}`);
    }
    this.token = json.result.token;
    this.accountId = json.result.accountID;
    this.log.info('VeSync login successful');
  }

  /**
   * List all devices on the account.
   *
   * @returns {Promise<VeSyncDevice[]>} The devices.
   */
  async getDevices(): Promise<VeSyncDevice[]> {
    const body = { ...this.authBody(), method: 'devices', pageNo: '1', pageSize: '100' };
    const json = await this.post<{ code: number; result?: { list?: VeSyncDevice[] } }>('/cloud/v1/deviceManaged/devices', body);
    return json.result?.list ?? [];
  }

  /**
   * Classify a device into a Matter-friendly category.
   *
   * @param {VeSyncDevice} d - The device.
   * @returns {VeSyncCategory} The category.
   */
  static categorize(d: VeSyncDevice): VeSyncCategory {
    const t = `${d.deviceType} ${d.type ?? ''}`.toLowerCase();
    if (/humid|oasis|classic|dual|600s|300s/.test(t)) return 'humidifier';
    if (/air|purif|core|lap-|lv-|vital/.test(t)) return 'purifier';
    if (/outlet|wifi-switch|esw|plug/.test(t)) return 'outlet';
    if (/fan|tower/.test(t)) return 'fan';
    if (/switch|wall|dimmer/.test(t)) return 'switch';
    return 'unknown';
  }

  /**
   * Fetch the live state for a device.
   *
   * @param {VeSyncDevice} d - The device.
   * @param {VeSyncCategory} cat - Its category.
   * @returns {Promise<VeSyncState>} The normalized state.
   */
  async getState(d: VeSyncDevice, cat: VeSyncCategory): Promise<VeSyncState> {
    const state: VeSyncState = { on: d.deviceStatus === 'on' };
    try {
      if (cat === 'outlet' || cat === 'switch') {
        const body = { ...this.authBody(), uuid: d.uuid };
        const json = await this.post<{ result?: Record<string, unknown> } & Record<string, unknown>>('/cloud/v1/deviceManaged/v2/deviceDetail', body);
        const r = (json.result ?? json) as Record<string, unknown>;
        if (typeof r.deviceStatus === 'string') state.on = r.deviceStatus === 'on';
        if (typeof r.power !== 'undefined') state.power = parseFloat(String(r.power));
        if (typeof r.voltage !== 'undefined') state.voltage = parseFloat(String(r.voltage));
        if (typeof r.energy !== 'undefined') state.energy = parseFloat(String(r.energy));
        if (typeof r.nightLightBrightness !== 'undefined') state.nightLightBrightness = Number(r.nightLightBrightness);
      } else {
        const body = {
          ...this.authBody(),
          cid: d.cid,
          configModule: d.configModule,
          deviceRegion: d.deviceRegion ?? 'US',
          payload: { method: 'getPurifierStatus', source: 'APP', data: {} },
        };
        const json = await this.post<{ result?: { result?: Record<string, unknown> } }>('/cloud/v2/deviceManaged/bypassV2', body);
        const r = json.result?.result ?? {};
        if (typeof r.enabled === 'boolean') state.on = r.enabled;
        if (typeof r.mode === 'string') state.mode = r.mode;
        if (typeof r.level === 'number') state.fanSpeed = r.level;
        if (typeof r.air_quality_value === 'number') state.airQuality = r.air_quality_value;
        if (typeof r.air_quality === 'number') state.airQuality = state.airQuality ?? r.air_quality;
        if (typeof r.filter_life === 'number') state.filterLife = r.filter_life;
        if (typeof r.humidity === 'number') state.humidity = r.humidity;
        if (typeof r.target_humidity === 'number') state.targetHumidity = r.target_humidity;
        if (typeof r.mist_virtual_level === 'number') state.mist = r.mist_virtual_level;
      }
    } catch (err) {
      this.log.debug(`getState failed for ${d.deviceName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return state;
  }

  /**
   * Turn a device on or off.
   *
   * @param {VeSyncDevice} d - The device.
   * @param {VeSyncCategory} cat - Its category.
   * @param {boolean} on - Desired power state.
   * @returns {Promise<void>} Resolves when the request completes.
   */
  async setPower(d: VeSyncDevice, cat: VeSyncCategory, on: boolean): Promise<void> {
    if (cat === 'outlet' || cat === 'switch') {
      const body = { ...this.authBody(), uuid: d.uuid, status: on ? 'on' : 'off' };
      await this.post('/cloud/v1/deviceManaged/v2/deviceStatus', body, 'PUT');
    } else {
      const body = {
        ...this.authBody(),
        cid: d.cid,
        configModule: d.configModule,
        deviceRegion: d.deviceRegion ?? 'US',
        payload: { method: 'setSwitch', source: 'APP', data: { enabled: on, id: 0 } },
      };
      await this.post('/cloud/v2/deviceManaged/bypassV2', body, 'POST');
    }
  }

  /**
   * Set fan speed level (purifier/fan/humidifier mist).
   *
   * @param {VeSyncDevice} d - The device.
   * @param {number} level - Target level (1..max).
   * @returns {Promise<void>} Resolves when the request completes.
   */
  async setFanSpeed(d: VeSyncDevice, level: number): Promise<void> {
    const body = {
      ...this.authBody(),
      cid: d.cid,
      configModule: d.configModule,
      deviceRegion: d.deviceRegion ?? 'US',
      payload: { method: 'setLevel', source: 'APP', data: { level, id: 0, type: 'wind' } },
    };
    await this.post('/cloud/v2/deviceManaged/bypassV2', body, 'POST');
  }

  /**
   * Set the operating mode (auto | sleep | manual).
   *
   * @param {VeSyncDevice} d - The device.
   * @param {string} mode - Target mode.
   * @returns {Promise<void>} Resolves when the request completes.
   */
  async setMode(d: VeSyncDevice, mode: string): Promise<void> {
    const body = {
      ...this.authBody(),
      cid: d.cid,
      configModule: d.configModule,
      deviceRegion: d.deviceRegion ?? 'US',
      payload: { method: 'setPurifierMode', source: 'APP', data: { mode } },
    };
    await this.post('/cloud/v2/deviceManaged/bypassV2', body, 'POST');
  }

  /**
   * Set target humidity for a humidifier.
   *
   * @param {VeSyncDevice} d - The device.
   * @param {number} humidity - Target humidity %.
   * @returns {Promise<void>} Resolves when the request completes.
   */
  async setTargetHumidity(d: VeSyncDevice, humidity: number): Promise<void> {
    const body = {
      ...this.authBody(),
      cid: d.cid,
      configModule: d.configModule,
      deviceRegion: d.deviceRegion ?? 'US',
      payload: { method: 'setTargetHumidity', source: 'APP', data: { target_humidity: humidity } },
    };
    await this.post('/cloud/v2/deviceManaged/bypassV2', body, 'POST');
  }
}
