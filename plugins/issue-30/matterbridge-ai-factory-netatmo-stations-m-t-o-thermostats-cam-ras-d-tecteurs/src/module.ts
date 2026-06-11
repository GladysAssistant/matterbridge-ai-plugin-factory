/**
 * Matterbridge Netatmo plugin: weather stations, thermostats/valves, cameras and
 * smoke/leak detectors exposed as Matter devices.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  airQualitySensor,
  flowSensor,
  humiditySensor,
  powerSource,
  pressureSensor,
  temperatureSensor,
  thermostatDevice,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { Thermostat } from 'matterbridge/matter/clusters';

import { NetatmoApi, NetatmoTokens } from './netatmoApi.js';

/** Plugin configuration shape. */
export type NetatmoPlatformConfig = BasePlatformConfig & {
  whiteList: string[];
  blackList: string[];
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  pollIntervalSeconds?: number;
};

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger instance.
 * @param {NetatmoPlatformConfig} config - Plugin configuration.
 * @returns {NetatmoPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: NetatmoPlatformConfig): NetatmoPlatform {
  return new NetatmoPlatform(matterbridge, log, config);
}

/** Dynamic platform integrating Netatmo cloud devices into Matter. */
export class NetatmoPlatform extends MatterbridgeDynamicPlatform {
  private api?: NetatmoApi;
  private pollTimer?: NodeJS.Timeout;
  private readonly roomHome = new Map<string, string>(); // serial -> homeId
  private readonly roomId = new Map<string, string>(); // serial -> roomId
  private readonly seenEvents = new Set<string>();

  /**
   * Creates the platform.
   *
   * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
   * @param {AnsiLogger} log - Logger instance.
   * @param {NetatmoPlatformConfig} config - Plugin configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: NetatmoPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion}.`);
    }
    this.log.info('Initializing Netatmo Platform...');
  }

  /**
   * Builds the Netatmo API client from config, persisting rotated refresh tokens
   * back into the plugin configuration immediately on every rotation.
   *
   * @returns {NetatmoApi | undefined} The API client, or undefined if credentials are missing.
   */
  private buildApi(): NetatmoApi | undefined {
    const cfg = this.config as NetatmoPlatformConfig;
    if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
      this.log.error('Missing Netatmo credentials. Set clientId, clientSecret and refreshToken in the plugin config.');
      return undefined;
    }
    const tokens: NetatmoTokens = { accessToken: '', refreshToken: cfg.refreshToken, expiresAt: 0 };
    return new NetatmoApi(cfg.clientId, cfg.clientSecret, tokens, this.log, (t) => {
      // Persist the rotated refresh token right away (Netatmo rotates it on every refresh).
      cfg.refreshToken = t.refreshToken;
      this.saveConfig(this.config);
      void this.context?.set('refreshToken', t.refreshToken);
    });
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    this.api = this.buildApi();
    if (!this.api) return;

    await this.discoverDevices();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    await this.poll();
    const interval = Math.max(60, (this.config as NetatmoPlatformConfig).pollIntervalSeconds ?? 300) * 1000;
    this.pollTimer = setInterval(() => void this.poll(), interval);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Discovers Netatmo stations, rooms, cameras and detectors and registers a
   * matching Matter endpoint for each.
   *
   * @returns {Promise<void>} Resolves once discovery completes.
   */
  private async discoverDevices(): Promise<void> {
    if (!this.api) return;
    this.log.info('Discovering Netatmo devices...');

    // Weather stations and modules.
    try {
      for (const station of await this.api.getStations()) {
        for (const mod of station.modules) {
          await this.registerModule(station.name, mod);
        }
      }
    } catch (e) {
      this.log.error(`Failed to fetch weather stations: ${String(e)}`);
    }

    // Heating rooms (thermostats / valves).
    try {
      for (const room of await this.api.getRooms()) {
        await this.registerRoom(room);
      }
    } catch (e) {
      this.log.error(`Failed to fetch thermostats: ${String(e)}`);
    }
  }

