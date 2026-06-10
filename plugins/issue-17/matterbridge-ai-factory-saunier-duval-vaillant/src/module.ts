/**
 * Matterbridge plugin for Saunier Duval / Vaillant (myVAILLANT / MiGo cloud).
 *
 * Exposes each heating zone as a Matter thermostat with:
 *  - inside temperature (localTemperature)
 *  - target/setpoint temperature (occupiedHeatingSetpoint)
 *  - relative humidity
 *  - operation mode: Off / Auto (program) / Heat (manual), with away shown as Off
 * and the system outdoor temperature as a dedicated temperature sensor.
 *
 * @file module.ts
 * @author Matterbridge AI Factory
 * @license Apache-2.0
 */

import { BasePlatformConfig, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformMatterbridge } from 'matterbridge';
import { humiditySensor, temperatureSensor, thermostatDevice } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { Thermostat } from 'matterbridge/matter/clusters';

import { OperationMode, VaillantClient, ZoneStatus } from './vaillantClient.js';

const VENDOR_ID = 0xfff1;

/** Instance configuration for this platform. */
export type VaillantPlatformConfig = BasePlatformConfig & {
  username?: string;
  password?: string;
  country?: string;
  brand?: string;
  pollInterval?: number;
  whiteList: string[];
  blackList: string[];
};

interface ZoneBinding {
  device: MatterbridgeEndpoint;
  systemId: string;
  zoneIndex: number;
  status: ZoneStatus;
}

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger instance.
 * @param {VaillantPlatformConfig} config - Platform configuration.
 * @returns {VaillantPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: VaillantPlatformConfig): VaillantPlatform {
  return new VaillantPlatform(matterbridge, log, config);
}

/** Dynamic platform exposing Vaillant / Saunier Duval heating zones. */
export class VaillantPlatform extends MatterbridgeDynamicPlatform {
  private client?: VaillantClient;
  private readonly zones = new Map<string, ZoneBinding>();
  private pollTimer?: ReturnType<typeof setInterval>;

