/**
 * MelCloud REST API client for Mitsubishi Electric air conditioning units.
 *
 * Implements the MELCloud Classic API used by the official app.
 * Base URL: https://app.melcloud.com/Mitsubishi.Wifi.Client
 */

import axios, { AxiosInstance } from 'axios';

// ─── Constants ───────────────────────────────────────────────────────────────

export const MELCLOUD_BASE_URL = 'https://app.melcloud.com/Mitsubishi.Wifi.Client';
export const APP_VERSION = '1.32.1.0';

// ─── Enums ───────────────────────────────────────────────────────────────────

/** ATA (air-to-air) device operation modes, matching MELCloud numeric values. */
export const enum OperationMode {
  Heat = 1,
  Dry = 2,
  Cool = 3,
  Fan = 7,
  Auto = 8,
}

/** MELCloud device types. This plugin only handles ATA (0). */
export const enum DeviceType {
  Ata = 0,
  Atw = 1,
  Erv = 3,
}

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface MelCloudCredentials {
  username: string;
  password: string;
}

/**
 * Represents the full state of an ATA device as returned by the MELCloud API.
 * Only the fields relevant to this plugin are typed; extra fields are preserved
 * verbatim so that SetAta round-trips work correctly.
 */
export interface AtaDeviceState {
  DeviceID: number;
  DeviceName: string;
  BuildingID: number;
  /** Whether the unit is powered on. */
  Power: boolean;
  /** Current operation mode (heat / cool / dry / fan / auto). */
  OperationMode: OperationMode;
  /** Target temperature set by the user (°C). */
  SetTemperature: number;
  /** Actual room temperature measured by the unit (°C, read-only). */
  RoomTemperature: number;
  /** Actual outdoor temperature (°C, read-only). */
  OutdoorTemperature?: number;
  ActualFanSpeed?: number;
  FanSpeed?: number;
  VaneHorizontal?: number;
  VaneVertical?: number;
  /** Must be `true` when sending a SetAta request. */
  HasPendingCommand?: boolean;
  // Allow extra properties for safe round-tripping
  [key: string]: unknown;
}

// Internal shape returned by /User/ListDevices
interface ListDeviceItem {
  DeviceID: number;
  DeviceName: string;
  BuildingID: number;
  Device: AtaDeviceState;
}

interface BuildingStructure {
  Devices: ListDeviceItem[];
  Areas: Array<{ Devices: ListDeviceItem[] }>;
  Floors: Array<{
    Devices: ListDeviceItem[];
    Areas: Array<{ Devices: ListDeviceItem[] }>;
  }>;
}

interface MelCloudBuilding {
  ID: number;
  Name: string;
  Structure: BuildingStructure;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class MelCloudClient {
  private readonly http: AxiosInstance;
  private contextKey: string | undefined;

  constructor() {
    this.http = axios.create({
      baseURL: MELCLOUD_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 matterbridge-melcloud',
      },
      timeout: 15_000,
    });
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  /**
   * Authenticates with MELCloud and stores the ContextKey for subsequent calls.
   * Throws an error if credentials are wrong or the server returns an error code.
   */
  async login(credentials: MelCloudCredentials): Promise<void> {
    const response = await this.http.post<{
      ErrorId: number | null;
      LoginData: { ContextKey: string };
    }>('/Login/ClientLogin', {
      Username: credentials.username,
      Password: credentials.password,
      Language: 0,
      AppVersion: APP_VERSION,
      Persist: true,
      CaptchaResponse: null,
    });

    const { ErrorId, LoginData } = response.data;

    if (ErrorId !== null && ErrorId !== undefined) {
      const messages: Record<number, string> = {
        1: 'Invalid credentials',
        6: 'Account locked – too many failed attempts',
      };
      throw new Error(`MELCloud login error ${ErrorId}: ${messages[ErrorId] ?? 'Unknown error'}`);
    }

    this.contextKey = LoginData.ContextKey;
    this.http.defaults.headers['X-MitsContextKey'] = this.contextKey;
  }

  // ── Device discovery ───────────────────────────────────────────────────────

  /**
   * Returns all ATA (air-to-air) devices registered in the MELCloud account.
   * The function traverses the full building / floor / area hierarchy.
   */
  async listAtaDevices(): Promise<AtaDeviceState[]> {
    this.assertAuthenticated();

    const response = await this.http.get<MelCloudBuilding[]>('/User/ListDevices');
    const buildings = response.data;

    const devices: AtaDeviceState[] = [];

    for (const building of buildings) {
      const items = this.extractAllDevices(building);
      for (const item of items) {
        // Only handle ATA devices (DeviceType === 0).
        // We detect ATA by checking that RoomTemperature is present.
        if (item.Device?.RoomTemperature !== undefined) {
          devices.push({
            ...item.Device,
            DeviceID: item.DeviceID,
            DeviceName: item.DeviceName,
            BuildingID: building.ID,
          });
        }
      }
    }

    return devices;
  }

  // ── Device control ─────────────────────────────────────────────────────────

  /**
   * Sends an updated state to MELCloud for a single ATA device.
   *
   * @param currentState - The last known full state of the device (used for round-trip safety).
   * @param updates      - Partial state containing only the fields to change.
   * @returns            The acknowledged device state from the server.
   */
  async setAtaValues(
    currentState: AtaDeviceState,
    updates: Partial<AtaDeviceState>,
  ): Promise<AtaDeviceState> {
    this.assertAuthenticated();

    const payload: AtaDeviceState = {
      ...currentState,
      ...updates,
      HasPendingCommand: true,
    };

    const response = await this.http.post<AtaDeviceState>('/Device/SetAta', payload);
    return response.data;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private assertAuthenticated(): void {
    if (!this.contextKey) {
      throw new Error('MelCloudClient: not authenticated – call login() first');
    }
  }

  private extractAllDevices(building: MelCloudBuilding): ListDeviceItem[] {
    const items: ListDeviceItem[] = [];
    const struct = building.Structure;

    const collect = (list: ListDeviceItem[] = []) => items.push(...list);

    collect(struct.Devices);
    for (const area of struct.Areas ?? []) collect(area.Devices);
    for (const floor of struct.Floors ?? []) {
      collect(floor.Devices);
      for (const area of floor.Areas ?? []) collect(area.Devices);
    }

    return items;
  }
}
