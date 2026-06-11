/**
 * Matterbridge plugin for Belkin Wemo (prises, switches, dimmers, capteurs).
 *
 * Local UPnP/SOAP control. Supports: Smart Plug/Switch (on/off), Insight plug
 * (energy: W, kWh), Dimmer (on/off + brightness), Light, Motion sensor
 * (occupancy) and Maker (contact sensor).
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  onOffOutlet,
  dimmableLight,
  occupancySensor,
  contactSensor,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { OnOff, LevelControl, OccupancySensing, BooleanState, ElectricalPowerMeasurement, ElectricalEnergyMeasurement } from 'matterbridge/matter/clusters';

import { discover, fetchDescription, WemoDevice, WemoInfo, WemoKind } from './wemo.js';

export type WemoPlatformConfig = BasePlatformConfig & {
  whiteList: string[];
  blackList: string[];
  /** Static device IP addresses to add directly (bypassing/augmenting SSDP). */
  deviceIps?: string[];
  /** SSDP discovery timeout in ms. */
  discoveryTimeout?: number;
  /** Poll interval in ms for refreshing device state. */
  pollInterval?: number;
};

const WEMO_PORT = 49153;

interface WemoEntry {
  device: WemoDevice;
  endpoint: MatterbridgeEndpoint;
  kind: WemoKind;
}

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: WemoPlatformConfig): WemoPlatform {
  return new WemoPlatform(matterbridge, log, config);
}

