/**
 * MELCloud API client for Mitsubishi Electric air conditioning devices.
 */

const MELCLOUD_BASE = 'https://app.melcloud.com/Mitsubishi.Wifi.Client';
const APP_VERSION = '1.19.1.1';

export interface MelCloudDeviceInfo {
  DeviceID: number;
  BuildingID: number;
  DeviceName: string;
  Power: boolean;
  OperationMode: number; // 1=Heat, 2=Dry, 3=Cool, 7=Fan, 8=Auto
  SetTemperature: number;
  RoomTemperature: number;
  MinTemperature: number;
  MaxTemperature: number;
  SerialNumber?: string;
}

export interface MelCloudListEntry {
  ID: number;
  Name: string;
  Devices: MelCloudDeviceInfo[];
  Areas: { Devices: MelCloudDeviceInfo[] }[];
  Floors: { Devices: MelCloudDeviceInfo[]; Areas: { Devices: MelCloudDeviceInfo[] }[] }[];
}

export class MelCloudClient {
  private contextKey: string | null = null;
  private headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
  };

  async login(email: string, password: string): Promise<void> {
    const response = await fetch(`${MELCLOUD_BASE}/Login/ClientLogin`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        Email: email,
        Password: password,
        Language: 0,
        AppVersion: APP_VERSION,
        Persist: true,
        CaptchaResponse: null,
      }),
    });

    if (!response.ok) {
      throw new Error(`MELCloud login failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as { ErrorId?: number; ErrorMessage?: string; LoginData?: { ContextKey?: string } };

    if (data.ErrorId !== null && data.ErrorId !== 0) {
      throw new Error(`MELCloud login error: ${data.ErrorMessage ?? 'Unknown error'}`);
    }

    const contextKey = data.LoginData?.ContextKey;
    if (!contextKey) {
      throw new Error('MELCloud login did not return a ContextKey');
    }

    this.contextKey = contextKey;
  }

  isLoggedIn(): boolean {
    return this.contextKey !== null;
  }

  private getAuthHeaders(): Record<string, string> {
    return {
      ...this.headers,
      'X-MitsContextKey': this.contextKey ?? '',
    };
  }

  async listDevices(): Promise<MelCloudDeviceInfo[]> {
    const response = await fetch(`${MELCLOUD_BASE}/User/ListDevices`, {
      headers: this.getAuthHeaders(),
    });

    if (!response.ok) {
      throw new Error(`MELCloud ListDevices failed: HTTP ${response.status}`);
    }

    const buildings = (await response.json()) as MelCloudListEntry[];
    const devices: MelCloudDeviceInfo[] = [];

    const collectDevices = (list: MelCloudDeviceInfo[]) => {
      for (const d of list ?? []) {
        if (d.DeviceID !== undefined) devices.push(d);
      }
    };

    for (const building of buildings ?? []) {
      collectDevices(building.Devices);
      for (const area of building.Areas ?? []) collectDevices(area.Devices);
      for (const floor of building.Floors ?? []) {
        collectDevices(floor.Devices);
        for (const area of floor.Areas ?? []) collectDevices(area.Devices);
      }
    }

    return devices;
  }

  async getDeviceState(deviceId: number, buildingId: number): Promise<MelCloudDeviceInfo> {
    const url = `${MELCLOUD_BASE}/Device/Get?id=${deviceId}&buildingID=${buildingId}`;
    const response = await fetch(url, { headers: this.getAuthHeaders() });

    if (!response.ok) {
      throw new Error(`MELCloud Device/Get failed: HTTP ${response.status}`);
    }

    return (await response.json()) as MelCloudDeviceInfo;
  }

  async setDeviceState(deviceId: number, buildingId: number, update: Partial<MelCloudDeviceInfo> & { EffectiveFlags: number }): Promise<void> {
    const current = await this.getDeviceState(deviceId, buildingId);

    const payload = {
      ...current,
      ...update,
      HasPendingCommand: true,
    };

    const response = await fetch(`${MELCLOUD_BASE}/Device/SetAta`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`MELCloud Device/SetAta failed: HTTP ${response.status}`);
    }
  }

  async setPower(deviceId: number, buildingId: number, power: boolean): Promise<void> {
    await this.setDeviceState(deviceId, buildingId, {
      Power: power,
      EffectiveFlags: 1,
    });
  }

  async setOperationMode(deviceId: number, buildingId: number, mode: number): Promise<void> {
    await this.setDeviceState(deviceId, buildingId, {
      OperationMode: mode,
      EffectiveFlags: 6,
    });
  }

  async setTemperature(deviceId: number, buildingId: number, temperature: number): Promise<void> {
    await this.setDeviceState(deviceId, buildingId, {
      SetTemperature: temperature,
      EffectiveFlags: 4,
    });
  }
}

// MELCloud OperationMode <-> Matter Thermostat.SystemMode mapping
// MELCloud: 1=Heat, 2=Dry, 3=Cool, 7=Fan, 8=Auto
// Matter:   0=Off,  1=Auto, 3=Cool, 4=Heat
export const melcloudModeToMatter: Record<number, number> = {
  1: 4, // Heat
  3: 3, // Cool
  8: 1, // Auto
};

export const matterModeToMelcloud: Record<number, number> = {
  1: 8, // Auto
  3: 3, // Cool
  4: 1, // Heat
};
