/**
 * Matterbridge plugin for Hitachi Hi-Kumo air conditioning units (Overkiz cloud).
 *
 * Capabilities:
 *  - Turn the air conditioning on and off.
 *  - Set the target temperature.
 *  - Choose the operating mode: Cooling, Heating, Dehumidification, Auto, Frost protection.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { airConditioner, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge, powerSource } from 'matterbridge';
import { ModeSelect, Thermostat } from 'matterbridge/matter/clusters';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { HiKumoApi, OverkizDevice, OverkizMode, OVERKIZ_MODE } from './hiKumoApi.js';

/** ModeSelect options exposing the five required Hi-Kumo modes. */
const MODE_OPTIONS: { label: string; mode: number; semanticTags: never[]; overkiz: OverkizMode; systemMode: Thermostat.SystemMode }[] = [
  { label: 'Automatique', mode: 1, semanticTags: [], overkiz: OVERKIZ_MODE.auto, systemMode: Thermostat.SystemMode.Auto },
  { label: 'Climatisation', mode: 2, semanticTags: [], overkiz: OVERKIZ_MODE.cooling, systemMode: Thermostat.SystemMode.Cool },
  { label: 'Chauffage', mode: 3, semanticTags: [], overkiz: OVERKIZ_MODE.heating, systemMode: Thermostat.SystemMode.Heat },
  { label: 'Déshumidification', mode: 4, semanticTags: [], overkiz: OVERKIZ_MODE.dehumidify, systemMode: Thermostat.SystemMode.Dry },
  { label: 'Hors-gel', mode: 5, semanticTags: [], overkiz: OVERKIZ_MODE.frostprotection, systemMode: Thermostat.SystemMode.Auto },
];

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger instance.
 * @param {PlatformConfig} config - Platform configuration.
 * @returns {HiKumoPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): HiKumoPlatform {
  return new HiKumoPlatform(matterbridge, log, config);
}

/** Dynamic platform exposing Hitachi Hi-Kumo climate units as Matter air conditioners. */
export class HiKumoPlatform extends MatterbridgeDynamicPlatform {
  private api?: HiKumoApi;
  private readonly deviceUrls = new Map<string, string>(); // endpoint id -> deviceURL

  /**
   * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
   * @param {AnsiLogger} log - Logger instance.
   * @param {PlatformConfig} config - Platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version.`);
    }

    this.log.info('Initializing Hitachi Hi-Kumo platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();
    await this.discoverDevices();
  }

  /** Fetch the Hi-Kumo devices and register a Matter air conditioner for each. */
  private async discoverDevices(): Promise<void> {
    const username = (this.config.username as string) ?? '';
    const password = (this.config.password as string) ?? '';
    const server = (this.config.server as string) ?? 'europe';

    let devices: OverkizDevice[] = [];
    if (username && password) {
      try {
        this.api = new HiKumoApi(username, password, server, this.log);
        await this.api.login();
        devices = await this.api.getClimateDevices();
        this.log.info(`Found ${devices.length} Hi-Kumo climate device(s)`);
      } catch (error) {
        this.log.error(`Hi-Kumo discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      this.log.warn('No Hi-Kumo credentials configured: registering a demo air conditioner.');
    }

    if (devices.length === 0) {
      devices = [{ deviceURL: 'hikumo://demo/ac1', label: 'Climatisation', controllableName: 'HitachiAirToAirHeatPump' }];
    }

    const usedSerials = new Set<string>();
    for (const device of devices) {
      try {
        await this.registerClimate(device, usedSerials);
      } catch (error) {
        this.log.error(`Failed to register Hi-Kumo device ${device.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Build and register one air conditioner endpoint.
   *
   * @param {OverkizDevice} device - Source Overkiz device.
   * @param {Set<string>} usedSerials - Serials already assigned, used to guarantee uniqueness.
   */
  private async registerClimate(device: OverkizDevice, usedSerials: Set<string>): Promise<void> {
    let serial = device.deviceURL.replace(/[^A-Za-z0-9]/g, '').slice(-16) || 'HIKUMO0001';
    while (usedSerials.has(serial)) serial = `${serial.slice(0, 14)}${usedSerials.size.toString().padStart(2, '0')}`;
    usedSerials.add(serial);
    const name = device.label || 'Hi-Kumo';

    const endpoint = new MatterbridgeEndpoint([airConditioner, powerSource], { id: `hikumo-${serial}` })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Hitachi', 'Hi-Kumo', 1, '1.0.0')
      .createDefaultPowerSourceWiredClusterServer()
      .createDeadFrontOnOffClusterServer(true)
      .createDefaultThermostatClusterServer(21, 21, 25, 1, 16, 32, 16, 32)
      .createDefaultModeSelectClusterServer('Mode', MODE_OPTIONS.map(({ label, mode, semanticTags }) => ({ label, mode, semanticTags })), 1, 1)
      .addRequiredClusterServers();

    // Allumer / éteindre la climatisation.
    endpoint.addCommandHandler('on', async () => {
      this.log.info(`${name}: on`);
      await this.api?.setOnOff(device.deviceURL, true);
    });
    endpoint.addCommandHandler('off', async () => {
      this.log.info(`${name}: off`);
      await this.api?.setOnOff(device.deviceURL, false);
    });

    this.setSelectDevice(serial, name);
    if (this.validateDevice([name, serial])) {
      await this.registerDevice(endpoint);
      this.deviceUrls.set(endpoint.originalId ?? serial, device.deviceURL);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    for (const endpoint of this.getDevices()) {
      const deviceURL = this.deviceUrls.get(endpoint.originalId ?? "");
      if (!deviceURL) continue;

      // Choisir le mode.
      await endpoint.subscribeAttribute(
        ModeSelect.Cluster.id,
        'currentMode',
        (newValue: number) => {
          const option = MODE_OPTIONS.find((o) => o.mode === newValue);
          if (!option) return;
          this.log.info(`${endpoint.deviceName}: mode -> ${option.label}`);
          void endpoint.updateAttribute(Thermostat.Cluster.id, 'systemMode', option.systemMode, this.log);
          void this.api?.setMode(deviceURL, option.overkiz);
        },
        this.log,
      );

      // Régler la température.
      await endpoint.subscribeAttribute(
        Thermostat.Cluster.id,
        'occupiedCoolingSetpoint',
        (newValue: number) => {
          this.log.info(`${endpoint.deviceName}: cooling setpoint -> ${newValue / 100} °C`);
          void this.api?.setTargetTemperature(deviceURL, newValue / 100);
        },
        this.log,
      );
      await endpoint.subscribeAttribute(
        Thermostat.Cluster.id,
        'occupiedHeatingSetpoint',
        (newValue: number) => {
          this.log.info(`${endpoint.deviceName}: heating setpoint -> ${newValue / 100} °C`);
          void this.api?.setTargetTemperature(deviceURL, newValue / 100);
        },
        this.log,
      );

      // Allumer / éteindre via le mode système du thermostat.
      await endpoint.subscribeAttribute(
        Thermostat.Cluster.id,
        'systemMode',
        (newValue: Thermostat.SystemMode) => {
          void this.api?.setOnOff(deviceURL, newValue !== Thermostat.SystemMode.Off);
        },
        this.log,
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    this.deviceUrls.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }
}
