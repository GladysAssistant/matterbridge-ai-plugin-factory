/**
 * Matterbridge plugin for Enphase Envoy / IQ Gateway (solar inverters, batteries).
 *
 * Exposes read-only Matter sensors: solar production power/energy (and optional
 * per micro-inverter production), net grid consumption power/energy, optional
 * battery state of charge and power, gateway temperature and network status.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { BasePlatformConfig, contactSensor, electricalSensor, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformMatterbridge, powerSource, temperatureSensor } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { SolarPower } from 'matterbridge/devices';

import { EnphaseClient } from './enphase.js';

/** Instance configuration for the Enphase Envoy platform. */
export type EnphasePlatformConfig = BasePlatformConfig & {
  envoyIp?: string;
  serialNumber?: string;
  enlightenEmail?: string;
  enlightenPassword?: string;
  token?: string;
  installerUser?: boolean;
  hasBattery?: boolean;
  showInverters?: boolean;
  pollInterval?: number;
};

/**
 * Plugin entry point invoked by Matterbridge.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The logger instance.
 * @param {EnphasePlatformConfig} config - The platform configuration.
 * @returns {EnphasePlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: EnphasePlatformConfig): EnphasePlatform {
  return new EnphasePlatform(matterbridge, log, config);
}

/** Dynamic platform that bridges an Enphase Envoy / IQ Gateway as Matter sensors. */
export class EnphasePlatform extends MatterbridgeDynamicPlatform {
  private client?: EnphaseClient;
  private pollTimer?: NodeJS.Timeout;

  private production?: SolarPower;
  private consumption?: MatterbridgeEndpoint;
  private battery?: MatterbridgeEndpoint;
  private temperature?: MatterbridgeEndpoint;
  private network?: MatterbridgeEndpoint;
  private readonly panels = new Map<string, MatterbridgeEndpoint>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: EnphasePlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing Enphase Envoy / IQ Gateway platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const config = this.config as EnphasePlatformConfig;
    // A blank serialNumber must not leak into device serials/uniqueIds: an empty string passes "??"
    // and yields degenerate ids like "EnvoyConsumption-", which controllers (e.g. Gladys) drop.
    const serial = config.serialNumber?.trim() || 'envoy';

    // Build the API client first so micro-inverters can be enumerated before registration.
    if (config.envoyIp) {
      this.client = new EnphaseClient(
        {
          envoyIp: config.envoyIp,
          serialNumber: serial,
          enlightenEmail: config.enlightenEmail,
          enlightenPassword: config.enlightenPassword,
          token: config.token,
          installerUser: config.installerUser,
        },
        this.log,
      );
    } else {
      this.log.warn('No "envoyIp" configured: devices are registered but will not be updated with live data.');
    }

    // Solar production device. Per micro-inverter child panels must be added BEFORE the device is
    // registered: child endpoints cannot be attached once the device is live on the Matter server.
    this.production = new SolarPower('Solar Production', `${serial}-prod`);
    if (this.client && config.showInverters) {
      try {
        await this.client.authenticate();
        const data = await this.client.poll();
        // Each child panel needs a UNIQUE semantic tag. Sibling endpoints sharing the same device
        // type and identical tagList violate Matter disambiguation, so every panel but the first is
        // dropped and the inverters disappear. Use the Number namespace (0x07) with an incrementing tag.
        let panelIndex = 0;
        for (const inv of data.inverters) {
          const panel = this.production.addPanel(`Inverter ${inv.serial}`, { mfgCode: null, namespaceId: 0x07, tag: panelIndex, label: inv.serial }, null, null, inv.powerW);
          this.panels.set(inv.serial, panel);
          panelIndex++;
        }
        this.log.info(`Added ${this.panels.size} micro-inverter panel(s) to Solar Production`);
      } catch (error) {
        this.log.error(`Failed to enumerate micro-inverters: ${(error as Error).message}`);
      }
    }
    await this.registerDevice(this.production);

