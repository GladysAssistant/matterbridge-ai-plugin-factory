/**
 * Matterbridge SwitchBot plugin (OpenAPI cloud).
 *
 * Supports: Bot, Curtain, Lock, Meter / Meter Plus, Motion Sensor,
 * Contact Sensor, Plug Mini, Fan. Hub 2/3 IR gateway is out of scope (v1).
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  contactSensor,
  coverDevice,
  doorLockDevice,
  fanDevice,
  humiditySensor,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  occupancySensor,
  onOffOutlet,
  onOffSwitch,
  PlatformMatterbridge,
  temperatureSensor,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { DoorLock, FanControl } from 'matterbridge/matter/clusters';

import { SwitchBotApi, SwitchBotDevice, SwitchBotStatus } from './switchbotApi.js';

/** Strongly typed plugin configuration. */
export type SwitchBotPlatformConfig = BasePlatformConfig & {
  token?: string;
  secret?: string;
  pollingInterval?: number;
  botMode?: 'switch' | 'press';
  whiteList: string[];
  blackList: string[];
};

interface RegisteredDevice {
  sb: SwitchBotDevice;
  endpoint: MatterbridgeEndpoint;
}

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The plugin logger.
 * @param {SwitchBotPlatformConfig} config - The plugin configuration.
 * @returns {SwitchBotPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: SwitchBotPlatformConfig): SwitchBotPlatform {
  return new SwitchBotPlatform(matterbridge, log, config);
}

