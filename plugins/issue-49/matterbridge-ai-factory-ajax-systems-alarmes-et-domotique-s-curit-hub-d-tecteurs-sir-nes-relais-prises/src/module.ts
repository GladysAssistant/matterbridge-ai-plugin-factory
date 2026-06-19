/**
 * Matterbridge plugin for Ajax Systems (alarmes et domotique : Hub, détecteurs, sirènes, relais, prises).
 *
 * Exposes an Ajax installation in Matter: alarm panel arm/disarm/night, contact/motion/smoke/leak/glass
 * sensors, relays/sockets/dimmers, sirens, battery and mains state. Connection via official REST API,
 * reverse-engineered gRPC cloud gateway, or local SIA DC-09 listener.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { contactSensor, dimmableLight, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, modeSelect, occupancySensor, onOffOutlet, PlatformMatterbridge, powerSource, smokeCoAlarm, temperatureSensor, waterLeakDetector } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { LevelControl, OnOff } from 'matterbridge/matter/clusters';

import { AjaxClient } from './ajaxClient.js';
import type { AjaxArmState, AjaxDevice, AjaxPlatformConfig } from './types.js';

/** Arm modes exposed through the ModeSelect cluster of the panel device. */
const PANEL_MODES = [
  { label: 'Disarmed', mode: 0, semanticTags: [] },
  { label: 'Armed Away', mode: 1, semanticTags: [] },
  { label: 'Night Mode', mode: 2, semanticTags: [] },
];

/**
 * Matterbridge entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger.
 * @param {AjaxPlatformConfig} config - Platform configuration.
 * @returns {AjaxPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: AjaxPlatformConfig): AjaxPlatform {
  return new AjaxPlatform(matterbridge, log, config);
}

/** Dynamic platform exposing Ajax Systems devices over Matter. */
export class AjaxPlatform extends MatterbridgeDynamicPlatform {
  private readonly client: AjaxClient;
  private readonly endpoints = new Map<string, MatterbridgeEndpoint>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: AjaxPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing Platform...');
    this.client = new AjaxClient(config, this.log);
    this.client.on('error', (err: Error) => this.log.error(`Ajax client error: ${err.message}`));
    this.client.on('arm', (hubId: string, state: AjaxArmState) => void this.updatePanel(hubId, state));
    this.client.on('update', (dev: AjaxDevice) => void this.applyState(dev));
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    await this.client.connect();
    for (const dev of this.client.getDevices()) await this.addDevice(dev);
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    for (const dev of this.client.getDevices()) {
      const ep = this.endpoints.get(dev.id);
      if (!ep) continue;
      this.log.info(`Configuring device ${ep.deviceName} with id ${dev.id}`);
      await this.applyState(dev);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    await this.client.disconnect();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /** Build, validate and register a Matter endpoint for an Ajax device. */
  private async addDevice(dev: AjaxDevice): Promise<void> {
    if (this.endpoints.has(dev.id)) {
      await this.applyState(dev);
      return;
    }
    const endpoint = this.buildEndpoint(dev);
    if (!endpoint) return;

    this.setSelectDevice(dev.id, dev.name);
    if (!this.validateDevice([dev.name, dev.id])) return;

    this.endpoints.set(dev.id, endpoint);
    await this.registerDevice(endpoint);
  }

  /** Create the endpoint for a device based on its logical kind. */
  private buildEndpoint(dev: AjaxDevice): MatterbridgeEndpoint | undefined {
    const battery = typeof dev.battery === 'number';
    const withPower = (ep: MatterbridgeEndpoint): MatterbridgeEndpoint => {
      if (battery) ep.createDefaultPowerSourceReplaceableBatteryClusterServer(dev.battery);
      else if (dev.mains) ep.createDefaultPowerSourceWiredClusterServer();
      return ep;
    };
    const info = (ep: MatterbridgeEndpoint): MatterbridgeEndpoint =>
      ep.createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, dev.id, this.matterbridge.aggregatorVendorId, 'Ajax Systems', dev.model ?? 'Ajax Device');

    switch (dev.kind) {
      case 'panel': {
        const ep = new MatterbridgeEndpoint(modeSelect, { id: dev.id });
        info(ep).createDefaultModeSelectClusterServer(dev.name, PANEL_MODES, 0, 0);
        ep.addRequiredClusterServers();
        ep.addCommandHandler('ModeSelect.changeToMode', (data) => {
          const mode = Number((data.request as { newMode?: number }).newMode ?? 0);
          const state: AjaxArmState = mode === 1 ? 'armed' : mode === 2 ? 'night' : 'disarmed';
          this.log.info(`Panel ${dev.name}: arm command -> ${state}`);
          void this.client.setArmState(dev.hubId ?? dev.id, state, false);
        });
        return ep;
      }
      case 'hub': {
        const ep = new MatterbridgeEndpoint([powerSource], { id: dev.id });
        info(ep);
        if (battery) ep.createDefaultPowerSourceReplaceableBatteryClusterServer(dev.battery);
        else ep.createDefaultPowerSourceWiredClusterServer();
        return ep.addRequiredClusterServers();
      }
      case 'door':
      case 'glass':
      case 'tamper': {
        const ep = new MatterbridgeEndpoint(battery ? [contactSensor, powerSource] : [contactSensor], { id: dev.id });
        info(ep).createDefaultBooleanStateClusterServer(true);
        return withPower(ep).addRequiredClusterServers();
      }
      case 'motion': {
        const ep = new MatterbridgeEndpoint(battery ? [occupancySensor, powerSource] : [occupancySensor], { id: dev.id });
        info(ep);
        return withPower(ep).addRequiredClusterServers();
      }
      case 'smoke': {
        const ep = new MatterbridgeEndpoint(battery ? [smokeCoAlarm, powerSource] : [smokeCoAlarm], { id: dev.id });
        info(ep);
        return withPower(ep).addRequiredClusterServers();
      }
      case 'leak': {
        const ep = new MatterbridgeEndpoint(battery ? [waterLeakDetector, powerSource] : [waterLeakDetector], { id: dev.id });
        info(ep).createDefaultBooleanStateClusterServer(false);
        return withPower(ep).addRequiredClusterServers();
      }
      case 'temperature': {
        const ep = new MatterbridgeEndpoint(battery ? [temperatureSensor, powerSource] : [temperatureSensor], { id: dev.id });
        info(ep).createDefaultTemperatureMeasurementClusterServer(Math.round((dev.temperature ?? 0) * 100));
        return withPower(ep).addRequiredClusterServers();
      }
      case 'relay':
      case 'socket':
      case 'siren': {
        const ep = new MatterbridgeEndpoint(battery ? [onOffOutlet, powerSource] : [onOffOutlet], { id: dev.id });
        info(ep).createDefaultOnOffClusterServer(dev.state ?? false);
        withPower(ep).addRequiredClusterServers();
        ep.addCommandHandler('on', () => {
          this.log.info(`Command on called on cluster onOff (${dev.name})`);
          void this.client.setOnOff(dev.id, true);
        });
        ep.addCommandHandler('off', () => {
          this.log.info(`Command off called on cluster onOff (${dev.name})`);
          void this.client.setOnOff(dev.id, false);
        });
        return ep;
      }
      case 'dimmer': {
        const ep = new MatterbridgeEndpoint(battery ? [dimmableLight, powerSource] : [dimmableLight], { id: dev.id });
        info(ep)
          .createDefaultOnOffClusterServer(dev.state ?? false)
          .createDefaultLevelControlClusterServer(this.pctToLevel(dev.brightness ?? 0));
        withPower(ep).addRequiredClusterServers();
        ep.addCommandHandler('on', () => void this.client.setOnOff(dev.id, true));
        ep.addCommandHandler('off', () => void this.client.setOnOff(dev.id, false));
        const onLevel = (data: { request: unknown }): void => {
          const level = Number((data.request as { level?: number }).level ?? 0);
          void this.client.setBrightness(dev.id, this.levelToPct(level));
        };
        ep.addCommandHandler('moveToLevel', onLevel);
        ep.addCommandHandler('moveToLevelWithOnOff', onLevel);
        return ep;
      }
      default:
        this.log.debug(`Skipping unsupported Ajax device ${dev.name} (${dev.model ?? 'unknown'})`);
        return undefined;
    }
  }