    // Net grid consumption as a generic electrical sensor.
    this.consumption = new MatterbridgeEndpoint(electricalSensor, { id: `EnvoyConsumption-${serial}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer('Grid Consumption', `${serial}-grid`, this.matterbridge.aggregatorVendorId, 'Enphase', 'Envoy Grid Meter', 1, '1.0.0')
      .createDefaultPowerTopologyClusterServer()
      .createDefaultElectricalPowerMeasurementClusterServer()
      .createDefaultElectricalEnergyMeasurementClusterServer()
      .addRequiredClusterServers();
    await this.registerDevice(this.consumption);

    // Optional battery storage exposed as a rechargeable power source + electrical sensor.
    if (config.hasBattery) {
      this.battery = new MatterbridgeEndpoint([powerSource, electricalSensor], { id: `EnvoyBattery-${serial}` })
        .createDefaultBridgedDeviceBasicInformationClusterServer('Solar Battery', `${serial}-batt`, this.matterbridge.aggregatorVendorId, 'Enphase', 'IQ Battery', 1, '1.0.0')
        .createDefaultPowerSourceRechargeableBatteryClusterServer(100)
        .createDefaultPowerTopologyClusterServer()
        .createDefaultElectricalPowerMeasurementClusterServer()
        .addRequiredClusterServers();
      await this.registerDevice(this.battery);
    }

    // Gateway temperature sensor.
    this.temperature = new MatterbridgeEndpoint(temperatureSensor, { id: `EnvoyTemp-${serial}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer('Gateway Temperature', `${serial}-temp`, this.matterbridge.aggregatorVendorId, 'Enphase', 'Envoy Temperature', 1, '1.0.0')
      .addRequiredClusterServers();
    await this.registerDevice(this.temperature);

    // Network/grid status as a contact sensor (contact = online).
    this.network = new MatterbridgeEndpoint(contactSensor, { id: `EnvoyNetwork-${serial}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer('Gateway Network', `${serial}-net`, this.matterbridge.aggregatorVendorId, 'Enphase', 'Envoy Network Status', 1, '1.0.0')
      .addRequiredClusterServers();
    await this.registerDevice(this.network);
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    if (this.client) {
      try {
        await this.client.authenticate();
      } catch (error) {
        this.log.error(`Enphase authentication failed: ${(error as Error).message}`);
      }
      await this.refresh();
      const intervalMs = Math.max(15, (this.config as EnphasePlatformConfig).pollInterval ?? 30) * 1000;
      this.pollTimer = setInterval(() => void this.refresh(), intervalMs);
    }
  }

  /** Poll the Envoy and push values onto the registered Matter endpoints. */
  private async refresh(): Promise<void> {
    if (!this.client) return;
    let data;
    try {
      data = await this.client.poll();
    } catch (error) {
      this.log.error(`Failed to poll Envoy: ${(error as Error).message}`);
      return;
    }

    // Production power and lifetime energy. The energy is written to BOTH the exported and imported
    // cumulative-energy attributes: a solar source exports its generation, but Matter controllers
    // (e.g. Home Assistant) often surface the "Solar Production" energy from the imported sensor,
    // which would otherwise stay at 0 kWh.
    const productionEnergyMWh = Math.round(data.productionLifetimeWh * 1000);
    await this.production?.updateAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(data.productionPowerW * 1000), this.log);
    await this.production?.updateAttribute('ElectricalEnergyMeasurement', 'cumulativeEnergyExported', { energy: productionEnergyMWh }, this.log);
    await this.production?.updateAttribute('ElectricalEnergyMeasurement', 'cumulativeEnergyImported', { energy: productionEnergyMWh }, this.log);

    // Per micro-inverter production panels (child endpoints created up-front in onStart).
    if ((this.config as EnphasePlatformConfig).showInverters) {
      for (const inv of data.inverters) {
        const panel = this.panels.get(inv.serial);
        await panel?.updateAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(inv.powerW * 1000), this.log);
      }
    }

    // Net grid consumption.
    await this.consumption?.updateAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(data.consumptionNetPowerW * 1000), this.log);
    await this.consumption?.updateAttribute('ElectricalEnergyMeasurement', 'cumulativeEnergyImported', { energy: Math.round(Math.abs(data.consumptionNetWh) * 1000) }, this.log);

    // Battery state of charge and power.
    if (this.battery) {
      if (data.batterySoc !== null) await this.battery.updateAttribute('PowerSource', 'batPercentRemaining', Math.max(0, Math.min(200, Math.round(data.batterySoc * 2))), this.log);
      if (data.batteryPowerW !== null) await this.battery.updateAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(data.batteryPowerW * 1000), this.log);
    }

    // Gateway temperature in 0.01 °C.
    if (data.gatewayTempC !== null) await this.temperature?.updateAttribute('TemperatureMeasurement', 'measuredValue', Math.round(data.gatewayTempC * 100), this.log);

    // Network status: contact (true) = online.
    await this.network?.updateAttribute('BooleanState', 'stateValue', data.networkUp, this.log);

    this.log.debug(`Refreshed: production=${data.productionPowerW}W net=${data.consumptionNetPowerW}W soc=${data.batterySoc ?? 'n/a'}%`);
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
