/**
 * Common device-connection abstraction shared by the Kasa and Tapo backends.
 *
 * @file deviceConn.ts
 * @license Apache-2.0
 */

import { BasePlatformConfig } from 'matterbridge';

/** Matter-facing category a TP-Link device is mapped to. */
export type DeviceCategory = 'outlet' | 'switch' | 'dimmer' | 'light' | 'colorlight';

/** Per-device manual configuration entry. */
export interface ManualDevice {
  protocol: 'kasa' | 'tapo';
  host: string;
  name?: string;
}

/** Plugin configuration shape. */
export type TpLinkPlatformConfig = BasePlatformConfig & {
  username?: string;
  password?: string;
  enableKasaDiscovery?: boolean;
  discoveryTimeout?: number;
  devices?: ManualDevice[];
  pollInterval?: number;
  whiteList?: string[];
  blackList?: string[];
};

/** Snapshot of a device state returned by a poll. */
export interface DeviceState {
  on?: boolean;
  /** Brightness in percent 0-100. */
  brightness?: number;
  /** Color temperature in Kelvin. */
  colorTempKelvin?: number;
  /** Active power in Watts. */
  powerW?: number;
  /** Cumulative energy in kWh. */
  energyKwh?: number;
  /** Voltage in Volts. */
  voltageV?: number;
  /** RSSI in dBm. */
  rssi?: number;
}

/**
 * Unified handle for a single TP-Link device, regardless of Kasa/Tapo backend.
 * The platform consumes only this interface, so backend specifics stay isolated.
 */
export interface DeviceConn {
  /** Stable, sanitized unique id used for the Matter endpoint. */
  id: string;
  /** Human-readable device name. */
  name: string;
  /** Device model string. */
  model: string;
  /** Serial number / mac used for Basic Information. */
  serial: string;
  /** Matter device category. */
  category: DeviceCategory;
  /** True when the device reports energy/power. */
  hasEnergy: boolean;
  /** Color-temperature physical range in Kelvin (color lights only). */
  ctMinKelvin?: number;
  ctMaxKelvin?: number;

  /**
   * Turn the device on or off.
   *
   * @param {boolean} on - Desired power state.
   * @returns {Promise<void>} Resolves when the command completes.
   */
  setOn(on: boolean): Promise<void>;

  /**
   * Set brightness in percent.
   *
   * @param {number} pct - Brightness 0-100.
   * @returns {Promise<void>} Resolves when the command completes.
   */
  setBrightness(pct: number): Promise<void>;

  /**
   * Set color temperature in Kelvin.
   *
   * @param {number} kelvin - Target color temperature.
   * @returns {Promise<void>} Resolves when the command completes.
   */
  setColorTempKelvin(kelvin: number): Promise<void>;

  /**
   * Read the current device state.
   *
   * @returns {Promise<DeviceState>} The current state snapshot.
   */
  poll(): Promise<DeviceState>;

  /** Release any backend resources. */
  close(): void;
}

/** Clamp a number to an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Convert Matter level (0-254) to percent (0-100). */
export function levelToPercent(level: number): number {
  return clamp(Math.round((level / 254) * 100), 0, 100);
}

/** Convert percent (0-100) to Matter level (1-254). */
export function percentToLevel(pct: number): number {
  return clamp(Math.round((pct / 100) * 254), 1, 254);
}

/** Convert mireds to Kelvin. */
export function miredsToKelvin(mireds: number): number {
  return Math.round(1_000_000 / clamp(mireds, 1, 1000));
}

/** Convert Kelvin to mireds. */
export function kelvinToMireds(kelvin: number): number {
  return Math.round(1_000_000 / clamp(kelvin, 1000, 10000));
}

/** Sanitize an arbitrary id into a stable endpoint id. */
export function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) || 'tplink';
}
