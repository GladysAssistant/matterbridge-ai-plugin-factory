/**
 * Kasa (TP-Link smarthome) backend. Local-only control via tplink-smarthome-api.
 *
 * @file kasa.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';
import { Bulb, Client, Device, Plug } from 'tplink-smarthome-api';

import { DeviceCategory, DeviceConn, DeviceState, sanitizeId } from './deviceConn.js';

/**
 * Wrap a connected Kasa device into the common DeviceConn interface.
 *
 * @param {Device} dev - The connected Kasa Plug or Bulb.
 * @param {AnsiLogger} log - Logger instance.
 * @returns {DeviceConn} The unified device handle.
 */
export function wrapKasaDevice(dev: Device, log: AnsiLogger): DeviceConn {
  const isBulb = dev instanceof Bulb;
  const isPlug = dev instanceof Plug;
  const bulb = dev as Bulb;
  const plug = dev as Plug;

  let category: DeviceCategory;
  let hasEnergy = false;
  let ctMinKelvin: number | undefined;
  let ctMaxKelvin: number | undefined;

  if (isBulb) {
    if (bulb.supportsColorTemperature) {
      category = 'colorlight';
      const range = bulb.colorTemperatureRange;
      if (range) {
        ctMinKelvin = range.min;
        ctMaxKelvin = range.max;
      }
    } else if (bulb.supportsBrightness) {
      category = 'light';
    } else {
      category = 'switch';
    }
  } else if (isPlug && plug.supportsDimmer) {
    category = 'dimmer';
  } else {
    category = 'outlet';
    if (isPlug) hasEnergy = plug.supportsEmeter;
  }

  return {
    id: sanitizeId('kasa' + dev.id),
    name: dev.alias || dev.model,
    model: dev.model,
    serial: dev.id,
    category,
    hasEnergy,
    ctMinKelvin,
    ctMaxKelvin,

    async setOn(on: boolean): Promise<void> {
      await (isBulb ? bulb : plug).setPowerState(on);
    },

    async setBrightness(pct: number): Promise<void> {
      if (isBulb) {
        await bulb.lighting.setLightState({ on_off: 1, brightness: pct });
      } else if (isPlug && plug.supportsDimmer) {
        await plug.dimmer.setBrightness(pct);
      }
    },

    async setColorTempKelvin(kelvin: number): Promise<void> {
      if (isBulb && bulb.supportsColorTemperature) {
        await bulb.lighting.setLightState({ color_temp: kelvin });
      }
    },

    async poll(): Promise<DeviceState> {
      const state: DeviceState = {};
      const sys = (await dev.getSysInfo()) as Record<string, unknown>;
      if (typeof sys.rssi === 'number') state.rssi = sys.rssi;

      if (isBulb) {
        const ls = (await bulb.lighting.getLightState()) as Record<string, number>;
        state.on = ls.on_off === 1;
        if (typeof ls.brightness === 'number') state.brightness = ls.brightness;
        if (typeof ls.color_temp === 'number' && ls.color_temp > 0) state.colorTempKelvin = ls.color_temp;
      } else {
        state.on = await plug.getPowerState();
        if (isPlug && plug.supportsDimmer) state.brightness = plug.dimmer.brightness;
      }

      if (hasEnergy && isPlug) {
        try {
          await plug.emeter.getRealtime();
          const rt = plug.emeter.realtime as Record<string, number>;
          const powerW = rt.power ?? (typeof rt.power_mw === 'number' ? rt.power_mw / 1000 : undefined);
          const totalKwh = rt.total ?? (typeof rt.total_wh === 'number' ? rt.total_wh / 1000 : undefined);
          const voltageV = rt.voltage ?? (typeof rt.voltage_mv === 'number' ? rt.voltage_mv / 1000 : undefined);
          if (typeof powerW === 'number') state.powerW = powerW;
          if (typeof totalKwh === 'number') state.energyKwh = totalKwh;
          if (typeof voltageV === 'number') state.voltageV = voltageV;
        } catch (error) {
          log.debug(`Kasa emeter read failed for ${dev.alias}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return state;
    },

    close(): void {
      dev.closeConnection();
    },
  };
}

/**
 * Connect to a single Kasa device by host/IP.
 *
 * @param {Client} client - Shared Kasa client.
 * @param {string} host - Device IP or hostname.
 * @param {AnsiLogger} log - Logger instance.
 * @returns {Promise<DeviceConn | null>} The device handle or null on failure.
 */
export async function connectKasaDevice(client: Client, host: string, log: AnsiLogger): Promise<DeviceConn | null> {
  try {
    const dev = await client.getDevice({ host });
    return wrapKasaDevice(dev, log);
  } catch (error) {
    log.error(`Failed to connect to Kasa device at ${host}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Broadcast-discover Kasa devices on the local network.
 *
 * @param {Client} client - Shared Kasa client.
 * @param {number} timeoutMs - Discovery duration in milliseconds.
 * @param {AnsiLogger} log - Logger instance.
 * @returns {Promise<DeviceConn[]>} Discovered device handles.
 */
export function discoverKasaDevices(client: Client, timeoutMs: number, log: AnsiLogger): Promise<DeviceConn[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DeviceConn>();
    client.startDiscovery({ discoveryInterval: 2000 });
    client.on('device-new', (dev: Device) => {
      if (found.has(dev.id)) return;
      log.info(`Discovered Kasa device: ${dev.alias} (${dev.model}) at ${dev.host}`);
      found.set(dev.id, wrapKasaDevice(dev, log));
    });
    setTimeout(() => {
      client.stopDiscovery();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