  /** Push the latest Ajax device state into the matching Matter endpoint. */
  private async applyState(dev: AjaxDevice): Promise<void> {
    const ep = this.endpoints.get(dev.id);
    if (!ep) {
      await this.addDevice(dev);
      return;
    }
    try {
      switch (dev.kind) {
        case 'door':
        case 'glass':
        case 'tamper':
          // Matter contact: stateValue true = contact closed/safe; sensor "active" (open/triggered) -> false.
          await ep.setAttribute('BooleanState', 'stateValue', !(dev.state ?? false) && !(dev.tamper ?? false));
          break;
        case 'motion':
          await ep.setAttribute('OccupancySensing', 'occupancy', { occupied: dev.state ?? false });
          break;
        case 'leak':
          await ep.setAttribute('BooleanState', 'stateValue', dev.state ?? false);
          break;
        case 'smoke':
          await ep.setAttribute('SmokeCoAlarm', 'smokeState', dev.state ? 2 : 0);
          break;
        case 'temperature':
          if (typeof dev.temperature === 'number') await ep.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(dev.temperature * 100));
          break;
        case 'relay':
        case 'socket':
        case 'siren':
          await ep.setAttribute(OnOff.Cluster.id, 'onOff', dev.state ?? false);
          break;
        case 'dimmer':
          await ep.setAttribute(OnOff.Cluster.id, 'onOff', dev.state ?? false);
          if (typeof dev.brightness === 'number') await ep.setAttribute(LevelControl.Cluster.id, 'currentLevel', this.pctToLevel(dev.brightness));
          break;
        default:
          break;
      }
      if (typeof dev.battery === 'number' && ep.hasAttributeServer('PowerSource', 'batPercentRemaining')) {
        await ep.setAttribute('PowerSource', 'batPercentRemaining', Math.max(0, Math.min(200, Math.round(dev.battery * 2))));
      }
    } catch (err) {
      this.log.debug(`applyState failed for ${dev.name}: ${(err as Error).message}`);
    }
  }

  /** Reflect a panel arm-state change in the ModeSelect cluster. */
  private async updatePanel(hubId: string, state: AjaxArmState): Promise<void> {
    const mode = state === 'armed' ? 1 : state === 'night' ? 2 : 0;
    for (const [id, ep] of this.endpoints) {
      if (!ep.hasClusterServer('ModeSelect')) continue;
      const dev = this.client.getDevices().find((d) => d.id === id);
      if (dev && dev.hubId !== hubId && id !== hubId && id !== `${hubId}-panel`) continue;
      try {
        await ep.setAttribute('ModeSelect', 'currentMode', mode);
      } catch (err) {
        this.log.debug(`updatePanel failed: ${(err as Error).message}`);
      }
    }
  }

  private pctToLevel(pct: number): number {
    return Math.max(0, Math.min(254, Math.round((pct / 100) * 254)));
  }

  private levelToPct(level: number): number {
    return Math.max(0, Math.min(100, Math.round((level / 254) * 100)));
  }
}
