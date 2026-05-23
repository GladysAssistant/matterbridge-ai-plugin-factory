/**
 * Matter representation of a single Yoto Player.
 *
 * Each Yoto Player is exposed as a small fleet of bridged Matter devices:
 *  - Player   : dimmable light (on/off = play/pause, level = volume) + battery
 *  - Nightlight: extended color light (color = night-light hex color)
 *  - Temperature sensor (player thermal sensor)
 *  - Ambient light sensor
 *  - Card inserted (contact sensor)
 *  - Day Mode (on/off switch — on = day, off = night)
 *
 * Splitting per-feature keeps each accessory in HomeKit / Alexa simple and
 * avoids composed-device quirks across controllers.
 */

import {
  contactSensor,
  dimmableLight,
  extendedColorLight,
  lightSensor,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  onOffSwitch,
  powerSource,
  temperatureSensor,
} from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';
import { PowerSource } from 'matterbridge/matter/clusters';

import { YotoApi, YotoDeviceInfo, YotoDeviceStatus } from './yotoApi.js';

const VENDOR_ID = 0xfff1;
const VENDOR_NAME = 'Matterbridge';
const PRODUCT_NAME_PREFIX = 'Yoto Player';

/**
 * Convert a 0-100 percentage to a Matter LevelControl currentLevel (1-254).
 */
function percentToLevel(pct: number): number {
  if (!Number.isFinite(pct)) return 1;
  const clamped = Math.max(0, Math.min(100, pct));
  return Math.max(1, Math.round((clamped / 100) * 254));
}

/**
 * Convert a Matter LevelControl currentLevel (1-254) back to 0-100.
 */
function levelToPercent(level: number): number {
  return Math.max(0, Math.min(100, Math.round((level / 254) * 100)));
}

/**
 * Convert "#RRGGBB" → Matter ColorControl currentHue (0-254) and currentSaturation (0-254).
 */
