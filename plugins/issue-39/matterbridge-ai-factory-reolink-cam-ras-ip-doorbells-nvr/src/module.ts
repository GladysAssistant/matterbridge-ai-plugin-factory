/**
 * Matterbridge Reolink plugin.
 *
 * Exposes Reolink IP cameras, doorbells and NVR channels as Matter sensors and
 * switches (no video stream): motion / person / vehicle / animal occupancy,
 * online state, spotlight, siren, IR LED and battery level.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { BasePlatformConfig, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformMatterbridge, contactSensor, occupancySensor, onOffLight, onOffSwitch, powerSource } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { ChannelState, ReolinkHost } from './reolink.js';

/** Plugin configuration. */
export type ReolinkPlatformConfig = BasePlatformConfig & {
  host: string;
  username: string;
  password: string;
  useHttps: boolean;
  port: number;
  channels: number;
  pollInterval: number;
  whiteList: string[];
  blackList: string[];
};

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger instance.
 * @param {ReolinkPlatformConfig} config - Platform configuration.
 * @returns {ReolinkPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: ReolinkPlatformConfig): ReolinkPlatform {
  return new ReolinkPlatform(matterbridge, log, config);
}

/** Per-channel device bookkeeping. */
interface ChannelDevice {
  channel: number;
  name: string;
  device: MatterbridgeEndpoint;
}

/**
 * Dynamic platform exposing Reolink channels as Matter endpoints.
 */