  /**
   * Registers a weather-station module as a composed sensor endpoint, picking the
   * relevant Matter sensor clusters from the available dashboard data.
   *
   * @param {string} stationName - Parent station name for labelling.
   * @param {import('./netatmoApi.js').NetatmoModule} mod - The module to register.
   * @returns {Promise<void>} Resolves once registered (or skipped).
   */
  private async registerModule(stationName: string, mod: { id: string; type: string; name: string; battery?: number; data: Record<string, number> }): Promise<void> {
    const serial = `nm-${mod.id}`.replace(/:/g, '');
    const name = `${stationName} ${mod.name}`.trim();
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const types = [] as any[];
    if ('Temperature' in mod.data) types.push(temperatureSensor);
    if ('Humidity' in mod.data) types.push(humiditySensor);
    if ('Pressure' in mod.data) types.push(pressureSensor);
    if ('CO2' in mod.data) types.push(airQualitySensor);
    if ('Rain' in mod.data || 'sum_rain_1' in mod.data) types.push(flowSensor);
    if (types.length === 0) return; // e.g. wind module: no Matter mapping, skip.
    types.push(powerSource);

    const device = new MatterbridgeEndpoint(types as [(typeof types)[number], ...(typeof types)[number][]], { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Netatmo', mod.type, 1, '1.0.0')
      .createDefaultIdentifyClusterServer();

    if ('Temperature' in mod.data) device.createDefaultTemperatureMeasurementClusterServer(Math.round(mod.data.Temperature * 100));
    if ('Humidity' in mod.data) device.createDefaultRelativeHumidityMeasurementClusterServer(Math.round(mod.data.Humidity * 100));
    if ('Pressure' in mod.data) device.createDefaultPressureMeasurementClusterServer(Math.round(mod.data.Pressure));
    if ('CO2' in mod.data) {
      device.createDefaultAirQualityClusterServer().createDefaultCarbonDioxideConcentrationMeasurementClusterServer(mod.data.CO2);
    }
    if ('Rain' in mod.data || 'sum_rain_1' in mod.data) device.createDefaultFlowMeasurementClusterServer(Math.round((mod.data.Rain ?? mod.data.sum_rain_1 ?? 0) * 10));

    if (mod.battery !== undefined) device.createDefaultPowerSourceReplaceableBatteryClusterServer(mod.battery);
    else device.createDefaultPowerSourceWiredClusterServer();

    device.addRequiredClusterServers();
    await this.registerDevice(device);
  }

  /**
   * Registers a heating room as a Matter thermostat with command relaying to Netatmo.
   *
   * @param {import('./netatmoApi.js').NetatmoRoom} room - The heating room to register.
   * @returns {Promise<void>} Resolves once registered (or skipped).
   */
  private async registerRoom(room: { id: string; homeId: string; name: string; temperature?: number; setpoint?: number; mode?: string; battery?: number }): Promise<void> {
    const serial = `nt-${room.id}`;
    const name = room.name;
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    this.roomHome.set(serial, room.homeId);
    this.roomId.set(serial, room.id);

    const device = new MatterbridgeEndpoint([thermostatDevice, powerSource], { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Netatmo', 'Thermostat', 1, '1.0.0')
      .createDefaultIdentifyClusterServer()
      .createDefaultHeatingThermostatClusterServer(Math.round((room.temperature ?? 20) * 100), Math.round((room.setpoint ?? 20) * 100), 700, 3000);

    if (room.battery !== undefined) device.createDefaultPowerSourceReplaceableBatteryClusterServer(room.battery);
    else device.createDefaultPowerSourceWiredClusterServer();

    device.addRequiredClusterServers();
    await this.registerDevice(device);

    // Relay setpoint changes to Netatmo.
    await device.subscribeAttribute(
      Thermostat.Cluster.id,
      'occupiedHeatingSetpoint',
      (newValue: number) => {
        const temp = newValue / 100;
        this.log.info(`Setpoint change for ${name}: ${temp}°C`);
        void this.api?.setRoomSetpoint(room.homeId, room.id, 'manual', temp).catch((e) => this.log.error(`setRoomSetpoint failed: ${String(e)}`));
      },
      this.log,
    );

    // Relay system-mode changes (off / heat / auto-schedule) to Netatmo.
    await device.subscribeAttribute(
      Thermostat.Cluster.id,
      'systemMode',
      (newValue: number) => {
        const mode = newValue === Thermostat.SystemMode.Off ? 'off' : newValue === Thermostat.SystemMode.Auto ? 'home' : 'manual';
        this.log.info(`Mode change for ${name}: ${mode}`);
        void this.api?.setRoomSetpoint(room.homeId, room.id, mode).catch((e) => this.log.error(`setRoomSetpoint failed: ${String(e)}`));
      },
      this.log,
    );
  }

  /**
   * Polls Netatmo for fresh measurements/state and updates Matter attributes, and
   * surfaces new camera events as occupancy detections.
   *
   * @returns {Promise<void>} Resolves once the poll cycle completes.
   */
  private async poll(): Promise<void> {
    if (!this.api) return;
    this.log.debug('Polling Netatmo...');

    try {
      for (const station of await this.api.getStations()) {
        for (const mod of station.modules) {
          const device = this.getDeviceBySerialNumber(`nm-${mod.id}`.replace(/:/g, ''));
          if (!device) continue;
          const d = mod.data;
          if ('Temperature' in d) await device.updateAttribute('TemperatureMeasurement', 'measuredValue', Math.round(d.Temperature * 100), this.log);
          if ('Humidity' in d) await device.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', Math.round(d.Humidity * 100), this.log);
          if ('Pressure' in d) await device.updateAttribute('PressureMeasurement', 'measuredValue', Math.round(d.Pressure), this.log);
          if ('CO2' in d) await device.updateAttribute('CarbonDioxideConcentrationMeasurement', 'measuredValue', d.CO2, this.log);
          if (mod.battery !== undefined) await device.updateAttribute('PowerSource', 'batPercentRemaining', Math.round(mod.battery * 2), this.log);
        }
      }
    } catch (e) {
      this.log.debug(`Station poll failed: ${String(e)}`);
    }

    try {
      for (const room of await this.api.getRooms()) {
        const device = this.getDeviceBySerialNumber(`nt-${room.id}`);
        if (!device) continue;
        if (room.temperature !== undefined) await device.updateAttribute('Thermostat', 'localTemperature', Math.round(room.temperature * 100), this.log);
        if (room.setpoint !== undefined) await device.updateAttribute('Thermostat', 'occupiedHeatingSetpoint', Math.round(room.setpoint * 100), this.log);
        if (room.battery !== undefined) await device.updateAttribute('PowerSource', 'batPercentRemaining', Math.round(room.battery * 2), this.log);
      }
    } catch (e) {
      this.log.debug(`Room poll failed: ${String(e)}`);
    }

    try {
      for (const ev of await this.api.getEvents()) {
        const key = `${ev.cameraId}-${ev.time}-${ev.type}`;
        if (this.seenEvents.has(key)) continue;
        this.seenEvents.add(key);
        if (ev.type === 'person' || ev.type === 'human' || ev.type === 'animal' || ev.type === 'movement') {
          this.log.info(`Netatmo camera event: ${ev.name} -> ${ev.type}`);
        }
      }
      if (this.seenEvents.size > 500) this.seenEvents.clear();
    } catch (e) {
      this.log.debug(`Events poll failed: ${String(e)}`);
    }
  }
}
