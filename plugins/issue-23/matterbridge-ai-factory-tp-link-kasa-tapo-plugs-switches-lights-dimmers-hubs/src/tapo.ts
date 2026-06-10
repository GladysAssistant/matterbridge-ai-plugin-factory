/**
 * Tapo backend. Local KLAP/secure-passthrough control via tp-link-tapo-connect.
 *
 * @file tapo.ts
 * @license Apache-2.0
 */

import { loginDeviceByIp } from 'tp-link-tapo-connect';

import { AnsiLogger } from 'matterbridge/logger';

import { clamp, DeviceCategory, DeviceConn, DeviceState, sanitizeId } from './deviceConn.js';

/** Minimal shape of the controller returned by loginDeviceByIp. */
type TapoHandler = Awaited<ReturnType<typeof loginDeviceByIp>>;

/**
 * Connect to a Tapo device by IP using the TP-Link account credentials.
 *
 * @param {string} username - TP-Link account email.
 * @param {string} password - TP-Link account password.
 * @param {string} host - Device IP or hostname.
 * @param {string | undefined} name - Optional friendly name override.
 * @param {AnsiLogger} log - Logger instance.
 * @returns {Promise<DeviceConn | null>} The device handle or null on failure.
 */
export async function connectTapoDevice(username: string, password: string, host: string, name: string | undefined, log: AnsiLogger): Promise<DeviceConn | null> {
  if (!username || !password) {
    log.error(`Tapo device ${host} requires a TP-Link account username and password in the plugin config.`);
    return null;
  }

  let handler: TapoHandler;
  try {
    handler = await loginDeviceByIp(username, password, host);
  } catch (error) {
    log.error(`Failed to login to Tapo device at ${host}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  /**
   * Re-establish the session after an error (KLAP sessions expire).
   *
   * @returns {Promise<void>} Resolves when re-logged in.
   */
  const relogin = async (): Promise<void> => {
    handler = await loginDeviceByIp(username, password, host);
  };

  /**
   * Run a backend call, retrying once after a fresh login on failure.
   *
   * @template T
   * @param {(h: TapoHandler) => Promise<T>} fn - Operation to run.
   * @returns {Promise<T>} The operation result.
   */
  const withRetry = async <T>(fn: (h: TapoHandler) => Promise<T>): Promise<T> => {
    try {
      return await fn(handler);
    } catch (error) {
      log.debug(`Tapo call failed for ${host}, re-login and retry: ${error instanceof Error ? error.message : String(error)}`);
      await relogin();
      return await fn(handler);
    }
  };

  const info = (await withRetry((h) => h.getDeviceInfo())) as Record<string, unknown>;
  const type = String(info.type ?? '').toUpperCase();
  const model = String(info.model ?? 'Tapo');
  const mac = String(info.mac ?? host);

  let category: DeviceCategory;
  let hasEnergy = false;

  if (type.includes('BULB') || /^L\d/i.test(model)) {
    // Tapo color temperature control is not exposed by the library; expose dimmable.
    category = 'light';
  } else if (type.includes('SWITCH') || /^S\d/i.test(model)) {
    category = 'switch';
  } else {
    category = 'outlet';
    try {
      const energy = (await withRetry((h) => h.getEnergyUsage())) as Record<string, unknown>;
      if (energy && (typeof energy.current_power === 'number' || typeof energy.today_energy === 'number')) hasEnergy = true;
    } catch {
      hasEnergy = false;
    }
  }

  return {
    id: sanitizeId('tapo' + mac),
    name: name || String(info.nickname || '') || model,
    model,
    serial: mac,
    category,
    hasEnergy,

    async setOn(on: boolean): Promise<void> {
      await withRetry((h) => (on ? h.turnOn() : h.turnOff()));
    },

    async setBrightness(pct: number): Promise<void> {
      await withRetry((h) => h.setBrightness(clamp(Math.round(pct), 1, 100)));
    },

    async setColorTempKelvin(): Promise<void> {
      // Not supported by tp-link-tapo-connect; brightness/on-off only.
    },

    async poll(): Promise<DeviceState> {
      const state: DeviceState = {};
      const di = (await withRetry((h) => h.getDeviceInfo())) as Record<string, unknown>;
      if (typeof di.device_on === 'boolean') state.on = di.device_on;
      if (typeof di.brightness === 'number') state.brightness = di.brightness;
      if (typeof di.color_temp === 'number' && di.color_temp > 0) state.colorTempKelvin = di.color_temp;
      if (typeof di.rssi === 'number') state.rssi = di.rssi;

      if (hasEnergy) {
        try {
          const energy = (await withRetry((h) => h.getEnergyUsage())) as unknown as Record<string, number>;
          if (typeof energy.current_power === 'number') state.powerW = energy.current_power / 1000;
          if (typeof energy.today_energy === 'number') state.energyKwh = energy.today_energy / 1000;
        } catch (error) {
          log.debug(`Tapo energy read failed for ${host}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return state;
    },

    close(): void {
      // No persistent socket to close for the Tapo backend.
    },
  };
}
