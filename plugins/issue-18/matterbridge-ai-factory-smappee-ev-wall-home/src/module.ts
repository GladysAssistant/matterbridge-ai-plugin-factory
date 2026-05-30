/**
 * Matterbridge plugin for Smappee EV Wall Home.
 *
 * Exposes Smappee actuators (Comfort Plug / Output module / Switch) as on/off outlets and
 * Smappee switches/sensors/electricity meters as electrical sensors using the Smappee
 * Developer API v3.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { electricalSensor, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, onOffOutlet, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { SmappeeApi, SmappeeMeteringConfiguration } from './smappee.js';

/**
 * Standard Matterbridge plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The logger instance.
 * @param {PlatformConfig} config - The platform configuration.
 * @returns {SmappeePlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): SmappeePlatform {
  return new SmappeePlatform(matterbridge, log, config);
}

interface MeterEndpoint {
  endpoint: MatterbridgeEndpoint;
  kind: 'electricity' | 'switch' | 'sensor';
  id: number;
}

/** Smappee dynamic platform. */
export class SmappeePlatform extends MatterbridgeDynamicPlatform {
  private api?: SmappeeApi;
  private serviceLocationId = 0;
  private metering?: SmappeeMeteringConfiguration;
  private pollTimer?: NodeJS.Timeout;
  private readonly meters: MeterEndpoint[] = [];

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.log.info('Initializing Smappee platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const { clientId, clientSecret, username, password } = this.config as Record<string, string>;
    if (!clientId || !clientSecret || !username || !password) {
      this.log.error('Smappee credentials missing. Set clientId, clientSecret, username and password in the plugin config.');
      return;
    }

    this.api = new SmappeeApi({ clientId, clientSecret, username, password }, this.log);

    try {
      await this.api.authenticate();
      const locations = await this.api.getServiceLocations();
      if (locations.length === 0) {
        this.log.warn('No Smappee service locations found.');
        return;
      }
      const configured = Number(this.config.serviceLocationId);
      const location = locations.find((l) => l.serviceLocationId === configured) ?? locations[0];
      this.serviceLocationId = location.serviceLocationId;
      this.log.info(`Using service location ${location.name} (${this.serviceLocationId})`);

      this.metering = await this.api.getMeteringConfiguration(this.serviceLocationId);
      await this.createDevices(this.metering);
    } catch (error) {
      this.log.error(`Smappee startup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createDevices(metering: SmappeeMeteringConfiguration): Promise<void> {
    // Actuators -> on/off outlets with command handlers.
    for (const actuator of metering.actuators) {
      const serial = actuator.serialNumber ?? `smappee-actuator-${actuator.id}`;
      const name = actuator.name || `Smappee Actuator ${actuator.id}`;
      this.setSelectDevice(serial, name);
      if (!this.validateDevice([name, serial])) continue;

      const outlet = new MatterbridgeEndpoint(onOffOutlet, { id: `actuator-${actuator.id}` })
        .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Smappee', 'Smappee Actuator', 1, '1.0.0')
        .createDefaultPowerSourceWiredClusterServer()
        .addRequiredClusterServers()
        .addCommandHandler('on', async () => {
          await this.safeSetActuator(actuator.id, true);
        })
        .addCommandHandler('off', async () => {
          await this.safeSetActuator(actuator.id, false);
        });
      await this.registerDevice(outlet);
    }

    // Switch consumption meters.
    for (const measurement of metering.measurements) {
      await this.createMeter('switch', measurement.id, measurement.name || `Smappee Switch ${measurement.id}`, `smappee-switch-${measurement.id}`);
    }

    // Sensor consumption meters.
    for (const sensor of metering.sensors) {
      await this.createMeter('sensor', sensor.id, sensor.name || `Smappee Sensor ${sensor.id}`, `smappee-sensor-${sensor.id}`);
    }

    // Overall electricity consumption meter for the service location.
    await this.createMeter('electricity', this.serviceLocationId, `${metering.name} Electricity`, `smappee-electricity-${this.serviceLocationId}`);
  }

  private async createMeter(kind: MeterEndpoint['kind'], id: number, name: string, serial: string): Promise<void> {
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const endpoint = new MatterbridgeEndpoint(electricalSensor, { id: `${kind}-${id}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Smappee', 'Smappee Meter', 1, '1.0.0')
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers();

    await this.registerDevice(endpoint);
    this.meters.push({ endpoint, kind, id });
  }

  private async safeSetActuator(actuatorId: number, on: boolean): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.setActuator(this.serviceLocationId, actuatorId, on);
      this.log.info(`Actuator ${actuatorId} turned ${on ? 'on' : 'off'}`);
    } catch (error) {
      this.log.error(`Failed to switch actuator ${actuatorId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    await this.updateMeters();
    const interval = Math.max(60, Number(this.config.pollInterval) || 300) * 1000;
    this.pollTimer = setInterval(() => {
      void this.updateMeters();
    }, interval);
  }

  private async updateMeters(): Promise<void> {
    if (!this.api) return;
    const to = Date.now();
    const from = to - 10 * 60 * 1000;
    for (const meter of this.meters) {
      try {
        const records = await this.fetchRecords(meter, from, to);
        const last = records.at(-1);
        if (!last) continue;
        const watts = Number(last.active ?? last.consumption ?? 0);
        // ElectricalPowerMeasurement.activePower is expressed in mW.
        await meter.endpoint.updateAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(watts * 1000), this.log);
      } catch (error) {
        this.log.debug(`Failed to update meter ${meter.kind}-${meter.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async fetchRecords(meter: MeterEndpoint, from: number, to: number) {
    if (!this.api) return [];
    switch (meter.kind) {
      case 'switch':
        return this.api.getSwitchConsumption(this.serviceLocationId, meter.id, from, to);
      case 'sensor':
        return this.api.getSensorConsumption(this.serviceLocationId, meter.id, from, to);
      default:
        return this.api.getElectricityConsumption(this.serviceLocationId, from, to);
    }
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