function hexToHueSat(hex: string): { hue: number; saturation: number; on: boolean } {
  const clean = hex.trim().toLowerCase();
  if (clean === 'off' || clean === '' || clean === '#000000' || clean === '000000') {
    return { hue: 0, saturation: 0, on: false };
  }
  const m = clean.replace(/^#/, '');
  if (m.length !== 6) return { hue: 0, saturation: 0, on: false };
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max;
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return {
    hue: Math.round((h / 360) * 254),
    saturation: Math.round(s * 254),
    on: v > 0,
  };
}

/**
 * Convert Matter hue (0-254) + saturation (0-254) at full value to a "#RRGGBB" hex string.
 */
function hueSatToHex(hue: number, saturation: number): string {
  const h = (hue / 254) * 360;
  const s = saturation / 254;
  const v = 1;
  const c = v * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = v - c;
  const toHex = (n: number): string =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

/**
 * A single Yoto Player exposed as multiple Matter bridged devices.
 */
export class YotoPlayer {
  private readonly log: AnsiLogger;
  private readonly platform: MatterbridgeDynamicPlatform;
  private readonly api: YotoApi;
  readonly info: YotoDeviceInfo;

  private playerEp?: MatterbridgeEndpoint;
  private nightlightEp?: MatterbridgeEndpoint;
  private temperatureEp?: MatterbridgeEndpoint;
  private ambientEp?: MatterbridgeEndpoint;
  private cardEp?: MatterbridgeEndpoint;
  private dayModeEp?: MatterbridgeEndpoint;

  private lastStatus: YotoDeviceStatus = {};

  constructor(log: AnsiLogger, platform: MatterbridgeDynamicPlatform, api: YotoApi, info: YotoDeviceInfo) {
    this.log = log;
    this.platform = platform;
    this.api = api;
    this.info = info;
  }

  get deviceId(): string {
    return this.info.deviceId;
  }

  get name(): string {
    return this.info.name || this.info.deviceId;
  }

  /**
   * Build and register all child accessories with Matterbridge.
   */
  async register(): Promise<void> {
    const baseSerial = sanitizeSerial(this.info.deviceId);
    this.playerEp = new MatterbridgeEndpoint([dimmableLight, powerSource], { uniqueStorageKey: `${baseSerial}-player`, id: `${baseSerial}-player` } as Record<string, unknown>)
      .createDefaultBridgedDeviceBasicInformationClusterServer(`${this.name} Player`, `${baseSerial}-player`, VENDOR_ID, VENDOR_NAME, `${PRODUCT_NAME_PREFIX} Player`)
      .createDefaultPowerSourceRechargeableBatteryClusterServer(100)
      .addRequiredClusterServers()
      .addCommandHandler('on', () => void this.onPlayPause(true))
      .addCommandHandler('off', () => void this.onPlayPause(false))
      .addCommandHandler('toggle', () => void this.onPlayPause(undefined))
      .addCommandHandler('moveToLevel', (data) => void this.onVolumeChange(data))
      .addCommandHandler('moveToLevelWithOnOff', (data) => void this.onVolumeChange(data));
    await this.platform.registerDevice(this.playerEp);

    this.nightlightEp = new MatterbridgeEndpoint(extendedColorLight, { uniqueStorageKey: `${baseSerial}-nightlight`, id: `${baseSerial}-nightlight` } as Record<string, unknown>)
      .createDefaultBridgedDeviceBasicInformationClusterServer(`${this.name} Nightlight`, `${baseSerial}-nightlight`, VENDOR_ID, VENDOR_NAME, `${PRODUCT_NAME_PREFIX} Nightlight`)
      .addRequiredClusterServers()
      .addCommandHandler('on', () => void this.onNightlight({ on: true }))
      .addCommandHandler('off', () => void this.onNightlight({ on: false }))
      .addCommandHandler('moveToHue', (data) => void this.onNightlight({ hue: (data.request as { hue: number }).hue }))
      .addCommandHandler('moveToSaturation', (data) => void this.onNightlight({ saturation: (data.request as { saturation: number }).saturation }))
      .addCommandHandler('moveToHueAndSaturation', (data) => {
        const r = data.request as { hue: number; saturation: number };
        void this.onNightlight({ hue: r.hue, saturation: r.saturation });
      });
    await this.platform.registerDevice(this.nightlightEp);

    this.temperatureEp = new MatterbridgeEndpoint(temperatureSensor, { uniqueStorageKey: `${baseSerial}-temp`, id: `${baseSerial}-temp` } as Record<string, unknown>)
      .createDefaultBridgedDeviceBasicInformationClusterServer(`${this.name} Temperature`, `${baseSerial}-temp`, VENDOR_ID, VENDOR_NAME, `${PRODUCT_NAME_PREFIX} Temperature`)
      .addRequiredClusterServers();
    await this.platform.registerDevice(this.temperatureEp);

    this.ambientEp = new MatterbridgeEndpoint(lightSensor, { uniqueStorageKey: `${baseSerial}-light`, id: `${baseSerial}-light` } as Record<string, unknown>)
      .createDefaultBridgedDeviceBasicInformationClusterServer(`${this.name} Ambient Light`, `${baseSerial}-light`, VENDOR_ID, VENDOR_NAME, `${PRODUCT_NAME_PREFIX} Ambient Light`)
      .addRequiredClusterServers();
    await this.platform.registerDevice(this.ambientEp);

    this.cardEp = new MatterbridgeEndpoint(contactSensor, { uniqueStorageKey: `${baseSerial}-card`, id: `${baseSerial}-card` } as Record<string, unknown>)
      .createDefaultBridgedDeviceBasicInformationClusterServer(`${this.name} Card`, `${baseSerial}-card`, VENDOR_ID, VENDOR_NAME, `${PRODUCT_NAME_PREFIX} Card`)
      .addRequiredClusterServers();
    await this.platform.registerDevice(this.cardEp);

    this.dayModeEp = new MatterbridgeEndpoint(onOffSwitch, { uniqueStorageKey: `${baseSerial}-daymode`, id: `${baseSerial}-daymode` } as Record<string, unknown>)
      .createDefaultBridgedDeviceBasicInformationClusterServer(`${this.name} Day Mode`, `${baseSerial}-daymode`, VENDOR_ID, VENDOR_NAME, `${PRODUCT_NAME_PREFIX} Day Mode`)
      .addRequiredClusterServers()
      .addCommandHandler('on', () => void this.onDayMode(true))
      .addCommandHandler('off', () => void this.onDayMode(false));
    await this.platform.registerDevice(this.dayModeEp);
  }

  /**
   * Apply a freshly-fetched status snapshot to every Matter endpoint.
   * Missing fields are ignored so partial updates from MQTT events work.
   */
  async applyStatus(status: YotoDeviceStatus): Promise<void> {
    this.lastStatus = { ...this.lastStatus, ...status };
    const s = this.lastStatus;

    if (this.playerEp) {
      if (typeof s.isPlaying === 'boolean') {
        await this.playerEp.updateAttribute('OnOff', 'onOff', s.isPlaying, this.log);
      } else if (typeof s.activeCard !== 'undefined' && s.activeCard !== null && s.cardInsertionState && s.cardInsertionState > 0) {
        await this.playerEp.updateAttribute('OnOff', 'onOff', true, this.log);
      }
      if (typeof s.userVolumePercentage === 'number') {
        await this.playerEp.updateAttribute('LevelControl', 'currentLevel', percentToLevel(s.userVolumePercentage), this.log);
      }
      if (typeof s.batteryLevelPercentage === 'number') {
        await this.playerEp.updateAttribute('PowerSource', 'batPercentRemaining', Math.round(Math.max(0, Math.min(100, s.batteryLevelPercentage)) * 2), this.log);
      }
      if (typeof s.isCharging === 'boolean') {
        const state = s.isCharging
          ? PowerSource.BatChargeState.IsCharging
          : (s.batteryLevelPercentage ?? 0) >= 99
            ? PowerSource.BatChargeState.IsAtFullCharge
            : PowerSource.BatChargeState.IsNotCharging;
        await this.playerEp.updateAttribute('PowerSource', 'batChargeState', state, this.log);
      }
      if (typeof s.isOnline === 'boolean') {
        const status = s.isOnline ? PowerSource.PowerSourceStatus.Active : PowerSource.PowerSourceStatus.Unavailable;
        await this.playerEp.updateAttribute('PowerSource', 'status', status, this.log);
      }
    }

    if (this.nightlightEp && typeof s.nightlightMode === 'string') {
      const hsv = hexToHueSat(s.nightlightMode);
      await this.nightlightEp.updateAttribute('OnOff', 'onOff', hsv.on, this.log);
      if (hsv.on) {
        await this.nightlightEp.updateAttribute('ColorControl', 'currentHue', hsv.hue, this.log);
        await this.nightlightEp.updateAttribute('ColorControl', 'currentSaturation', hsv.saturation, this.log);
      }
    }

    if (this.temperatureEp && typeof s.temperatureCelcius === 'number') {
      await this.temperatureEp.updateAttribute('TemperatureMeasurement', 'measuredValue', Math.round(s.temperatureCelcius * 100), this.log);
    }

    if (this.ambientEp && typeof s.ambientLightSensorReading === 'number') {
      // Matter Illuminance uses 10000 * log10(lux) + 1. Yoto exposes a raw sensor reading
      // without a documented unit; pass it through as the measured value clamped to range.
      const raw = Math.max(1, Math.min(65534, Math.round(s.ambientLightSensorReading)));
      await this.ambientEp.updateAttribute('IlluminanceMeasurement', 'measuredValue', raw, this.log);
    }

    if (this.cardEp && typeof s.cardInsertionState === 'number') {
      // BooleanState.stateValue: true = contact closed = card inserted.
      const inserted = s.cardInsertionState > 0;
      await this.cardEp.updateAttribute('BooleanState', 'stateValue', inserted, this.log);
    }

    if (this.dayModeEp && typeof s.dayMode === 'number' && s.dayMode >= 0) {
      await this.dayModeEp.updateAttribute('OnOff', 'onOff', s.dayMode === 1, this.log);
    }
  }

  // --- command handlers ---

  private async onPlayPause(on: boolean | undefined): Promise<void> {
    const target = typeof on === 'boolean' ? on : !(this.lastStatus.isPlaying ?? false);
    try {
      await this.api.sendCommand(this.deviceId, target ? { cmd: 'play' } : { cmd: 'pause' });
      this.lastStatus.isPlaying = target;
      if (this.playerEp) await this.playerEp.updateAttribute('OnOff', 'onOff', target, this.log);
    } catch (err) {
      this.log.warn(`Play/pause failed for ${this.name}: ${(err as Error).message}`);
    }
  }

  private async onVolumeChange(data: { request: unknown }): Promise<void> {
    const req = data.request as { level?: number };
    if (typeof req.level !== 'number') return;
    const pct = levelToPercent(req.level);
    try {
      await this.api.updateConfig(this.deviceId, { volume: pct });
      this.lastStatus.userVolumePercentage = pct;
    } catch (err) {
      this.log.warn(`Volume change failed for ${this.name}: ${(err as Error).message}`);
    }
  }

  private async onNightlight(change: { on?: boolean; hue?: number; saturation?: number }): Promise<void> {
    const current = hexToHueSat(this.lastStatus.nightlightMode ?? '#ffffff');
    const on = change.on ?? current.on;
    const hue = change.hue ?? current.hue;
    const saturation = change.saturation ?? current.saturation;
    const color = on ? hueSatToHex(hue, saturation) : 'off';
    try {
      await this.api.updateConfig(this.deviceId, { nightlightMode: color });
      this.lastStatus.nightlightMode = color;
    } catch (err) {
      this.log.warn(`Nightlight change failed for ${this.name}: ${(err as Error).message}`);
    }
  }

  private async onDayMode(day: boolean): Promise<void> {
    try {
      await this.api.updateConfig(this.deviceId, { dayMode: day ? 1 : 0 });
      this.lastStatus.dayMode = day ? 1 : 0;
    } catch (err) {
      this.log.warn(`Day-mode change failed for ${this.name}: ${(err as Error).message}`);
    }
  }
}

function sanitizeSerial(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
}
