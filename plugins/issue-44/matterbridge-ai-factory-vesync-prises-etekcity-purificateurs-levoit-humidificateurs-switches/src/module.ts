/**
 * VeSync Matterbridge platform (Etekcity outlets, Levoit purifiers, humidifiers, fans).
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  airPurifier,
  airQualitySensor,
  BasePlatformConfig,
  fanDevice,
  humiditySensor,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  onOffOutlet,
  PlatformMatterbridge,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { FanControl, OnOff } from 'matterbridge/matter/clusters';

import { VeSyncCategory, VeSyncClient, VeSyncDevice } from './vesync.js';

/** Plugin configuration. */
export type VeSyncPlatformConfig = BasePlatformConfig & {
  username?: string;
  password?: string;
  timeZone?: string;
  pollInterval?: number;
  whiteList: string[];
  blackList: string[];
};

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger.
 * @param {VeSyncPlatformConfig} config - Platform configuration.
 * @returns {VeSyncPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: VeSyncPlatformConfig): VeSyncPlatform {
  return new VeSyncPlatform(matterbridge, log, config);
}

interface RegisteredDevice {
  endpoint: MatterbridgeEndpoint;
  vesync: VeSyncDevice;
  category: VeSyncCategory;
}

/**
 * Dynamic platform bridging VeSync cloud devices to Matter.
 */