  /**
   * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
   * @param {AnsiLogger} log - Logger instance.
   * @param {VaillantPlatformConfig} config - Platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: VaillantPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.7.3')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.7.3". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }
    this.log.info('Initializing Saunier Duval / Vaillant platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const cfg = this.config as VaillantPlatformConfig;
    if (!cfg.username || !cfg.password) {
      this.log.warn('No credentials configured. Set username, password, country and brand in the plugin config.');
      return;
    }

    this.client = new VaillantClient(
      { username: cfg.username, password: cfg.password, country: cfg.country ?? 'germany', brand: cfg.brand ?? 'vaillant' },
      this.log,
    );

    try {
      await this.client.login();
      await this.discoverDevices();
    } catch (err) {
      this.log.error(`Failed to connect to Vaillant cloud: ${(err as Error).message}`);
    }
  }

  private async discoverDevices(): Promise<void> {
    if (!this.client) return;
    const systemIds = await this.client.getSystemIds();
    this.log.info(`Discovered ${systemIds.length} system(s)`);

    for (const systemId of systemIds) {
      const state = await this.client.getSystemState(systemId);

      // One thermostat per heating zone.
      for (const zone of state.zones) {
        const serial = `${systemId}-z${zone.index}`;
        const name = zone.name;
        this.setSelectDevice(serial, name);
        if (!this.validateDevice([name, serial])) continue;

        const device = new MatterbridgeEndpoint([thermostatDevice, humiditySensor], { id: serial })
          .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, VENDOR_ID, 'Vaillant', 'myVAILLANT Zone', 1, '1.0.0')
          .createDefaultIdentifyClusterServer()
          .createDefaultThermostatClusterServer(zone.currentTemperature ?? 20, zone.setpoint ?? 20, 20, 0, 5, 30, 16, 30)
          .createDefaultRelativeHumidityMeasurementClusterServer(zone.humidity !== null ? zone.humidity * 100 : null)
          .addRequiredClusterServers();

        await this.registerDevice(device);
        this.zones.set(serial, { device, systemId, zoneIndex: zone.index, status: zone.status });
      }

      // System outdoor temperature sensor.
      const outdoorSerial = `${systemId}-outdoor`;
      this.setSelectDevice(outdoorSerial, 'Outdoor Temperature');
      if (this.validateDevice(['Outdoor Temperature', outdoorSerial])) {
        const outdoor = new MatterbridgeEndpoint([temperatureSensor], { id: outdoorSerial })
          .createDefaultBridgedDeviceBasicInformationClusterServer('Outdoor Temperature', outdoorSerial, VENDOR_ID, 'Vaillant', 'myVAILLANT Outdoor', 1, '1.0.0')
          .createDefaultIdentifyClusterServer()
          .createDefaultTemperatureMeasurementClusterServer(state.outdoorTemperature !== null ? state.outdoorTemperature * 100 : null)
          .addRequiredClusterServers();
        await this.registerDevice(outdoor);
        this.zones.set(outdoorSerial, { device: outdoor, systemId, zoneIndex: -1, status: 'off' });
      }
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    for (const [serial, binding] of this.zones) {
      if (binding.zoneIndex < 0) continue; // outdoor sensor, no control
      await this.pushZoneState(binding);

      // Operation mode: Off -> OFF, Auto -> TIME_CONTROLLED (program), Heat -> MANUAL.
      await binding.device.subscribeAttribute(
        Thermostat.Cluster.id,
        'systemMode',
        (value: number) => {
          void this.onModeChange(serial, value);
        },
        this.log,
      );

      // Setpoint changes (manual mode target temperature, value is in centi-°C).
      await binding.device.subscribeAttribute(
        Thermostat.Cluster.id,
        'occupiedHeatingSetpoint',
        (value: number) => {
          void this.onSetpointChange(serial, value);
        },
        this.log,
      );
    }

    this.startPolling();
  }

  private async onModeChange(serial: string, value: number): Promise<void> {
    const binding = this.zones.get(serial);
    if (!binding || !this.client) return;
    let mode: OperationMode;
    if (value === Thermostat.SystemMode.Off) mode = 'OFF';
    else if (value === Thermostat.SystemMode.Auto) mode = 'TIME_CONTROLLED';
    else mode = 'MANUAL'; // Heat
    this.log.info(`Set zone ${serial} mode -> ${mode}`);
    try {
      await this.client.setOperationMode(binding.systemId, binding.zoneIndex, mode);
    } catch (err) {
      this.log.error(`Failed to set mode for ${serial}: ${(err as Error).message}`);
    }
  }

  private async onSetpointChange(serial: string, value: number): Promise<void> {
    const binding = this.zones.get(serial);
    if (!binding || !this.client) return;
    const setpoint = Math.round((value / 100) * 2) / 2; // 0.5 °C steps
    this.log.info(`Set zone ${serial} setpoint -> ${setpoint} °C`);
    try {
      await this.client.setSetpoint(binding.systemId, binding.zoneIndex, setpoint);
    } catch (err) {
      this.log.error(`Failed to set setpoint for ${serial}: ${(err as Error).message}`);
    }
  }

  private startPolling(): void {
    const cfg = this.config as VaillantPlatformConfig;
    const interval = Math.max(60, cfg.pollInterval ?? 300) * 1000;
    this.pollTimer = setInterval(() => {
      void this.refreshAll();
    }, interval);
  }

  private async refreshAll(): Promise<void> {
    if (!this.client) return;
    const systemIds = new Set([...this.zones.values()].map((b) => b.systemId));
    for (const systemId of systemIds) {
      try {
        const state = await this.client.getSystemState(systemId);
        const outdoor = this.zones.get(`${systemId}-outdoor`);
        if (outdoor && state.outdoorTemperature !== null) {
          await outdoor.device.updateAttribute('TemperatureMeasurement', 'measuredValue', state.outdoorTemperature * 100, this.log);
        }
        for (const zone of state.zones) {
          const binding = this.zones.get(`${systemId}-z${zone.index}`);
          if (binding) {
            binding.status = zone.status;
            await this.pushZoneState(binding, zone.currentTemperature, zone.setpoint, zone.humidity);
          }
        }
      } catch (err) {
        this.log.error(`Polling failed for ${systemId}: ${(err as Error).message}`);
      }
    }
  }

  private async pushZoneState(binding: ZoneBinding, temp?: number | null, setpoint?: number | null, humidity?: number | null): Promise<void> {
    const dev = binding.device;
    if (temp !== undefined && temp !== null) await dev.updateAttribute(Thermostat.Cluster.id, 'localTemperature', temp * 100, this.log);
    if (setpoint !== undefined && setpoint !== null) await dev.updateAttribute(Thermostat.Cluster.id, 'occupiedHeatingSetpoint', setpoint * 100, this.log);
    if (humidity !== undefined && humidity !== null) await dev.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', humidity * 100, this.log);

    // Map logical status to systemMode. Away is surfaced as Off.
    const mode =
      binding.status === 'manual'
        ? Thermostat.SystemMode.Heat
        : binding.status === 'program'
          ? Thermostat.SystemMode.Auto
          : Thermostat.SystemMode.Off;
    await dev.updateAttribute(Thermostat.Cluster.id, 'systemMode', mode, this.log);
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
}
