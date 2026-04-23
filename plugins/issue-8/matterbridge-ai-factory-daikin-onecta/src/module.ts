/**
 * Matterbridge plugin for Daikin Onecta cloud air conditioners.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { airConditioner, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge, powerSource } from 'matterbridge';
import { Thermostat } from 'matterbridge/matter/clusters';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { DaikinClient, DaikinDevice } from './daikinClient.js';

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger.
 * @param {PlatformConfig} config - Plugin config.
 * @returns {DaikinOnectaPlatform} Platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): DaikinOnectaPlatform {
  return new DaikinOnectaPlatform(matterbridge, log, config);
}

export class DaikinOnectaPlatform extends MatterbridgeDynamicPlatform {
  private client?: DaikinClient;
  private pollInterval?: NodeJS.Timeout;
  private readonly endpoints = new Map<string, MatterbridgeEndpoint>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`);
    }

    this.log.info('Initializing Daikin Onecta platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    this.client = new DaikinClient(
      {
        email: this.config.email as string | undefined,
        password: this.config.password as string | undefined,
        tokenFile: this.config.tokenFile as string | undefined,
      },
      this.log,
      this.matterbridge.matterbridgeDirectory,
    );
    await this.client.initialize();

    const devices = await this.client.getDevices();
    for (const device of devices) {
      this.setSelectDevice(device.id, device.name);
      if (!this.validateDevice([device.name, device.id])) continue;
      await this.addDevice(device);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    if (!this.client) return;
    for (const device of await this.client.getDevices()) {
      await this.wireSubscriptions(device);
      await this.refreshDevice(device);
    }

    const intervalMs = Math.max(30, (this.config.pollInterval as number | undefined) ?? 60) * 1000;
    this.pollInterval = setInterval(() => {
      this.poll().catch((error: unknown) => {
        this.log.error(`Polling error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, intervalMs);
  }

  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    this.endpoints.clear();
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private async addDevice(device: DaikinDevice): Promise<void> {
    const endpoint = new MatterbridgeEndpoint([airConditioner, powerSource], { id: `daikin-${device.id}` })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(device.name, device.id, 0xfff1, 'Daikin', device.model ?? 'Onecta AC', 1, '1.0.0')
      .createDefaultPowerSourceWiredClusterServer()
      .createDeadFrontOnOffClusterServer(device.power)
      .createDefaultThermostatClusterServer(device.indoorTemperature, device.heatingSetpoint, device.coolingSetpoint, 1, 10, 32, 16, 32)
      .addRequiredClusterServers();

    endpoint.addCommandHandler('on', async () => {
      this.log.info(`[${device.name}] ON`);
      await this.client?.setPower(device.id, true);
      await endpoint.updateAttribute('OnOff', 'onOff', true, this.log);
    });
    endpoint.addCommandHandler('off', async () => {
      this.log.info(`[${device.name}] OFF`);
      await this.client?.setPower(device.id, false);
      await endpoint.updateAttribute('OnOff', 'onOff', false, this.log);
    });

    await this.registerDevice(endpoint);
    this.endpoints.set(device.id, endpoint);
  }

  private async wireSubscriptions(device: DaikinDevice): Promise<void> {
    const endpoint = this.endpoints.get(device.id);
    if (!endpoint) return;

    await endpoint.subscribeAttribute(
      'Thermostat',
      'systemMode',
      (newValue: Thermostat.SystemMode) => {
        const mode = this.systemModeToDaikin(newValue);
        this.log.info(`[${device.name}] systemMode -> ${Thermostat.SystemMode[newValue]} (${mode})`);
        void this.client?.setMode(device.id, mode);
      },
      this.log,
    );

    await endpoint.subscribeAttribute(
      'Thermostat',
      'occupiedHeatingSetpoint',
      (newValue: number) => {
        const celsius = newValue / 100;
        this.log.info(`[${device.name}] heating setpoint -> ${celsius}°C`);
        void this.client?.setSetpoint(device.id, 'heating', celsius);
      },
      this.log,
    );

    await endpoint.subscribeAttribute(
      'Thermostat',
      'occupiedCoolingSetpoint',
      (newValue: number) => {
        const celsius = newValue / 100;
        this.log.info(`[${device.name}] cooling setpoint -> ${celsius}°C`);
        void this.client?.setSetpoint(device.id, 'cooling', celsius);
      },
      this.log,
    );
  }

  private async refreshDevice(device: DaikinDevice): Promise<void> {
    const endpoint = this.endpoints.get(device.id);
    if (!endpoint) return;
    await endpoint.updateAttribute('OnOff', 'onOff', device.power, this.log);
    await endpoint.updateAttribute('Thermostat', 'localTemperature', Math.round(device.indoorTemperature * 100), this.log);
    await endpoint.updateAttribute('Thermostat', 'occupiedHeatingSetpoint', Math.round(device.heatingSetpoint * 100), this.log);
    await endpoint.updateAttribute('Thermostat', 'occupiedCoolingSetpoint', Math.round(device.coolingSetpoint * 100), this.log);
    await endpoint.updateAttribute('Thermostat', 'systemMode', this.daikinToSystemMode(device.mode), this.log);
  }

  private async poll(): Promise<void> {
    if (!this.client) return;
    for (const device of await this.client.getDevices()) {
      await this.refreshDevice(device);
    }
  }

  private systemModeToDaikin(mode: Thermostat.SystemMode): 'heating' | 'cooling' | 'auto' | 'off' {
    switch (mode) {
      case Thermostat.SystemMode.Heat:
        return 'heating';
      case Thermostat.SystemMode.Cool:
        return 'cooling';
      case Thermostat.SystemMode.Auto:
        return 'auto';
      default:
        return 'off';
    }
  }

  private daikinToSystemMode(mode: string): Thermostat.SystemMode {
    switch (mode) {
      case 'heating':
        return Thermostat.SystemMode.Heat;
      case 'cooling':
        return Thermostat.SystemMode.Cool;
      case 'auto':
        return Thermostat.SystemMode.Auto;
      default:
        return Thermostat.SystemMode.Off;
    }
  }
}
