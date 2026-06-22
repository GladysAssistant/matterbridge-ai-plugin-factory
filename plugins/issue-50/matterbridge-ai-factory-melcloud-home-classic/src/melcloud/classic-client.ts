/**
 * MELCloud Classic API client (app.melcloud.com).
 *
 * Endpoints and field semantics follow the public reference implementation in
 * OlivierZal/melcloud-api (`src/api/classic.ts`).
 *
 * @file classic-client.ts
 * @license Apache-2.0
 */

import type { AnsiLogger } from 'matterbridge/logger';

import type { AtaMode, AtaPatch, DeviceInfo, MelcloudClient, MelcloudDevice } from './types.js';

const BASE_URL = 'https://app.melcloud.com/Mitsubishi.Wifi.Client';
const APP_VERSION = '1.38.4.0';

const DEVICE_TYPE = { ata: 0, atw: 1, erv: 3 } as const;

// Classic ATA operation modes.
const MODE_TO_CLASSIC: Record<AtaMode, number> = { heat: 1, dry: 2, cool: 3, fan: 7, auto: 8 };
const CLASSIC_TO_MODE: Record<number, AtaMode> = { 1: 'heat', 2: 'dry', 3: 'cool', 7: 'fan', 8: 'auto' };

const VANE_VERTICAL_SWING = 7;
const VANE_HORIZONTAL_SWING = 12;

// EffectiveFlags bits for SetAta.
const FLAG = {
  power: 0x1,
  operationMode: 0x2,
  setTemperature: 0x4,
  setFanSpeed: 0x8,
  vaneVertical: 0x10,
  vaneHorizontal: 0x100,
} as const;

interface ClassicListEntry {
  DeviceID: number;
  DeviceName: string;
  BuildingID?: number;
  SerialNumber?: string;
  Type: number;
  Device?: Record<string, unknown>;
}

interface ClassicBuilding {
  ID: number;
  Name?: string;
  Structure: {
    Devices: ClassicListEntry[];
    Areas: { Devices: ClassicListEntry[] }[];
    Floors: { Devices: ClassicListEntry[]; Areas: { Devices: ClassicListEntry[] }[] }[];
  };
}

interface ClassicUnit {
  Model?: string;
  SerialNumber?: string;
  UnitType?: string;
  IndoorUnit?: boolean;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Client for the legacy MELCloud (Classic) cloud API. */
export class ClassicClient implements MelcloudClient {
  readonly app = 'classic' as const;

  #contextKey = '';

  readonly #buildingByDevice = new Map<string, number>();

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: AnsiLogger,
  ) {}

