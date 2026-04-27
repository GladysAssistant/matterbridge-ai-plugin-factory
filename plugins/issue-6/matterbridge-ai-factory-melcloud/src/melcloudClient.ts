/**
 * Minimal MELCloud REST client.
 *
 * @file melcloudClient.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';

const BASE_URL = 'https://app.melcloud.com/Mitsubishi.Wifi.Client';

export interface MelCloudDevice {
  DeviceID: number;
  DeviceName: string;
  BuildingID: number;
  Device: {
    DeviceType: number;
    Power: boolean;
    OperationMode: number;
    SetTemperature: number;
    RoomTemperature: number;
    MinTempAutomatic?: number;
    MaxTempAutomatic?: number;
    MinTempCoolDry?: number;
    MaxTempCoolDry?: number;
    MinTempHeat?: number;
    MaxTempHeat?: number;
    Units?: Array<{ Model?: string | null }>;
  };
}

export interface MelCloudState {
  Power: boolean;
  OperationMode: number;
  SetTemperature: number;
  RoomTemperature: number;
  EffectiveFlags?: number;
  HasPendingCommand?: boolean;
  [key: string]: unknown;
}

export const OP_MODE = {
  HEAT: 1,
  DRY: 2,
  COOL: 3,
  FAN: 7,
  AUTO: 8,
} as const;

/**
 * Lightweight client for the MELCloud HTTP API.
 */
export class MelCloudClient {
  private contextKey: string | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: AnsiLogger,
  ) {}

  private headers(): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:73.0)',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.5',
      'X-MitsContextKey': this.contextKey ?? '',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: 'policyaccepted=true',
      'Content-Type': 'application/json',
    };
  }

  /**
   * Login to MELCloud and capture the context key.
   *
   * @returns {Promise<boolean>} true on success.
   */
  async login(): Promise<boolean> {
    const body = {
      Email: this.username,
      Password: this.password,
      Language: 0,
      AppVersion: '1.19.1.1',
      Persist: true,
      CaptchaResponse: null,
    };
    const res = await fetch(`${BASE_URL}/Login/ClientLogin`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      this.log.error(`MELCloud login HTTP error: ${res.status}`);
      return false;
    }
    const json = (await res.json()) as { ErrorId: number | null; LoginData?: { ContextKey: string } };
    if (json.ErrorId) {
      this.log.error(`MELCloud login error: ${JSON.stringify(json)}`);
      return false;
    }
    this.contextKey = json.LoginData?.ContextKey ?? null;
    return this.contextKey !== null;
  }

  /**
   * List all devices across buildings/floors/areas.
   *
   * @returns {Promise<MelCloudDevice[]>} list of devices.
   */
  async listDevices(): Promise<MelCloudDevice[]> {
    const res = await fetch(`${BASE_URL}/User/ListDevices`, { headers: this.headers() });
    if (!res.ok) throw new Error(`ListDevices failed: ${res.status}`);
    const houses = (await res.json()) as Array<{
      Structure: {
        Devices: MelCloudDevice[];
        Areas: Array<{ Devices: MelCloudDevice[] }>;
        Floors: Array<{ Devices: MelCloudDevice[]; Areas: Array<{ Devices: MelCloudDevice[] }> }>;
      };
    }>;
    const devices: MelCloudDevice[] = [];
    for (const house of houses) {
      devices.push(...house.Structure.Devices);
      for (const area of house.Structure.Areas) devices.push(...area.Devices);
      for (const floor of house.Structure.Floors) {
        devices.push(...floor.Devices);
        for (const area of floor.Areas) devices.push(...area.Devices);
      }
    }
    return devices;
  }

  /**
   * Get the current state of a specific device.
   *
   * @param {number} deviceId - MELCloud device id.
   * @param {number} buildingId - Building id the device belongs to.
   * @returns {Promise<MelCloudState>} current state.
   */
  async getDevice(deviceId: number, buildingId: number): Promise<MelCloudState> {
    const url = `${BASE_URL}/Device/Get?id=${deviceId}&buildingID=${buildingId}`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Device/Get failed: ${res.status}`);
    return (await res.json()) as MelCloudState;
  }

  /**
   * Push a new device state (Ata = Air-To-Air).
   *
   * @param {MelCloudState} state - state to send.
   * @returns {Promise<void>}
   */
  async setAta(state: MelCloudState): Promise<void> {
    const res = await fetch(`${BASE_URL}/Device/SetAta`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...state, HasPendingCommand: true }),
    });
    if (!res.ok) throw new Error(`Device/SetAta failed: ${res.status}`);
  }
}
