/**
 * Matterbridge plugin for AVM FRITZ!Box DECT smart home devices.
 *
 * Exposes FRITZ!DECT plugs, lights, thermostats, sensors and roller shutters
 * through the AHA-HTTP interface as Matter devices.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  colorTemperatureLight,
  contactSensor,
  coverDevice,
  dimmableLight,
  electricalSensor,
  humiditySensor,
  onOffLight,
  onOffOutlet,
  powerSource,
  temperatureSensor,
  thermostatDevice,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { Thermostat, WindowCovering } from 'matterbridge/matter/clusters';

import { FritzClient, FritzDevice } from './fritz.js';

/** Instance configuration for the FRITZ!Box platform. */
export type FritzPlatformConfig = BasePlatformConfig & {
  host: string;
  username: string;
  password: string;
  pollInterval: number;
  whiteList: string[];
  blackList: string[];
};

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Plugin logger.
 * @param {FritzPlatformConfig} config - Platform configuration.
 * @returns {FritzPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: FritzPlatformConfig): FritzPlatform {
  return new FritzPlatform(matterbridge, log, config);
}

/** Dynamic platform bridging FRITZ!DECT devices to Matter. */
export class FritzPlatform extends MatterbridgeDynamicPlatform {
  private client?: FritzClient;
  private pollTimer?: NodeJS.Timeout;
  private readonly endpoints = new Map<string, MatterbridgeEndpoint>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: FritzPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }
    this.log.info(`Initializing FRITZ!Box platform...`);
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const config = this.config as FritzPlatformConfig;
    if (!config.host || !config.password) {
      this.log.error('Missing "host" or "password" in configuration. Cannot connect to FRITZ!Box.');
      return;
    }

    this.client = new FritzClient(config.host, config.username ?? '', config.password, this.log);
    try {
      await this.client.login();
    } catch (error) {
      this.log.error(`FRITZ!Box login failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    let devices: FritzDevice[] = [];
    try {
      devices = await this.client.getDeviceList();
    } catch (error) {
      this.log.error(`Failed to fetch device list: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.log.info(`Discovered ${devices.length} FRITZ!DECT device(s).`);

    for (const device of devices) {
      this.setSelectDevice(device.ain, device.name);
      if (!this.validateDevice([device.name, device.ain])) continue;
      const endpoint = this.buildEndpoint(device);
      if (!endpoint) continue;
      this.endpoints.set(device.ain, endpoint);
      await this.registerDevice(endpoint);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    await this.refresh();

    const interval = Math.max(15, Number((this.config as FritzPlatformConfig).pollInterval) || 60) * 1000;
    this.pollTimer = setInterval(() => {
      this.refresh().catch((e) => this.log.error(`Polling error: ${e instanceof Error ? e.message : String(e)}`));
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
    this.endpoints.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /** Build a Matter endpoint for a FRITZ!DECT device, or undefined if unsupported. */
  private buildEndpoint(d: FritzDevice): MatterbridgeEndpoint | undefined {
    if (d.hkr) return this.buildThermostat(d);
    if (d.blind !== undefined) return this.buildBlind(d);
    if (d.hasLight) return this.buildLight(d);
    if (d.switchOn !== undefined) return this.buildPlug(d);
    if (d.temperature !== undefined || d.humidity !== undefined || d.alert !== undefined) return this.buildSensor(d);
    this.log.info(`Skipping unsupported device "${d.name}" (${d.ain}).`);
    return undefined;
  }

  private identity(endpoint: MatterbridgeEndpoint, d: FritzDevice): MatterbridgeEndpoint {
    return endpoint.createDefaultBridgedDeviceBasicInformationClusterServer(d.name, d.ain, this.matterbridge.aggregatorVendorId, 'AVM', d.productname, 1, '1.0.0');
  }

  private buildPlug(d: FritzDevice): MatterbridgeEndpoint {
    const hasEnergy = d.power !== undefined || d.energy !== undefined;
    const endpoint = new MatterbridgeEndpoint(hasEnergy ? [onOffOutlet, electricalSensor] : [onOffOutlet], { id: this.id(d) });
    this.identity(endpoint, d).createDefaultPowerSourceWiredClusterServer().createDefaultOnOffClusterServer(d.switchOn ?? false);
    if (hasEnergy) {
      endpoint
        .createDefaultElectricalPowerMeasurementClusterServer(d.voltage ?? null, null, d.power ?? null)
        .createDefaultElectricalEnergyMeasurementClusterServer(d.energy !== undefined ? d.energy * 1000 : null, null);
    }
    endpoint.addRequiredClusterServers();
    endpoint.addCommandHandler('on', () => void this.client?.setSwitch(d.ain, true));
    endpoint.addCommandHandler('off', () => void this.client?.setSwitch(d.ain, false));
    return endpoint;
  }

  private buildLight(d: FritzDevice): MatterbridgeEndpoint {
    const isCt = d.colorTemperature !== undefined;
    const isDim = d.level !== undefined;
    const type = isCt ? colorTemperatureLight : isDim ? dimmableLight : onOffLight;
    const endpoint = new MatterbridgeEndpoint(type, { id: this.id(d) });
    this.identity(endpoint, d).createDefaultPowerSourceWiredClusterServer().createDefaultOnOffClusterServer((d.switchOn ?? (d.level ?? 0) > 0));
    if (isDim || isCt) endpoint.createDefaultLevelControlClusterServer(d.level && d.level > 0 ? d.level : 1);
    if (isCt) endpoint.createCtColorControlClusterServer(this.kelvinToMireds(d.colorTemperature ?? 2700));
    endpoint.addRequiredClusterServers();

    endpoint.addCommandHandler('on', () => void this.client?.setSwitch(d.ain, true));
    endpoint.addCommandHandler('off', () => void this.client?.setSwitch(d.ain, false));
    if (isDim || isCt) {
      const onLevel = (level: number): void => void this.client?.setLevel(d.ain, level);
      endpoint.addCommandHandler('moveToLevel', ({ request }) => onLevel(request.level));
      endpoint.addCommandHandler('moveToLevelWithOnOff', ({ request }) => onLevel(request.level));
    }
    if (isCt) {
      endpoint.addCommandHandler('moveToColorTemperature', ({ request }) => void this.client?.setColorTemperature(d.ain, this.miredsToKelvin(request.colorTemperatureMireds)));
    }
    return endpoint;
  }

  private buildThermostat(d: FritzDevice): MatterbridgeEndpoint {
    const hkr = d.hkr!;
    const endpoint = new MatterbridgeEndpoint([thermostatDevice, temperatureSensor], { id: this.id(d) });
    this.identity(endpoint, d)
      .createDefaultPowerSourceReplaceableBatteryClusterServer(hkr.battery ?? 100)
      .createDefaultHeatingThermostatClusterServer(this.halfToCenti(hkr.tist), this.halfToCenti(hkr.tsoll), 800, 2800)
      .createDefaultTemperatureMeasurementClusterServer(this.halfToCenti(hkr.tist))
      .addRequiredClusterServers();

    endpoint.subscribeAttribute(
      Thermostat.Cluster.id,
      'occupiedHeatingSetpoint',
      (value: number) => {
        if (typeof value === 'number') void this.client?.setThermostat(d.ain, value / 100);
      },
      this.log,
    );
    endpoint.subscribeAttribute(
      Thermostat.Cluster.id,
      'systemMode',
      (value: number) => {
        if (value === Thermostat.SystemMode.Off) void this.client?.setThermostat(d.ain, 'off');
      },
      this.log,
    );
    return endpoint;
  }

  private buildSensor(d: FritzDevice): MatterbridgeEndpoint {
    const types = [] as typeof temperatureSensor[];
    if (d.temperature !== undefined) types.push(temperatureSensor);
    if (d.humidity !== undefined) types.push(humiditySensor);
    if (d.alert !== undefined) types.push(contactSensor);
    const endpoint = new MatterbridgeEndpoint([...(types as [typeof temperatureSensor]), powerSource], { id: this.id(d) });
    this.identity(endpoint, d).createDefaultPowerSourceReplaceableBatteryClusterServer(100);
    if (d.temperature !== undefined) endpoint.createDefaultTemperatureMeasurementClusterServer(this.tenthToCenti(d.temperature));
    if (d.humidity !== undefined) endpoint.createDefaultRelativeHumidityMeasurementClusterServer(d.humidity * 100);
    if (d.alert !== undefined) endpoint.createDefaultBooleanStateClusterServer(!d.alert); // BooleanState: true = closed/contact
    endpoint.addRequiredClusterServers();
    return endpoint;
  }

  private buildBlind(d: FritzDevice): MatterbridgeEndpoint {
    const endpoint = new MatterbridgeEndpoint(coverDevice, { id: this.id(d) });
    this.identity(endpoint, d)
      .createDefaultPowerSourceWiredClusterServer()
      .createDefaultWindowCoveringClusterServer((d.blind ?? 0) * 100)
      .addRequiredClusterServers();

    endpoint.addCommandHandler('upOrOpen', () => void this.client?.setBlind(d.ain, 0));
    endpoint.addCommandHandler('downOrClose', () => void this.client?.setBlind(d.ain, 100));
    endpoint.addCommandHandler('goToLiftPercentage', ({ request }) => void this.client?.setBlind(d.ain, (request.liftPercent100thsValue ?? 0) / 100));
    return endpoint;
  }

  /** Poll the FRITZ!Box and update all registered endpoint attributes. */
  private async refresh(): Promise<void> {
    if (!this.client) return;
    let devices: FritzDevice[];
    try {
      devices = await this.client.getDeviceList();
    } catch (error) {
      this.log.error(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const d of devices) {
      const endpoint = this.endpoints.get(d.ain);
      if (!endpoint) continue;
      await this.updateEndpoint(endpoint, d);
    }
  }

  private async updateEndpoint(e: MatterbridgeEndpoint, d: FritzDevice): Promise<void> {
    if (d.switchOn !== undefined && e.hasAttributeServer('OnOff', 'onOff')) await e.updateAttribute('OnOff', 'onOff', d.switchOn, this.log);
    if (d.level !== undefined && e.hasAttributeServer('LevelControl', 'currentLevel')) await e.updateAttribute('LevelControl', 'currentLevel', Math.max(1, d.level), this.log);
    if (d.colorTemperature !== undefined && e.hasAttributeServer('ColorControl', 'colorTemperatureMireds'))
      await e.updateAttribute('ColorControl', 'colorTemperatureMireds', this.kelvinToMireds(d.colorTemperature), this.log);
    if (d.power !== undefined && e.hasAttributeServer('ElectricalPowerMeasurement', 'activePower')) await e.updateAttribute('ElectricalPowerMeasurement', 'activePower', d.power, this.log);
    if (d.energy !== undefined && e.hasAttributeServer('ElectricalEnergyMeasurement', 'cumulativeEnergyImported'))
      await e.updateAttribute('ElectricalEnergyMeasurement', 'cumulativeEnergyImported', { energy: d.energy * 1000 }, this.log);
    if (d.temperature !== undefined && e.hasAttributeServer('TemperatureMeasurement', 'measuredValue'))
      await e.updateAttribute('TemperatureMeasurement', 'measuredValue', this.tenthToCenti(d.temperature), this.log);
    if (d.humidity !== undefined && e.hasAttributeServer('RelativeHumidityMeasurement', 'measuredValue'))
      await e.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', d.humidity * 100, this.log);
    if (d.alert !== undefined && e.hasAttributeServer('BooleanState', 'stateValue')) await e.updateAttribute('BooleanState', 'stateValue', !d.alert, this.log);
    if (d.blind !== undefined && e.hasAttributeServer(WindowCovering.Cluster.id, 'currentPositionLiftPercent100ths'))
      await e.updateAttribute(WindowCovering.Cluster.id, 'currentPositionLiftPercent100ths', d.blind * 100, this.log);
    if (d.hkr) {
      if (e.hasAttributeServer('Thermostat', 'localTemperature')) await e.updateAttribute('Thermostat', 'localTemperature', this.halfToCenti(d.hkr.tist), this.log);
      if (e.hasAttributeServer('Thermostat', 'occupiedHeatingSetpoint')) await e.updateAttribute('Thermostat', 'occupiedHeatingSetpoint', this.halfToCenti(d.hkr.tsoll), this.log);
      if (e.hasAttributeServer('TemperatureMeasurement', 'measuredValue')) await e.updateAttribute('TemperatureMeasurement', 'measuredValue', this.halfToCenti(d.hkr.tist), this.log);
    }
  }

  private id(d: FritzDevice): string {
    return `fritz-${d.ain.replace(/[^a-zA-Z0-9]/g, '')}`;
  }

  private tenthToCenti(v: number): number {
    return Math.round(v * 10);
  }

  private halfToCenti(v: number): number {
    return Math.round(v * 50);
  }

  private kelvinToMireds(kelvin: number): number {
    return Math.max(147, Math.min(500, Math.round(1_000_000 / kelvin)));
  }

  private miredsToKelvin(mireds: number): number {
    return Math.round(1_000_000 / mireds);
  }
}