export class WemoPlatform extends MatterbridgeDynamicPlatform {
  private readonly entries = new Map<string, WemoEntry>();
  private pollTimer?: NodeJS.Timeout;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: WemoPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing Belkin Wemo Platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();
    await this.discoverDevices();
  }

  private async discoverDevices(): Promise<void> {
    const cfg = this.config as WemoPlatformConfig;
    const infos = new Map<string, WemoInfo>();

    // 1. SSDP discovery
    try {
      const timeout = cfg.discoveryTimeout ?? 5000;
      this.log.info(`Discovering Wemo devices via SSDP (${timeout}ms)...`);
      for (const info of await discover(timeout)) infos.set(info.udn || info.baseUrl, info);
    } catch (e) {
      this.log.warn(`SSDP discovery failed: ${(e as Error).message}`);
    }

    // 2. Static IPs from config
    for (const ip of cfg.deviceIps ?? []) {
      try {
        const info = await fetchDescription(`http://${ip}:${WEMO_PORT}/setup.xml`);
        infos.set(info.udn || info.baseUrl, info);
      } catch (e) {
        this.log.warn(`Could not query Wemo at ${ip}: ${(e as Error).message}`);
      }
    }

    this.log.info(`Found ${infos.size} Wemo device(s)`);
    for (const info of infos.values()) await this.registerWemo(info);
  }

  private async registerWemo(info: WemoInfo): Promise<void> {
    const name = info.friendlyName;
    const serial = info.serialNumber || info.macAddress || info.udn;

    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const device = new WemoDevice(info);
    let endpoint: MatterbridgeEndpoint | undefined;

    switch (info.kind) {
      case 'insight':
      case 'switch':
        endpoint = this.buildSwitch(device, info, name, serial, info.kind === 'insight');
        break;
      case 'dimmer':
      case 'light':
        endpoint = this.buildDimmer(device, info, name, serial);
        break;
      case 'motion':
        endpoint = this.buildMotion(info, name, serial);
        break;
      case 'maker':
        endpoint = this.buildMaker(info, name, serial);
        break;
      default:
        this.log.warn(`Unsupported Wemo device type "${info.deviceType}" (${name})`);
        return;
    }

    if (!endpoint) return;
    await this.registerDevice(endpoint);
    this.entries.set(serial, { device, endpoint, kind: info.kind });
    this.log.info(`Registered Wemo ${info.kind} "${name}" @ ${info.ip}`);
  }

  private buildSwitch(device: WemoDevice, info: WemoInfo, name: string, serial: string, insight: boolean): MatterbridgeEndpoint {
    const ep = new MatterbridgeEndpoint(onOffOutlet, { id: `wemo-${serial}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Belkin Wemo', info.modelName)
      .createDefaultIdentifyClusterServer()
      .createDefaultPowerSourceWiredClusterServer()
      .createDefaultOnOffClusterServer(false);

    if (insight) {
      ep.createDefaultElectricalPowerMeasurementClusterServer().createDefaultElectricalEnergyMeasurementClusterServer();
    }
    ep.addRequiredClusterServers();
    this.wireOnOff(ep, device, name);
    return ep;
  }

  private buildDimmer(device: WemoDevice, info: WemoInfo, name: string, serial: string): MatterbridgeEndpoint {
    const ep = new MatterbridgeEndpoint(dimmableLight, { id: `wemo-${serial}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Belkin Wemo', info.modelName)
      .createDefaultIdentifyClusterServer()
      .createDefaultPowerSourceWiredClusterServer()
      .createDefaultOnOffClusterServer(false)
      .createDefaultLevelControlClusterServer(1)
      .addRequiredClusterServers();

    this.wireOnOff(ep, device, name);
    ep.addCommandHandler('moveToLevel', async ({ request }) => {
      const level0to100 = Math.round(((request.level ?? 0) / 254) * 100);
      this.log.info(`moveToLevel ${level0to100}% on ${name}`);
      await device.setBrightness(level0to100).catch((e) => this.log.error(`setBrightness failed: ${(e as Error).message}`));
    });
    ep.addCommandHandler('moveToLevelWithOnOff', async ({ request }) => {
      const level0to100 = Math.round(((request.level ?? 0) / 254) * 100);
      this.log.info(`moveToLevelWithOnOff ${level0to100}% on ${name}`);
      await device.setBrightness(level0to100).catch((e) => this.log.error(`setBrightness failed: ${(e as Error).message}`));
    });
    return ep;
  }

  private buildMotion(info: WemoInfo, name: string, serial: string): MatterbridgeEndpoint {
    return new MatterbridgeEndpoint(occupancySensor, { id: `wemo-${serial}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Belkin Wemo', info.modelName)
      .createDefaultIdentifyClusterServer()
      .createDefaultPowerSourceWiredClusterServer()
      .createDefaultOccupancySensingClusterServer(false)
      .addRequiredClusterServers();
  }

  private buildMaker(info: WemoInfo, name: string, serial: string): MatterbridgeEndpoint {
    return new MatterbridgeEndpoint(contactSensor, { id: `wemo-${serial}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Belkin Wemo', info.modelName)
      .createDefaultIdentifyClusterServer()
      .createDefaultPowerSourceWiredClusterServer()
      .createDefaultBooleanStateClusterServer(true)
      .addRequiredClusterServers();
  }

  private wireOnOff(ep: MatterbridgeEndpoint, device: WemoDevice, name: string): void {
    ep.addCommandHandler('on', async () => {
      this.log.info(`on -> ${name}`);
      await device.setBinaryState(true).catch((e) => this.log.error(`on failed: ${(e as Error).message}`));
    });
    ep.addCommandHandler('off', async () => {
      this.log.info(`off -> ${name}`);
      await device.setBinaryState(false).catch((e) => this.log.error(`off failed: ${(e as Error).message}`));
    });
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    await this.refreshAll();

    const interval = (this.config as WemoPlatformConfig).pollInterval ?? 30000;
    this.pollTimer = setInterval(() => {
      void this.refreshAll();
    }, interval);
  }

  private async refreshAll(): Promise<void> {
    for (const [serial, entry] of this.entries) {
      try {
        await this.refreshOne(entry);
      } catch (e) {
        this.log.debug(`refresh ${serial} failed: ${(e as Error).message}`);
      }
    }
  }

  private async refreshOne(entry: WemoEntry): Promise<void> {
    const { device, endpoint, kind } = entry;

    if (kind === 'motion') {
      const on = await device.getBinaryState();
      await endpoint.setAttribute(OccupancySensing, 'occupancy', { occupied: on }, endpoint.log);
      return;
    }
    if (kind === 'maker') {
      const on = await device.getBinaryState();
      // BinaryState 1 -> closed (contact present) -> stateValue:false in Matter (false = detected/closed).
      await endpoint.setAttribute(BooleanState, 'stateValue', !on, endpoint.log);
      return;
    }

    if (kind === 'insight') {
      const p = await device.getInsightParams();
      await endpoint.setAttribute(OnOff, 'onOff', p.state === 1, endpoint.log);
      // Matter ElectricalPowerMeasurement.activePower is in mW.
      await endpoint.setAttribute(ElectricalPowerMeasurement, 'activePower', Math.round(p.currentPowerMw), endpoint.log);
      // Convert mW*minutes -> mW*hours (mWh). cumulativeEnergyImported.energy is in mWh.
      const mWh = Math.round(p.totalEnergyMwMin / 60);
      await endpoint.setAttribute(ElectricalEnergyMeasurement, 'cumulativeEnergyImported', { energy: mWh }, endpoint.log);
      return;
    }

    // switch / dimmer / light
    const on = await device.getBinaryState();
    await endpoint.setAttribute(OnOff, 'onOff', on, endpoint.log);
    if (kind === 'dimmer') {
      const b = await device.getBrightness();
      await endpoint.setAttribute(LevelControl, 'currentLevel', Math.max(1, Math.round((b / 100) * 254)), endpoint.log);
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
    for (const entry of this.entries.values()) entry.device.removeAllListeners();
    this.entries.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }
}