  async login(): Promise<void> {
    const data = (await this.#request('POST', '/Login/ClientLogin3', undefined, {
      Email: this.username,
      Password: this.password,
      Language: 0,
      AppVersion: APP_VERSION,
      Persist: true,
      CaptchaResponse: null,
    })) as { LoginData: { ContextKey: string } | null };
    if (data.LoginData === null) throw new Error('MELCloud Classic rejected the credentials');
    this.#contextKey = data.LoginData.ContextKey;
    this.log.info('MELCloud Classic: authenticated');
  }

  async listDevices(): Promise<MelcloudDevice[]> {
    const buildings = (await this.#request('GET', '/User/ListDevices')) as ClassicBuilding[];
    const devices: MelcloudDevice[] = [];
    for (const building of buildings) {
      for (const entry of collectEntries(building)) {
        devices.push(await this.#normalize(entry, building));
      }
    }
    return devices;
  }

  async setAta(device: MelcloudDevice, patch: AtaPatch): Promise<void> {
    const buildingId = this.#buildingByDevice.get(device.id);
    const deviceId = Number(device.id.replace('classic-', ''));
    const current = (await this.#request('GET', `/Device/Get?id=${String(deviceId)}&buildingID=${String(buildingId ?? 0)}`)) as Record<
      string,
      unknown
    >;

    let flags = 0;
    const body: Record<string, unknown> = { ...current };
    if (patch.power !== undefined) {
      body.Power = patch.power;
      flags |= FLAG.power;
    }
    if (patch.mode !== undefined) {
      body.OperationMode = MODE_TO_CLASSIC[patch.mode];
      flags |= FLAG.operationMode;
    }
    if (patch.setTemperature !== undefined) {
      body.SetTemperature = patch.setTemperature;
      flags |= FLAG.setTemperature;
    }
    if (patch.fanSpeed !== undefined) {
      body.SetFanSpeed = patch.fanSpeed;
      flags |= FLAG.setFanSpeed;
    }
    if (patch.vaneVerticalSwing !== undefined) {
      body.VaneVertical = patch.vaneVerticalSwing ? VANE_VERTICAL_SWING : 0;
      flags |= FLAG.vaneVertical;
    }
    if (patch.vaneHorizontalSwing !== undefined) {
      body.VaneHorizontal = patch.vaneHorizontalSwing ? VANE_HORIZONTAL_SWING : 0;
      flags |= FLAG.vaneHorizontal;
    }
    body.EffectiveFlags = flags;
    body.HasPendingCommand = true;
    body.DeviceID = deviceId;
    await this.#request('POST', '/Device/SetAta', undefined, body);
  }

  async #normalize(entry: ClassicListEntry, building: ClassicBuilding): Promise<MelcloudDevice> {
    const id = `classic-${String(entry.DeviceID)}`;
    this.#buildingByDevice.set(id, building.ID);
    const serial = entry.SerialNumber ?? String(entry.DeviceID);
    const name = entry.DeviceName || `Device ${String(entry.DeviceID)}`;
    if (entry.Type !== DEVICE_TYPE.ata) {
      const type = entry.Type === DEVICE_TYPE.atw ? 'atw' : 'unknown';
      return { id, name, serial, type, supported: false };
    }

    // The /User/ListDevices payload is a stale snapshot. Fetch the live device
    // record so initial values (power, temperatures, mode, fan, vanes) match the
    // web app instead of defaulting to "off".
    let d: Record<string, unknown> = entry.Device ?? {};
    try {
      d = (await this.#request('GET', `/Device/Get?id=${String(entry.DeviceID)}&buildingID=${String(building.ID)}`)) as Record<string, unknown>;
    } catch (error) {
      this.log.debug(`MELCloud Classic: falling back to list snapshot for "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      id,
      name,
      serial,
      type: 'ata',
      supported: true,
      info: buildInfo(building, serial, d, entry.Device),
      ata: {
        power: Boolean(d.Power),
        roomTemperature: num(d.RoomTemperature, 20),
        setTemperature: num(d.SetTemperature, 21),
        mode: CLASSIC_TO_MODE[num(d.OperationMode, 8)] ?? 'auto',
        fanSpeed: num(d.SetFanSpeed ?? d.FanSpeed, 0),
        numberOfFanSpeeds: num(d.NumberOfFanSpeeds, 5),
        vaneVerticalSwing: num(d.VaneVerticalDirection ?? d.VaneVertical) === VANE_VERTICAL_SWING,
        vaneHorizontalSwing: num(d.VaneHorizontalDirection ?? d.VaneHorizontal) === VANE_HORIZONTAL_SWING,
        minSetpoint: num(d.MinTempHeat ?? d.MinTempCoolDry, 10),
        maxSetpoint: num(d.MaxTempHeat ?? d.MaxTempCoolDry, 31),
      },
    };
  }

  async #request(method: string, path: string, _query?: undefined, body?: unknown): Promise<unknown> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(this.#contextKey === '' ? {} : { 'X-MitsContextKey': this.#contextKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`MELCloud Classic ${method} ${path} failed (${String(response.status)})`);
    return response.json();
  }
}

function buildInfo(building: ClassicBuilding, serial: string, live: Record<string, unknown>, listDevice?: Record<string, unknown>): DeviceInfo {
  const units = (Array.isArray(live.Units) ? live.Units : Array.isArray(listDevice?.Units) ? listDevice.Units : []) as ClassicUnit[];
  const indoor = units.find((u) => u.IndoorUnit === true || u.UnitType === 'IDU');
  const outdoor = units.find((u) => u.IndoorUnit === false || u.UnitType === 'ODU');
  return {
    buildingName: str(building.Name),
    acModel: str(indoor?.Model) ?? str(live.Model),
    acSerial: str(indoor?.SerialNumber) ?? serial,
    outdoorModel: str(outdoor?.Model),
    outdoorSerial: str(outdoor?.SerialNumber),
    wifiModel: str(live.AdaptorType ?? live.WifiAdapterModel),
    wifiSerial: str(live.MacAddress ?? live.WifiSerialNumber),
    macAddress: str(live.MacAddress),
  };
}

function collectEntries(building: ClassicBuilding): ClassicListEntry[] {
  const { Structure: structure } = building;
  const out: ClassicListEntry[] = [...structure.Devices];
  for (const area of structure.Areas) out.push(...area.Devices);
  for (const floor of structure.Floors) {
    out.push(...floor.Devices);
    for (const area of floor.Areas) out.push(...area.Devices);
  }
  return out;
}