export class VeSyncPlatform extends MatterbridgeDynamicPlatform {
  private client?: VeSyncClient;
  private readonly devices: RegisteredDevice[] = [];
  private pollTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
   * @param {AnsiLogger} log - Logger.
   * @param {VeSyncPlatformConfig} config - Platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: VeSyncPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }
    this.log.info('Initializing VeSync Platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const cfg = this.config as VeSyncPlatformConfig;
    if (!cfg.username || !cfg.password) {
      this.log.error('VeSync username and password are required in the plugin config. No devices will be created.');
      return;
    }

    this.client = new VeSyncClient(cfg.username, cfg.password, this.log, cfg.timeZone ?? 'America/New_York');
    try {
      await this.client.login();
    } catch (err) {
      this.log.error(`VeSync login failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let list: VeSyncDevice[] = [];
    try {
      list = await this.client.getDevices();
    } catch (err) {
      this.log.error(`Failed to list VeSync devices: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.log.info(`Discovered ${list.length} VeSync device(s)`);

    for (const dev of list) {
      const category = VeSyncClient.categorize(dev);
      const serial = dev.cid || dev.uuid || dev.deviceName;
      this.setSelectDevice(serial, dev.deviceName);
      if (!this.validateDevice([dev.deviceName, serial])) continue;
      const endpoint = this.buildEndpoint(dev, category, serial);
      if (!endpoint) {
        this.log.info(`Skipping unsupported device ${dev.deviceName} (${dev.deviceType})`);
        continue;
      }
      await this.registerDevice(endpoint);
      this.devices.push({ endpoint, vesync: dev, category });
    }
  }

  private buildEndpoint(dev: VeSyncDevice, category: VeSyncCategory, serial: string): MatterbridgeEndpoint | undefined {
    const name = dev.deviceName || dev.deviceType;
    const model = dev.deviceType || 'VeSync';
    const vid = this.matterbridge.aggregatorVendorId;

    if (category === 'outlet' || category === 'switch') {
      const ep = new MatterbridgeEndpoint(onOffOutlet, { id: serial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, vid, 'VeSync', model, 1, '1.0.0')
        .createDefaultPowerSourceWiredClusterServer()
        .createDefaultElectricalPowerMeasurementClusterServer()
        .addRequiredClusterServers();
      this.attachOnOff(ep, dev, category);
      return ep;
    }

    if (category === 'purifier') {
      const ep = new MatterbridgeEndpoint([airPurifier, airQualitySensor], { id: serial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, vid, 'VeSync', model, 1, '1.0.0')
        .createDefaultPowerSourceWiredClusterServer()
        .createDefaultFanControlClusterServer(FanControl.FanMode.Auto, FanControl.FanModeSequence.OffLowMedHighAuto)
        .createDefaultAirQualityClusterServer()
        .createDefaultPm25ConcentrationMeasurementClusterServer()
        .addRequiredClusterServers();
      this.attachFan(ep, dev);
      return ep;
    }

    if (category === 'humidifier') {
      const ep = new MatterbridgeEndpoint([fanDevice, humiditySensor], { id: serial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, vid, 'VeSync', model, 1, '1.0.0')
        .createDefaultPowerSourceWiredClusterServer()
        .createDefaultFanControlClusterServer(FanControl.FanMode.Auto, FanControl.FanModeSequence.OffLowMedHighAuto)
        .createDefaultRelativeHumidityMeasurementClusterServer()
        .addRequiredClusterServers();
      this.attachFan(ep, dev);
      return ep;
    }

    if (category === 'fan') {
      const ep = new MatterbridgeEndpoint(fanDevice, { id: serial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, vid, 'VeSync', model, 1, '1.0.0')
        .createDefaultPowerSourceWiredClusterServer()
        .createDefaultFanControlClusterServer(FanControl.FanMode.Off, FanControl.FanModeSequence.OffLowMedHigh)
        .addRequiredClusterServers();
      this.attachFan(ep, dev);
      return ep;
    }

    return undefined;
  }

  private attachOnOff(ep: MatterbridgeEndpoint, dev: VeSyncDevice, category: VeSyncCategory): void {
    ep.addCommandHandler('on', async () => {
      await this.safe(() => this.client?.setPower(dev, category, true), `turn on ${dev.deviceName}`);
      await ep.setAttribute(OnOff, 'onOff', true, this.log);
    });
    ep.addCommandHandler('off', async () => {
      await this.safe(() => this.client?.setPower(dev, category, false), `turn off ${dev.deviceName}`);
      await ep.setAttribute(OnOff, 'onOff', false, this.log);
    });
  }

  private attachFan(ep: MatterbridgeEndpoint, dev: VeSyncDevice): void {
    const cat: VeSyncCategory = VeSyncClient.categorize(dev);
    // Map fanMode -> power + vesync mode.
    ep.subscribeAttribute(
      FanControl.Cluster.id,
      'fanMode',
      async (newValue: FanControl.FanMode) => {
        if (newValue === FanControl.FanMode.Off) {
          await this.safe(() => this.client?.setPower(dev, cat, false), `turn off ${dev.deviceName}`);
          return;
        }
        await this.safe(() => this.client?.setPower(dev, cat, true), `turn on ${dev.deviceName}`);
        if (newValue === FanControl.FanMode.Auto) await this.safe(() => this.client?.setMode(dev, 'auto'), `set auto ${dev.deviceName}`);
        else await this.safe(() => this.client?.setMode(dev, 'manual'), `set manual ${dev.deviceName}`);
      },
      this.log,
    );
    // Map percentSetting -> 1..3 level.
    ep.subscribeAttribute(
      FanControl.Cluster.id,
      'percentSetting',
      async (percent: number) => {
        if (!percent) return;
        const level = Math.max(1, Math.min(3, Math.ceil((percent / 100) * 3)));
        await this.safe(() => this.client?.setFanSpeed(dev, level), `set speed ${dev.deviceName}`);
      },
      this.log,
    );
  }

  private async safe(fn: () => Promise<unknown> | undefined, action: string): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.error(`Failed to ${action}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    await this.refreshAll();

    const interval = Math.max(30, (this.config as VeSyncPlatformConfig).pollInterval ?? 60);
    this.pollTimer = setInterval(() => {
      void this.refreshAll();
    }, interval * 1000);
  }

  private async refreshAll(): Promise<void> {
    if (!this.client?.authenticated) return;
    for (const reg of this.devices) {
      const state = await this.client.getState(reg.vesync, reg.category);
      const ep = reg.endpoint;
      try {
        if (ep.hasAttributeServer(OnOff.Cluster.id, 'onOff')) await ep.setAttribute(OnOff, 'onOff', state.on, this.log);

        if (typeof state.power === 'number' && ep.hasAttributeServer('ElectricalPowerMeasurement', 'activePower')) {
          await ep.setAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(state.power * 1000), this.log);
        }
        if (typeof state.fanSpeed === 'number' && ep.hasAttributeServer(FanControl.Cluster.id, 'percentCurrent')) {
          const pct = Math.max(0, Math.min(100, Math.round((state.fanSpeed / 3) * 100)));
          await ep.setAttribute(FanControl.Cluster.id, 'percentCurrent', pct, this.log);
          await ep.setAttribute(FanControl.Cluster.id, 'percentSetting', pct, this.log);
        }
        if (typeof state.airQuality === 'number' && ep.hasAttributeServer('Pm25ConcentrationMeasurement', 'measuredValue')) {
          await ep.setAttribute('Pm25ConcentrationMeasurement', 'measuredValue', state.airQuality, this.log);
        }
        if (typeof state.humidity === 'number' && ep.hasAttributeServer('RelativeHumidityMeasurement', 'measuredValue')) {
          await ep.setAttribute('RelativeHumidityMeasurement', 'measuredValue', Math.round(state.humidity * 100), this.log);
        }
      } catch (err) {
        this.log.debug(`refresh failed for ${reg.vesync.deviceName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }
}