export class ReolinkPlatform extends MatterbridgeDynamicPlatform {
  private host?: ReolinkHost;
  private readonly channelDevices: ChannelDevice[] = [];
  private pollTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
   * @param {AnsiLogger} log - Logger instance.
   * @param {ReolinkPlatformConfig} config - Platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: ReolinkPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`);
    }

    this.log.info('Initializing Reolink Platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const cfg = this.config as ReolinkPlatformConfig;
    let channels: { channel: number; name: string }[] = [];

    if (cfg.host && cfg.username) {
      this.host = new ReolinkHost({ host: cfg.host, username: cfg.username, password: cfg.password, useHttps: cfg.useHttps, port: cfg.port }, this.log);
      try {
        channels = await this.host.getChannels();
        this.log.info(`Discovered ${channels.length} Reolink channel(s) on ${cfg.host}`);
      } catch (error) {
        this.log.error(`Failed to connect to Reolink host ${cfg.host}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      this.log.warn('No host/username configured; using configured channel count.');
    }

    if (channels.length === 0) {
      const count = Math.max(1, cfg.channels ?? 1);
      channels = Array.from({ length: count }, (_, i) => ({ channel: i, name: `Channel ${i}` }));
    }

    for (const ch of channels) {
      await this.createChannelDevice(ch.channel, ch.name);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    await this.pollAll();

    const interval = Math.max(10, (this.config as ReolinkPlatformConfig).pollInterval ?? 30) * 1000;
    this.pollTimer = setInterval(() => {
      void this.pollAll();
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
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Build and register one composed Matter device for a Reolink channel.
   *
   * @param {number} channel - Channel index.
   * @param {string} name - Channel display name.
   * @returns {Promise<void>} Resolves when registered.
   */
  private async createChannelDevice(channel: number, name: string): Promise<void> {
    const serial = `reolink-${(this.config as ReolinkPlatformConfig).host ?? 'host'}-ch${channel}`;

    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    // Each endpoint maps to a feature from the README feature table. The
    // descriptive `${name} <Feature>` label is applied to every endpoint so the
    // controller shows the exact function instead of a bare endpoint number
    // (e.g. "Reolink (Channel 0) 3").

    // Main endpoint: motion occupancy + online contact + battery power source.
    const device = new MatterbridgeEndpoint([occupancySensor, contactSensor, powerSource], { id: `reolink_ch${channel}` })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(`${name} Motion`, serial, this.matterbridge.aggregatorVendorId, 'Reolink', 'Reolink Camera', 1, '1.0.0')
      .createDefaultOccupancySensingClusterServer(false)
      .createDefaultBooleanStateClusterServer(true)
      .createDefaultPowerSourceReplaceableBatteryClusterServer(100)
      .addRequiredClusterServers();
    await device.addFixedLabel('Feature', 'Motion / Online / Battery');

    // AI detection child occupancy sensors.
    const person = device.addChildDeviceType('PersonDetection', occupancySensor, { tagList: [{ mfgCode: null, namespaceId: 0x07, tag: 0, label: 'Person' }] }).createDefaultOccupancySensingClusterServer(false).addRequiredClusterServers();
    const vehicle = device.addChildDeviceType('VehicleDetection', occupancySensor, { tagList: [{ mfgCode: null, namespaceId: 0x07, tag: 1, label: 'Vehicle' }] }).createDefaultOccupancySensingClusterServer(false).addRequiredClusterServers();
    const animal = device.addChildDeviceType('AnimalDetection', occupancySensor, { tagList: [{ mfgCode: null, namespaceId: 0x07, tag: 2, label: 'Animal' }] }).createDefaultOccupancySensingClusterServer(false).addRequiredClusterServers();

    // Actuators: spotlight (light), siren and IR LED (switches).
    const spotlight = device.addChildDeviceType('Spotlight', onOffLight, { tagList: [{ mfgCode: null, namespaceId: 0x07, tag: 3, label: 'Spotlight' }] }).createDefaultOnOffClusterServer(false).addRequiredClusterServers();
    const siren = device.addChildDeviceType('Siren', onOffSwitch, { tagList: [{ mfgCode: null, namespaceId: 0x07, tag: 4, label: 'Siren' }] }).createDefaultOnOffClusterServer(false).addRequiredClusterServers();
    const irLed = device.addChildDeviceType('IRLed', onOffSwitch, { tagList: [{ mfgCode: null, namespaceId: 0x07, tag: 5, label: 'IR LED' }] }).createDefaultOnOffClusterServer(false).addRequiredClusterServers();

    // Give every child a descriptive, function-specific name so the controller
    // never shows ambiguous duplicate "motion"/"switch" entries.
    await person.addFixedLabel('Feature', `${name} Person Detection`);
    await vehicle.addFixedLabel('Feature', `${name} Vehicle Detection`);
    await animal.addFixedLabel('Feature', `${name} Animal Detection`);
    await spotlight.addFixedLabel('Feature', `${name} Spotlight`);
    await siren.addFixedLabel('Feature', `${name} Siren`);
    await irLed.addFixedLabel('Feature', `${name} IR LED`);

    spotlight.addCommandHandler('on', () => this.safe(() => this.host?.setSpotlight(channel, true)));
    spotlight.addCommandHandler('off', () => this.safe(() => this.host?.setSpotlight(channel, false)));
    siren.addCommandHandler('on', () => this.safe(() => this.host?.setSiren(channel, true)));
    siren.addCommandHandler('off', () => this.safe(() => this.host?.setSiren(channel, false)));
    irLed.addCommandHandler('on', () => this.safe(() => this.host?.setIrLed(channel, true)));
    irLed.addCommandHandler('off', () => this.safe(() => this.host?.setIrLed(channel, false)));

    await this.registerDevice(device);
    this.channelDevices.push({ channel, name, device });
  }

  /**
   * Run an async action, logging any error.
   *
   * @param {() => Promise<unknown> | undefined} fn - Action to run.
   * @returns {Promise<void>} Resolves when done.
   */
  private async safe(fn: () => Promise<unknown> | undefined): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.log.error(`Reolink command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Poll every channel and push state to the Matter attributes.
   *
   * @returns {Promise<void>} Resolves when all channels are updated.
   */
  private async pollAll(): Promise<void> {
    if (!this.host) return;
    for (const cd of this.channelDevices) {
      try {
        const state = await this.host.getState(cd.channel);
        await this.applyState(cd.device, state);
      } catch (error) {
        this.log.debug(`Poll failed for channel ${cd.channel}: ${error instanceof Error ? error.message : String(error)}`);
        await cd.device.updateAttribute('BooleanState', 'stateValue', false, this.log);
      }
    }
  }

  /**
   * Apply a channel state to its Matter endpoint and children.
   *
   * @param {MatterbridgeEndpoint} device - The channel device.
   * @param {ChannelState} state - The polled state.
   * @returns {Promise<void>} Resolves when attributes are updated.
   */
  private async applyState(device: MatterbridgeEndpoint, state: ChannelState): Promise<void> {
    await device.updateAttribute('OccupancySensing', 'occupancy', { occupied: state.motion }, this.log);
    await device.updateAttribute('BooleanState', 'stateValue', state.online, this.log);
    if (typeof state.battery === 'number') {
      await device.updateAttribute('PowerSource', 'batPercentRemaining', Math.round(state.battery * 2), this.log);
    }

    const setOcc = async (id: string, occupied: boolean) => {
      const child = device.getChildEndpointByName(id);
      if (child) await child.updateAttribute('OccupancySensing', 'occupancy', { occupied }, this.log);
    };
    const setOnOff = async (id: string, on: boolean) => {
      const child = device.getChildEndpointByName(id);
      if (child) await child.updateAttribute('OnOff', 'onOff', on, this.log);
    };

    await setOcc('PersonDetection', state.person);
    await setOcc('VehicleDetection', state.vehicle);
    await setOcc('AnimalDetection', state.animal);
    await setOnOff('Spotlight', state.spotlight);
    await setOnOff('IRLed', state.irLed);
  }
}
