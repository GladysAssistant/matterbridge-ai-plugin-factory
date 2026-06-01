/**
 * Matterbridge plugin for Smappee EV Wall Home.
 *
 * Exposes Smappee actuators (Comfort Plug / Output module / Switch) as on/off outlets and
 * the Smappee energy data (House consumption, EV Wall charging, Solar production) as Matter
 * electrical sensors using the ElectricalPowerMeasurement and ElectricalEnergyMeasurement
 * clusters via the Smappee Developer API v3.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { electricalSensor, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, onOffOutlet, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { SmappeeApi, SmappeeConsumptionRecord, SmappeeMeteringConfiguration } from './smappee.js';

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

/** Energy meter role exposed as a distinct Matter endpoint. */
type MeterRole = 'house' | 'ev' | 'solar';

interface EnergyMeter {
  endpoint: MatterbridgeEndpoint;
  role: MeterRole;
  /** Whether this meter reports produced energy (solar) instead of consumed energy. */
  exported: boolean;
  /** Accumulated energy in watt-hours. */
  cumulativeWh: number;
}

/** Smappee dynamic platform. */
export class SmappeePlatform extends MatterbridgeDynamicPlatform {
  private api?: SmappeeApi;
  private serviceLocationId = 0;
  private metering?: SmappeeMeteringConfiguration;
  private pollTimer?: NodeJS.Timeout;
  private readonly meters: EnergyMeter[] = [];

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
    // Actuators -> on/off outlets with command handlers (control, not energy reporting).
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

    // Energy meters -> distinct electrical sensors using the measurement clusters.
    await this.createMeter('house', `${metering.name} House Consumption`, `smappee-house-${this.serviceLocationId}`, false);
    await this.createMeter('ev', `${metering.name} EV Wall Charging`, `smappee-ev-${this.serviceLocationId}`, false);
    await this.createMeter('solar', `${metering.name} Solar Production`, `smappee-solar-${this.serviceLocationId}`, true);
  }

  /**
   * Create an electrical sensor endpoint exposing power and energy measurement clusters.
   *
   * @param {MeterRole} role - The Smappee energy channel this endpoint represents.
   * @param {string} name - The human readable device name.
   * @param {string} serial - The unique serial number for the bridged device.
   * @param {boolean} exported - True for produced energy (solar), false for consumed energy.
   * @returns {Promise<void>} Resolves once the device is registered.
   */
  private async createMeter(role: MeterRole, name: string, serial: string, exported: boolean): Promise<void> {
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const endpoint = new MatterbridgeEndpoint(electricalSensor, { id: `meter-${role}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Smappee', 'Smappee Energy Meter', 1, '1.0.0')
      .createDefaultPowerTopologyClusterServer()
      .createDefaultElectricalPowerMeasurementClusterServer()
      .createDefaultElectricalEnergyMeasurementClusterServer()
      .addRequiredClusterServers();

    await this.registerDevice(endpoint);
    this.meters.push({ endpoint, role, exported, cumulativeWh: 0 });
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
    let records: SmappeeConsumptionRecord[] = [];
    try {
      // Aggregation 1 = 5-minute buckets.
      records = await this.api.getElectricityConsumption(this.serviceLocationId, from, to, 1);
    } catch (error) {
      this.log.debug(`Failed to fetch Smappee consumption: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const last = records.at(-1);
    if (!last) return;

    for (const meter of this.meters) {
      try {
        const wh = this.extractEnergyWh(meter.role, last);
        // 5-minute bucket -> instantaneous power (W) = energy (Wh) * 12.
        const watts = wh * 12;
        meter.cumulativeWh += wh;
        await this.publishMeter(meter, watts, meter.cumulativeWh);
      } catch (error) {
        this.log.debug(`Failed to update meter ${meter.role}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Extract the energy in watt-hours for a meter role from a Smappee consumption record.
   *
   * @param {MeterRole} role - The meter role.
   * @param {SmappeeConsumptionRecord} record - The latest consumption record.
   * @returns {number} The energy in watt-hours (always non-negative).
   */
  private extractEnergyWh(role: MeterRole, record: SmappeeConsumptionRecord): number {
    let value: number;
    switch (role) {
      case 'solar':
        value = record.solar ?? 0;
        break;
      case 'ev':
        value = record.evCharging ?? record.active ?? 0;
        break;
      default:
        value = record.consumption ?? 0;
        break;
    }
    return Math.max(0, Number(value));
  }

  /**
   * Publish power and energy values to the measurement clusters of a meter endpoint.
   *
   * @param {EnergyMeter} meter - The meter to update.
   * @param {number} watts - The instantaneous active power in watts.
   * @param {number} cumulativeWh - The accumulated energy in watt-hours.
   * @returns {Promise<void>} Resolves once the attributes are updated.
   */
  private async publishMeter(meter: EnergyMeter, watts: number, cumulativeWh: number): Promise<void> {
    // ElectricalPowerMeasurement.activePower is expressed in mW.
    await meter.endpoint.updateAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(watts * 1000), this.log);
    // ElectricalEnergyMeasurement cumulative energy is expressed in mWh.
    const energy = { energy: Math.round(cumulativeWh * 1000) };
    const attribute = meter.exported ? 'cumulativeEnergyExported' : 'cumulativeEnergyImported';
    await meter.endpoint.updateAttribute('ElectricalEnergyMeasurement', attribute, energy, this.log);
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
