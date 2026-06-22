/**
 * MELCloud Home API client (mobile.bff.melcloudhome.com).
 *
 * Endpoints, payload shapes and the OIDC authentication follow the public
 * reference implementation in OlivierZal/melcloud-api (`src/api/home.ts`).
 *
 * @file home-client.ts
 * @license Apache-2.0
 */

import type { AnsiLogger } from 'matterbridge/logger';

import { performHomeLogin, refreshHomeTokens } from './home-oidc.js';
import type { AtaMode, AtaPatch, DeviceInfo, MelcloudClient, MelcloudDevice } from './types.js';

const BASE_URL = 'https://mobile.bff.melcloudhome.com';

type HomeMode = 'Automatic' | 'Cool' | 'Dry' | 'Fan' | 'Heat';
const HOME_TO_MODE: Record<HomeMode, AtaMode> = { Automatic: 'auto', Cool: 'cool', Dry: 'dry', Fan: 'fan', Heat: 'heat' };
const MODE_TO_HOME: Record<AtaMode, HomeMode> = { auto: 'Automatic', cool: 'Cool', dry: 'Dry', fan: 'Fan', heat: 'Heat' };

type HomeFanSpeed = 'Auto' | 'One' | 'Two' | 'Three' | 'Four' | 'Five';
const FAN_BY_INDEX: HomeFanSpeed[] = ['Auto', 'One', 'Two', 'Three', 'Four', 'Five'];
const FAN_TO_INDEX: Record<string, number> = { Auto: 0, One: 1, Two: 2, Three: 3, Four: 4, Five: 5 };

interface HomeSetting {
  name: string;
  value: string;
}

interface HomeAtaUnit {
  id: string;
  givenDisplayName?: string;
  serialNumber?: string;
  model?: string;
  macAddress?: string;
  settings: HomeSetting[];
  capabilities?: Record<string, unknown>;
}

interface HomeAtwUnit {
  id: string;
  givenDisplayName?: string;
}

interface HomeBuilding {
  name?: string;
  airToAirUnits?: HomeAtaUnit[];
  airToWaterUnits?: HomeAtwUnit[];
}

interface HomeContext {
  buildings?: HomeBuilding[];
  guestBuildings?: HomeBuilding[];
}

function settingValue(unit: HomeAtaUnit, name: string): string {
  return unit.settings.find((s) => s.name === name)?.value ?? '';
}

function num(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function capNum(caps: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = caps?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Client for the modern MELCloud Home cloud API. */
export class HomeClient implements MelcloudClient {
  readonly app = 'home' as const;

  #accessToken = '';

  #refreshToken = '';

  #expiry = 0;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: AnsiLogger,
  ) {}

  async login(): Promise<void> {
    const tokens = await performHomeLogin(this.username, this.password);
    this.#store(tokens.accessToken, tokens.refreshToken, tokens.expiresIn);
    this.log.info('MELCloud Home: authenticated');
  }

  async listDevices(): Promise<MelcloudDevice[]> {
    const context = (await this.#request('GET', '/context')) as HomeContext;
    const buildings = [...(context.buildings ?? []), ...(context.guestBuildings ?? [])];
    const devices: MelcloudDevice[] = [];
    for (const building of buildings) {
      for (const unit of building.airToAirUnits ?? []) devices.push(normalizeAta(unit, building));
      for (const unit of building.airToWaterUnits ?? []) {
        devices.push({
          id: `home-${unit.id}`,
          name: unit.givenDisplayName || `ATW ${unit.id}`,
          serial: unit.id,
          type: 'atw',
          supported: false,
        });
      }
    }
    return devices;
  }

  async setAta(device: MelcloudDevice, patch: AtaPatch): Promise<void> {
    const id = device.id.replace('home-', '');
    const body: Record<string, unknown> = {};
    if (patch.power !== undefined) body.power = patch.power;
    if (patch.mode !== undefined) body.operationMode = MODE_TO_HOME[patch.mode];
    if (patch.setTemperature !== undefined) body.setTemperature = patch.setTemperature;
    if (patch.fanSpeed !== undefined) body.setFanSpeed = FAN_BY_INDEX[Math.max(0, Math.min(5, patch.fanSpeed))];
    if (patch.vaneVerticalSwing !== undefined) body.vaneVerticalDirection = patch.vaneVerticalSwing ? 'Swing' : 'Auto';
    if (patch.vaneHorizontalSwing !== undefined) body.vaneHorizontalDirection = patch.vaneHorizontalSwing ? 'Swing' : 'Auto';
    await this.#request('PUT', `/monitor/ataunit/${id}`, body);
  }

  #store(accessToken: string, refreshToken: string, expiresIn: number): void {
    this.#accessToken = accessToken;
    if (refreshToken !== '') this.#refreshToken = refreshToken;
    this.#expiry = Date.now() + expiresIn * 1000;
  }

  async #ensureSession(): Promise<void> {
    if (this.#accessToken !== '' && Date.now() < this.#expiry - 60_000) return;
    if (this.#refreshToken !== '') {
      const tokens = await refreshHomeTokens(this.#refreshToken);
      if (tokens !== null) {
        this.#store(tokens.accessToken, tokens.refreshToken, tokens.expiresIn);
        return;
      }
    }
    await this.login();
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    await this.#ensureSession();
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.#accessToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`MELCloud Home ${method} ${path} failed (${String(response.status)})`);
    const text = await response.text();
    return text === '' ? {} : JSON.parse(text);
  }
}

function normalizeAta(unit: HomeAtaUnit, building: HomeBuilding): MelcloudDevice {
  const caps = unit.capabilities;
  const fanRaw = settingValue(unit, 'SetFanSpeed');
  const fanSpeed = FAN_TO_INDEX[fanRaw] ?? num(fanRaw, 0);
  const info: DeviceInfo = {
    buildingName: building.name,
    acModel: unit.model ?? (settingValue(unit, 'ModelName') || undefined),
    acSerial: unit.serialNumber ?? unit.id,
    macAddress: unit.macAddress ?? (settingValue(unit, 'MacAddress') || undefined),
    wifiSerial: unit.macAddress ?? undefined,
  };
  return {
    id: `home-${unit.id}`,
    name: unit.givenDisplayName || `ATA ${unit.id}`,
    serial: unit.serialNumber ?? unit.id,
    type: 'ata',
    supported: true,
    info,
    ata: {
      power: settingValue(unit, 'Power') === 'True',
      roomTemperature: num(settingValue(unit, 'RoomTemperature'), 20),
      setTemperature: num(settingValue(unit, 'SetTemperature'), 21),
      mode: HOME_TO_MODE[(settingValue(unit, 'OperationMode') || 'Automatic') as HomeMode] ?? 'auto',
      fanSpeed,
      numberOfFanSpeeds: capNum(caps, 'numberOfFanSpeeds', 5),
      vaneVerticalSwing: settingValue(unit, 'VaneVerticalDirection') === 'Swing',
      vaneHorizontalSwing: settingValue(unit, 'VaneHorizontalDirection') === 'Swing',
      minSetpoint: capNum(caps, 'minTempHeat', 10),
      maxSetpoint: capNum(caps, 'maxTempHeat', 31),
    },
  };
}
