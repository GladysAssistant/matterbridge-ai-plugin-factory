/**
 * Matterbridge plugin for Google Nest devices (thermostats, cameras, doorbells, Protect)
 * via the Google Smart Device Management (SDM) API.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  contactSensor,
  humiditySensor,
  occupancySensor,
  powerSource,
  smokeCoAlarm,
  temperatureSensor,
  thermostatDevice,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { BooleanState, OccupancySensing, RelativeHumidityMeasurement, SmokeCoAlarm, TemperatureMeasurement, Thermostat } from 'matterbridge/matter/clusters';

import { NestClient, NestDevice } from './nestClient.js';

/** Instance configuration for this platform. */
export type NestPlatformConfig = BasePlatformConfig & {
  projectId?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  pollInterval?: number;
  whiteList: string[];
  blackList: string[];
};

const THERMOSTAT = 'sdm.devices.traits.';
const SETPOINT_TRAIT = `${THERMOSTAT}ThermostatTemperatureSetpoint`;
const MODE_TRAIT = `${THERMOSTAT}ThermostatMode`;
const HVAC_TRAIT = `${THERMOSTAT}ThermostatHvac`;
const TEMP_TRAIT = `${THERMOSTAT}Temperature`;
const HUMIDITY_TRAIT = `${THERMOSTAT}Humidity`;
const CONNECTIVITY_TRAIT = `${THERMOSTAT}Connectivity`;

/** Internal bookkeeping for a registered Nest device. */
interface DeviceEntry {
  endpoint: MatterbridgeEndpoint;
  name: string; // SDM resource name
  type: 'thermostat' | 'camera' | 'protect';
}

/**
 * Entry point invoked by Matterbridge.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The plugin logger.
 * @param {NestPlatformConfig} config - The plugin configuration.
 * @returns {NestPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: NestPlatformConfig): NestPlatform {
  return new NestPlatform(matterbridge, log, config);
}

/** Google Nest dynamic platform. */
export class NestPlatform extends MatterbridgeDynamicPlatform {
  private readonly client: NestClient;
  private readonly entries = new Map<string, DeviceEntry>();
  private pollTimer?: NodeJS.Timeout;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: NestPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.client = new NestClient(
      {
        projectId: config.projectId ?? '',
        clientId: config.clientId ?? '',
        clientSecret: config.clientSecret ?? '',
        refreshToken: config.refreshToken ?? '',
      },
      log,
    );

    this.log.info('Initializing Google Nest Platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    if (!this.client.configured) {
      this.log.warn('Google Nest is not configured. Set projectId, clientId, clientSecret and refreshToken in the plugin config.');
      return;
    }