/** SwitchBot dynamic platform. */
export class SwitchBotPlatform extends MatterbridgeDynamicPlatform {
  private api?: SwitchBotApi;
  private readonly devices = new Map<string, RegisteredDevice>();
  private pollTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
   * @param {AnsiLogger} log - The plugin logger.
   * @param {SwitchBotPlatformConfig} config - The plugin configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: SwitchBotPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.7.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.7.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion}.`);
    }

    this.log.info('Initializing SwitchBot Platform...');
  }

  private get cfg(): SwitchBotPlatformConfig {
    return this.config as SwitchBotPlatformConfig;
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const { token, secret } = this.cfg;
    if (!token || !secret) {
      this.log.error('SwitchBot token and secret are required. Set them in the plugin config (SwitchBot app > Developer Options).');
      return;
    }
    this.api = new SwitchBotApi(token, secret, this.log);

    try {
      await this.discoverDevices();
    } catch (error) {
      this.log.error(`Device discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    await this.pollAll();

    const interval = Math.max(60, this.cfg.pollingInterval ?? 60) * 1000;
    this.pollTimer = setInterval(() => {
      this.pollAll().catch((e) => this.log.error(`Polling error: ${e instanceof Error ? e.message : String(e)}`));
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
    this.devices.clear();
    if (this.cfg.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  private async discoverDevices(): Promise<void> {
    if (!this.api) return;
    this.log.info('Discovering SwitchBot devices...');
    const list = await this.api.getDevices();
    this.log.info(`Found ${list.length} SwitchBot device(s)`);

    for (const sb of list) {
      const endpoint = this.buildEndpoint(sb);
      if (!endpoint) {
        this.log.debug(`Skipping unsupported device ${sb.deviceName} (${sb.deviceType})`);
        continue;
      }
      this.setSelectDevice(sb.deviceId, sb.deviceName);
      if (!this.validateDevice([sb.deviceName, sb.deviceId])) continue;

      endpoint.addRequiredClusterServers();
      await this.registerDevice(endpoint);
      this.devices.set(sb.deviceId, { sb, endpoint });
      this.log.info(`Registered ${sb.deviceName} (${sb.deviceType})`);
    }
  }

  /**
   * Map a SwitchBot device to a Matterbridge endpoint with command handlers.
   *
   * @param {SwitchBotDevice} sb - The SwitchBot device descriptor.
   * @returns {MatterbridgeEndpoint | undefined} The endpoint, or undefined if unsupported.
   */
  private buildEndpoint(sb: SwitchBotDevice): MatterbridgeEndpoint | undefined {
    const t = sb.deviceType;

    if (this.isPlug(t)) {
      return this.makeEndpoint(onOffOutlet, sb)
        .createDefaultOnOffClusterServer(false)
        .addCommandHandler('on', () => this.cmd(sb.deviceId, 'turnOn'))
        .addCommandHandler('off', () => this.cmd(sb.deviceId, 'turnOff'));
    }

    if (t === 'Bot') {
      const press = this.cfg.botMode === 'press';
      const ep = this.makeEndpoint(onOffSwitch, sb).createDefaultOnOffClusterServer(false);
      ep.addCommandHandler('on', () => this.cmd(sb.deviceId, press ? 'press' : 'turnOn'));
      ep.addCommandHandler('off', () => this.cmd(sb.deviceId, press ? 'press' : 'turnOff'));
      return ep;
    }

    if (this.isCurtain(t)) {
      const ep = this.makeEndpoint(coverDevice, sb).createDefaultWindowCoveringClusterServer(0);
      ep.addCommandHandler('upOrOpen', async () => {
        await this.cmd(sb.deviceId, 'turnOn');
        await ep.setWindowCoveringTargetAndCurrentPosition(0);
      });
      ep.addCommandHandler('downOrClose', async () => {
        await this.cmd(sb.deviceId, 'turnOff');
        await ep.setWindowCoveringTargetAndCurrentPosition(10000);
      });
      ep.addCommandHandler('stopMotion', () => this.cmd(sb.deviceId, 'pause'));
      ep.addCommandHandler('goToLiftPercentage', async (data) => {
        const lift = (data.request as { liftPercent100thsValue: number }).liftPercent100thsValue;
        const position = Math.round(lift / 100); // 0..100, 0 = open
        await this.cmd(sb.deviceId, 'setPosition', `0,ff,${position}`);
        await ep.setWindowCoveringTargetAndCurrentPosition(lift);
      });
      return ep;
    }

    if (this.isLock(t)) {
      const ep = this.makeEndpoint(doorLockDevice, sb).createDefaultDoorLockClusterServer(DoorLock.LockState.Locked);
      ep.addCommandHandler('lockDoor', async () => {
        await this.cmd(sb.deviceId, 'lock');
        await ep.setAttribute('DoorLock', 'lockState', DoorLock.LockState.Locked, ep.log);
      });
      ep.addCommandHandler('unlockDoor', async () => {
        await this.cmd(sb.deviceId, 'unlock');
        await ep.setAttribute('DoorLock', 'lockState', DoorLock.LockState.Unlocked, ep.log);
      });
      return ep;
    }

    if (this.isMeter(t)) {
      return this.makeEndpoint([temperatureSensor, humiditySensor], sb)
        .createDefaultTemperatureMeasurementClusterServer(2000)
        .createDefaultRelativeHumidityMeasurementClusterServer(5000);
    }

    if (this.isMotion(t)) {
      return this.makeEndpoint(occupancySensor, sb).createDefaultOccupancySensingClusterServer(false);
    }

    if (this.isContact(t)) {
      return this.makeEndpoint(contactSensor, sb).createDefaultBooleanStateClusterServer(true);
    }

    if (this.isFan(t)) {
      const ep = this.makeEndpoint(fanDevice, sb).createDefaultFanControlClusterServer(FanControl.FanMode.Off);
      ep.addCommandHandler('on', () => this.cmd(sb.deviceId, 'turnOn'));
      ep.addCommandHandler('off', () => this.cmd(sb.deviceId, 'turnOff'));
      return ep;
    }

    return undefined;
  }

  private isPlug(t: string): boolean {
    return t === 'Plug' || t.startsWith('Plug Mini');
  }

  private isCurtain(t: string): boolean {
    return t === 'Curtain' || t === 'Curtain3' || t === 'Blind Tilt';
  }

  private isLock(t: string): boolean {
    return t === 'Smart Lock' || t === 'Smart Lock Pro';
  }

  private isMeter(t: string): boolean {
    return t === 'Meter' || t === 'MeterPlus' || t === 'Meter Plus' || t === 'WoIOSensor' || t === 'Hub 2' || t === 'Hub 3';
  }

  private isMotion(t: string): boolean {
    return t === 'Motion Sensor' || t === 'WoPresence';
  }

  private isContact(t: string): boolean {
    return t === 'Contact Sensor' || t === 'WoContact';
  }

  private isFan(t: string): boolean {
    return t === 'Fan' || t === 'Battery Circulator Fan' || t === 'Circulator Fan';
  }

  /**
   * Create a bridged endpoint shell with identity metadata.
   *
   * @param {ConstructorParameters<typeof MatterbridgeEndpoint>[0]} deviceType - The Matter device type(s).
   * @param {SwitchBotDevice} sb - The SwitchBot device descriptor.
   * @returns {MatterbridgeEndpoint} The new endpoint.
   */
  private makeEndpoint(deviceType: ConstructorParameters<typeof MatterbridgeEndpoint>[0], sb: SwitchBotDevice): MatterbridgeEndpoint {
    return new MatterbridgeEndpoint(deviceType, { id: sb.deviceId }).createDefaultBridgedDeviceBasicInformationClusterServer(
      sb.deviceName,
      sb.deviceId,
      this.matterbridge.aggregatorVendorId,
      'SwitchBot',
      sb.deviceType,
    );
  }

  private async cmd(deviceId: string, command: string, parameter: string | object = 'default'): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.sendCommand(deviceId, command, parameter);
    } catch (error) {
      this.log.error(`Command ${command} on ${deviceId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Poll status for all registered devices and push state into Matter. */
  private async pollAll(): Promise<void> {
    if (!this.api) return;
    for (const { sb, endpoint } of this.devices.values()) {
      try {
        const status = await this.api.getStatus(sb.deviceId);
        await this.applyStatus(sb, endpoint, status);
      } catch (error) {
        this.log.debug(`Status poll failed for ${sb.deviceName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Push a SwitchBot status payload into the matching Matter attributes.
   *
   * @param {SwitchBotDevice} sb - The SwitchBot device descriptor.
   * @param {MatterbridgeEndpoint} ep - The endpoint to update.
   * @param {SwitchBotStatus} status - The status payload from the cloud.
   * @returns {Promise<void>} Resolves when the attributes are updated.
   */
  private async applyStatus(sb: SwitchBotDevice, ep: MatterbridgeEndpoint, status: SwitchBotStatus): Promise<void> {
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
    const t = sb.deviceType;

    if (this.isPlug(t) || t === 'Bot') {
      if (status.power !== undefined) await ep.setAttribute('OnOff', 'onOff', status.power === 'on', ep.log);
    }

    if (this.isCurtain(t)) {
      const pos = num(status.slidePosition);
      if (pos !== undefined) await ep.setWindowCoveringTargetAndCurrentPosition(Math.round(pos * 100));
    }

    if (this.isLock(t) && status.lockState !== undefined) {
      const locked = status.lockState === 'locked';
      await ep.setAttribute('DoorLock', 'lockState', locked ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked, ep.log);
    }

    if (this.isMeter(t)) {
      const temp = num(status.temperature);
      if (temp !== undefined) await ep.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(temp * 100), ep.log);
      const hum = num(status.humidity);
      if (hum !== undefined) await ep.setAttribute('RelativeHumidityMeasurement', 'measuredValue', Math.round(hum * 100), ep.log);
    }

    if (this.isMotion(t) && status.moveDetected !== undefined) {
      await ep.setAttribute('OccupancySensing', 'occupancy', { occupied: status.moveDetected === true }, ep.log);
    }

    if (this.isContact(t) && status.openState !== undefined) {
      // Matter BooleanState: true = contact/closed
      await ep.setAttribute('BooleanState', 'stateValue', status.openState === 'close', ep.log);
    }

    if (this.isFan(t) && status.power !== undefined) {
      await ep.setAttribute('FanControl', 'fanMode', status.power === 'on' ? FanControl.FanMode.On : FanControl.FanMode.Off, ep.log);
    }
  }
}