    try {
      const devices = await this.client.listDevices();
      this.log.info(`Discovered ${devices.length} Nest device(s)`);
      for (const device of devices) {
        await this.discoverDevice(device);
      }
    } catch (error) {
      this.log.error(`Failed to discover Nest devices: ${(error as Error).message}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    await this.refreshAll();

    const interval = Math.max(30, (this.config as NestPlatformConfig).pollInterval ?? 60) * 1000;
    this.pollTimer = setInterval(() => {
      void this.refreshAll();
    }, interval);
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
    this.entries.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Short device id and friendly name derived from an SDM device.
   *
   * @param {NestDevice} device - The SDM device.
   * @returns {{ id: string; label: string }} Short id and display name.
   */
  private describe(device: NestDevice): { id: string; label: string } {
    const id = device.name.split('/').pop() ?? device.name;
    const info = device.traits['sdm.devices.traits.Info'] as { customName?: string } | undefined;
    const rel = device.parentRelations?.find((r) => r.displayName)?.displayName;
    const label = info?.customName || rel || `Nest ${device.type.split('.').pop()}`;
    return { id, label };
  }

  /**
   * Create and register a Matter endpoint for a single SDM device.
   *
   * @param {NestDevice} device - The SDM device.
   * @returns {Promise<void>} Resolves once the device is registered (or skipped).
   */
  private async discoverDevice(device: NestDevice): Promise<void> {
    const { id, label } = this.describe(device);
    this.setSelectDevice(id, label);
    if (!this.validateDevice([label, id])) return;

    const type = device.type;
    if (type.endsWith('THERMOSTAT')) {
      await this.createThermostat(device, id, label);
    } else if (type.endsWith('CAMERA') || type.endsWith('DOORBELL') || type.endsWith('DISPLAY')) {
      await this.createCamera(device, id, label);
    } else if (type.includes('SMOKE') || type.includes('PROTECT')) {
      await this.createProtect(device, id, label);
    } else {
      this.log.info(`Skipping unsupported Nest device type ${type}`);
    }
  }

  /**
   * Create a Matter thermostat endpoint mapped to a Nest thermostat.
   *
   * @param {NestDevice} device - The SDM device.
   * @param {string} id - Short device id.
   * @param {string} label - Display name.
   * @returns {Promise<void>} Resolves once registered.
   */
  private async createThermostat(device: NestDevice, id: string, label: string): Promise<void> {
    const endpoint = new MatterbridgeEndpoint([thermostatDevice, temperatureSensor, humiditySensor, powerSource], { id: `nest-${id}` })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(label, id, this.matterbridge.aggregatorVendorId, 'Google Nest', 'Nest Thermostat')
      .createDefaultThermostatClusterServer(2000, 2100, 2400)
      .createDefaultTemperatureMeasurementClusterServer(2000)
      .createDefaultRelativeHumidityMeasurementClusterServer(5000)
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers();

    await this.registerDevice(endpoint);
    this.entries.set(id, { endpoint, name: device.name, type: 'thermostat' });

    // Push Matter controller changes to the Nest API.
    await endpoint.subscribeAttribute(
      'Thermostat',
      'systemMode',
      (value: Thermostat.SystemMode) => {
        void this.pushMode(device.name, value);
      },
      this.log,
    );
    await endpoint.subscribeAttribute(
      'Thermostat',
      'occupiedHeatingSetpoint',
      (value: number) => {
        void this.client.executeCommand(device.name, `${SETPOINT_TRAIT}.SetHeat`, { heatCelsius: value / 100 }).catch((e) => this.log.error(`SetHeat failed: ${(e as Error).message}`));
      },
      this.log,
    );
    await endpoint.subscribeAttribute(
      'Thermostat',
      'occupiedCoolingSetpoint',
      (value: number) => {
        void this.client.executeCommand(device.name, `${SETPOINT_TRAIT}.SetCool`, { coolCelsius: value / 100 }).catch((e) => this.log.error(`SetCool failed: ${(e as Error).message}`));
      },
      this.log,
    );
  }

  /**
   * Create a Matter endpoint for a Nest camera/doorbell (online state + motion).
   *
   * @param {NestDevice} device - The SDM device.
   * @param {string} id - Short device id.
   * @param {string} label - Display name.
   * @returns {Promise<void>} Resolves once registered.
   */
  private async createCamera(device: NestDevice, id: string, label: string): Promise<void> {
    const endpoint = new MatterbridgeEndpoint([occupancySensor, contactSensor], { id: `nest-${id}` })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(label, id, this.matterbridge.aggregatorVendorId, 'Google Nest', 'Nest Camera')
      .createDefaultOccupancySensingClusterServer(false)
      .createDefaultBooleanStateClusterServer(false) // true = online
      .addRequiredClusterServers();

    await this.registerDevice(endpoint);
    this.entries.set(id, { endpoint, name: device.name, type: 'camera' });
  }

  /**
   * Create a Matter Smoke/CO alarm endpoint for a Nest Protect (read-only).
   *
   * @param {NestDevice} device - The SDM device.
   * @param {string} id - Short device id.
   * @param {string} label - Display name.
   * @returns {Promise<void>} Resolves once registered.
   */
  private async createProtect(device: NestDevice, id: string, label: string): Promise<void> {
    const endpoint = new MatterbridgeEndpoint([smokeCoAlarm, powerSource], { id: `nest-${id}` })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(label, id, this.matterbridge.aggregatorVendorId, 'Google Nest', 'Nest Protect')
      .createDefaultSmokeCOAlarmClusterServer(SmokeCoAlarm.AlarmState.Normal, SmokeCoAlarm.AlarmState.Normal)
      .createDefaultPowerSourceReplaceableBatteryClusterServer(100)
      .addRequiredClusterServers();

    await this.registerDevice(endpoint);
    this.entries.set(id, { endpoint, name: device.name, type: 'protect' });
  }

  /**
   * Map a Matter SystemMode to an SDM thermostat mode and push it.
   *
   * @param {string} name - SDM device resource name.
   * @param {Thermostat.SystemMode} mode - The new Matter system mode.
   * @returns {Promise<void>} Resolves once the command is sent.
   */
  private async pushMode(name: string, mode: Thermostat.SystemMode): Promise<void> {
    const map: Record<number, string> = {
      [Thermostat.SystemMode.Off]: 'OFF',
      [Thermostat.SystemMode.Auto]: 'HEATCOOL',
      [Thermostat.SystemMode.Cool]: 'COOL',
      [Thermostat.SystemMode.Heat]: 'HEAT',
    };
    const sdmMode = map[mode] ?? 'OFF';
    try {
      await this.client.executeCommand(name, `${MODE_TRAIT}.SetMode`, { mode: sdmMode });
    } catch (e) {
      this.log.error(`SetMode failed: ${(e as Error).message}`);
    }
  }

  /**
   * Poll all registered devices and update their Matter attributes.
   *
   * @returns {Promise<void>} Resolves once all devices are refreshed.
   */
  private async refreshAll(): Promise<void> {
    if (!this.client.configured) return;
    for (const entry of this.entries.values()) {
      try {
        const device = await this.client.getDevice(entry.name);
        if (entry.type === 'thermostat') await this.updateThermostat(entry.endpoint, device);
        else if (entry.type === 'camera') await this.updateCamera(entry.endpoint, device);
        else await this.updateProtect(entry.endpoint, device);
      } catch (e) {
        this.log.error(`Refresh failed for ${entry.name}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Update a thermostat endpoint from SDM traits.
   *
   * @param {MatterbridgeEndpoint} endpoint - The endpoint.
   * @param {NestDevice} device - The SDM device.
   * @returns {Promise<void>} Resolves once attributes are updated.
   */
  private async updateThermostat(endpoint: MatterbridgeEndpoint, device: NestDevice): Promise<void> {
    const t = device.traits;
    const temp = (t[TEMP_TRAIT] as { ambientTemperatureCelsius?: number })?.ambientTemperatureCelsius;
    const hum = (t[HUMIDITY_TRAIT] as { ambientHumidityPercent?: number })?.ambientHumidityPercent;
    const setpoint = t[SETPOINT_TRAIT] as { heatCelsius?: number; coolCelsius?: number } | undefined;
    const mode = (t[MODE_TRAIT] as { mode?: string })?.mode;
    const hvac = (t[HVAC_TRAIT] as { status?: string })?.status;

    if (typeof temp === 'number') {
      await endpoint.updateAttribute('Thermostat', 'localTemperature', Math.round(temp * 100), this.log);
      await endpoint.updateAttribute(TemperatureMeasurement.Cluster.id, 'measuredValue', Math.round(temp * 100), this.log);
    }
    if (typeof hum === 'number') {
      await endpoint.updateAttribute(RelativeHumidityMeasurement.Cluster.id, 'measuredValue', Math.round(hum * 100), this.log);
    }
    if (typeof setpoint?.heatCelsius === 'number') {
      await endpoint.updateAttribute('Thermostat', 'occupiedHeatingSetpoint', Math.round(setpoint.heatCelsius * 100), this.log);
    }
    if (typeof setpoint?.coolCelsius === 'number') {
      await endpoint.updateAttribute('Thermostat', 'occupiedCoolingSetpoint', Math.round(setpoint.coolCelsius * 100), this.log);
    }
    if (mode) {
      const m: Record<string, Thermostat.SystemMode> = {
        OFF: Thermostat.SystemMode.Off,
        HEAT: Thermostat.SystemMode.Heat,
        COOL: Thermostat.SystemMode.Cool,
        HEATCOOL: Thermostat.SystemMode.Auto,
      };
      await endpoint.updateAttribute('Thermostat', 'systemMode', m[mode] ?? Thermostat.SystemMode.Off, this.log);
    }
    if (hvac) {
      const running = { heat: hvac === 'HEATING', cool: hvac === 'COOLING', fan: false, heatStage2: false, coolStage2: false, fanStage2: false, fanStage3: false };
      await endpoint.updateAttribute('Thermostat', 'thermostatRunningState', running, this.log);
    }
  }

  /**
   * Update a camera/doorbell endpoint online state from SDM traits.
   *
   * @param {MatterbridgeEndpoint} endpoint - The endpoint.
   * @param {NestDevice} device - The SDM device.
   * @returns {Promise<void>} Resolves once attributes are updated.
   */
  private async updateCamera(endpoint: MatterbridgeEndpoint, device: NestDevice): Promise<void> {
    const status = (device.traits[CONNECTIVITY_TRAIT] as { status?: string })?.status;
    if (status) {
      await endpoint.updateAttribute(BooleanState.Cluster.id, 'stateValue', status === 'ONLINE', this.log);
    }
  }

  /**
   * Public/person event handler that pulses the occupancy sensor of a camera.
   * Wire this to an SDM Pub/Sub event subscription.
   *
   * @param {string} id - Short device id.
   * @returns {Promise<void>} Resolves once the occupancy is set.
   */
  async triggerMotion(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.type !== 'camera') return;
    await entry.endpoint.updateAttribute(OccupancySensing.Cluster.id, 'occupancy', { occupied: true }, this.log);
    setTimeout(() => {
      void entry.endpoint.updateAttribute(OccupancySensing.Cluster.id, 'occupancy', { occupied: false }, this.log);
    }, 10000);
  }

  /**
   * Update a Nest Protect endpoint alarm/battery state from SDM traits.
   *
   * @param {MatterbridgeEndpoint} endpoint - The endpoint.
   * @param {NestDevice} device - The SDM device.
   * @returns {Promise<void>} Resolves once attributes are updated.
   */
  private async updateProtect(endpoint: MatterbridgeEndpoint, device: NestDevice): Promise<void> {
    const t = device.traits;
    const smoke = (t['sdm.devices.traits.SmokeAlarm'] as { state?: string })?.state;
    const co = (t['sdm.devices.traits.CoAlarm'] as { state?: string })?.state;
    const battery = (t['sdm.devices.traits.BatteryStatus'] as { percent?: number })?.percent;

    if (smoke) {
      await endpoint.updateAttribute('SmokeCoAlarm', 'smokeState', smoke === 'EMERGENCY' ? SmokeCoAlarm.AlarmState.Critical : SmokeCoAlarm.AlarmState.Normal, this.log);
    }
    if (co) {
      await endpoint.updateAttribute('SmokeCoAlarm', 'coState', co === 'EMERGENCY' ? SmokeCoAlarm.AlarmState.Critical : SmokeCoAlarm.AlarmState.Normal, this.log);
    }
    if (typeof battery === 'number') {
      await endpoint.updateAttribute('PowerSource', 'batPercentRemaining', Math.round(battery * 2), this.log);
    }
  }
}
