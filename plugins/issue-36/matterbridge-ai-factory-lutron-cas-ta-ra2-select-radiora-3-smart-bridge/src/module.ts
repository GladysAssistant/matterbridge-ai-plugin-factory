/**
 * Matterbridge plugin for Lutron Caséta / RA2 Select / RadioRA 3 (Smart Bridge).
 *
 * Connects to a Lutron Smart Bridge over LEAP/TLS and exposes dimmers, switches,
 * shades, fan controllers and occupancy sensors as Matter devices. Pico remote
 * button presses are surfaced as log events (Matter mapping is limited).
 *
 * @file module.ts
 * @author hello@gladysassistant.com
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  coverDevice,
  dimmableLight,
  fanDevice,
  occupancySensor,
  onOffOutlet,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { FanControl, LevelControl, OnOff, WindowCovering } from 'matterbridge/matter/clusters';

import { LeapClient, type LeapMessage } from './leap.js';

/** Instance configuration for the Lutron platform. */
export type LutronPlatformConfig = BasePlatformConfig & {
  host?: string;
  keyfile?: string;
  certfile?: string;
  ca_certs?: string;
  whiteList?: string[];
  blackList?: string[];
};

/** Matter category a Lutron device maps to. */
type Kind = 'dimmer' | 'switch' | 'shade' | 'fan' | 'occupancy' | 'pico' | 'ignore';

/** A discovered Lutron device with the data needed to build a Matter endpoint. */
interface LutronDevice {
  href: string;
  id: string;
  name: string;
  deviceType: string;
  zone?: string;
  kind: Kind;
}

/**
 * Entry point invoked by Matterbridge to construct the platform.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - Plugin logger.
 * @param {LutronPlatformConfig} config - Platform configuration.
 * @returns {LutronPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: LutronPlatformConfig): LutronPlatform {
  return new LutronPlatform(matterbridge, log, config);
}

/** Map a Lutron DeviceType string to a Matter device kind. */
function classify(deviceType: string): Kind {
  const t = deviceType.toLowerCase();
  if (t.includes('dimmer')) return 'dimmer';
  if (t.includes('fanspeed') || t.includes('fancontroller') || t.includes('fan')) return 'fan';
  if (t.includes('shade') || t.includes('blind') || t.includes('roller') || t.includes('honeycomb') || t.includes('drape')) return 'shade';
  if (t.includes('occupancy') || t.includes('motion')) return 'occupancy';
  if (t.includes('pico') || t.includes('keypad') || t.includes('button')) return 'pico';
  if (t.includes('switch') || t.includes('plug') || t.includes('appliance')) return 'switch';
  if (t.includes('smartbridge') || t.includes('repeater') || t.includes('processor')) return 'ignore';
  return 'ignore';
}

/** Lutron level (0-100) -> Matter LevelControl currentLevel (1-254). */
function pctToLevel(pct: number): number {
  return Math.max(1, Math.min(254, Math.round((pct / 100) * 254)));
}

/** Matter LevelControl currentLevel (0-254) -> Lutron level (0-100). */
function levelToPct(level: number): number {
  return Math.max(0, Math.min(100, Math.round((level / 254) * 100)));
}

/** Lutron fan percent (0-100) -> Lutron FanSpeed string. */
function pctToFanSpeed(pct: number): string {
  if (pct <= 0) return 'Off';
  if (pct <= 25) return 'Low';
  if (pct <= 50) return 'Medium';
  if (pct <= 75) return 'MediumHigh';
  return 'High';
}

/** Lutron FanSpeed string -> percent (0-100). */
function fanSpeedToPct(speed: string): number {
  switch (speed) {
    case 'High':
      return 100;
    case 'MediumHigh':
      return 75;
    case 'Medium':
      return 50;
    case 'Low':
      return 25;
    default:
      return 0;
  }
}

/**
 * Dynamic platform that bridges a Lutron Smart Bridge to Matter.
 */
export class LutronPlatform extends MatterbridgeDynamicPlatform {
  private client?: LeapClient;
  private reconnectTimer?: NodeJS.Timeout;
  /** Map of Lutron zone id -> the Matter endpoint that owns it. */
  private readonly zoneToDevice = new Map<string, { endpoint: MatterbridgeEndpoint; kind: Kind }>();
  /** Map of occupancy group id -> endpoint. */
  private readonly occToDevice = new Map<string, MatterbridgeEndpoint>();

  /**
   * Construct the Lutron platform.
   *
   * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
   * @param {AnsiLogger} log - Plugin logger.
   * @param {LutronPlatformConfig} config - Platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: LutronPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing Lutron platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const config = this.config as LutronPlatformConfig;
    if (!config.host || !config.keyfile || !config.certfile || !config.ca_certs) {
      this.log.warn(
        'Lutron bridge not configured. Generate certificates with "python -m pylutron_caseta.cli <bridge-ip>" ' +
          '(press the bridge button when prompted) and set host, keyfile, certfile and ca_certs in the plugin config.',
      );
      return;
    }

    await this.connectAndDiscover(config);
  }

  /** Establish the LEAP connection, discover devices and subscribe to updates. */
  private async connectAndDiscover(config: LutronPlatformConfig): Promise<void> {
    const client = new LeapClient({
      host: config.host!,
      keyfile: config.keyfile!,
      certfile: config.certfile!,
      ca_certs: config.ca_certs!,
    });
    this.client = client;

    client.on('error', (error: Error) => this.log.debug(`LEAP error: ${error.message}`));
    client.on('disconnect', () => {
      this.log.warn('LEAP connection lost. Reconnecting in 10s...');
      this.scheduleReconnect(config);
    });
    client.on('zone', (status) => this.onZoneStatus(status));
    client.on('occupancy', (occ) => this.onOccupancy(occ));
    client.on('button', (body) => this.log.info(`Lutron button event: ${JSON.stringify(body)}`));

    try {
      await client.connect();
      this.log.info(`Connected to Lutron bridge at ${config.host}`);
    } catch (error) {
      this.log.error(`Failed to connect to Lutron bridge: ${(error as Error).message}`);
      this.scheduleReconnect(config);
      return;
    }

    try {
      const response = await client.readDevices();
      const devices = this.parseDevices(response);
      this.log.info(`Discovered ${devices.length} Lutron device(s).`);
      for (const device of devices) await this.registerLutronDevice(device);

      await client.subscribeZones().catch((e) => this.log.debug(`subscribeZones failed: ${(e as Error).message}`));
      await client.subscribeOccupancy().catch((e) => this.log.debug(`subscribeOccupancy failed: ${(e as Error).message}`));
      await client.subscribeButtons().catch((e) => this.log.debug(`subscribeButtons failed: ${(e as Error).message}`));
    } catch (error) {
      this.log.error(`Device discovery failed: ${(error as Error).message}`);
    }
  }

  private scheduleReconnect(config: LutronPlatformConfig): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectAndDiscover(config);
    }, 10000);
  }

  /** Parse the /device read response into LutronDevice records. */
  private parseDevices(response: LeapMessage): LutronDevice[] {
    const list = (response.Body?.Devices as Array<Record<string, unknown>> | undefined) ?? [];
    const devices: LutronDevice[] = [];
    for (const raw of list) {
      const href = (raw.href as string) ?? '';
      const id = href.split('/').pop() ?? href;
      const deviceType = (raw.DeviceType as string) ?? '';
      const kind = classify(deviceType);
      if (kind === 'ignore') continue;
      const name = ((raw.FullyQualifiedName as string[] | undefined)?.join(' ') ?? (raw.Name as string) ?? `Lutron ${id}`).trim();
      const zone = (raw.LocalZone as { href?: string } | undefined)?.href?.split('/').pop();
      devices.push({ href, id, name, deviceType, zone, kind });
    }
    return devices;
  }

  /** Build and register the Matter endpoint for a single Lutron device. */
  private async registerLutronDevice(device: LutronDevice): Promise<void> {
    const serial = `lutron-${device.id}`;
    this.setSelectDevice(serial, device.name);
    if (!this.validateDevice([device.name, serial])) return;

    let endpoint: MatterbridgeEndpoint | undefined;
    switch (device.kind) {
      case 'dimmer':
        endpoint = this.buildDimmer(device, serial);
        break;
      case 'switch':
        endpoint = this.buildSwitch(device, serial);
        break;
      case 'shade':
        endpoint = this.buildShade(device, serial);
        break;
      case 'fan':
        endpoint = this.buildFan(device, serial);
        break;
      case 'occupancy':
        endpoint = this.buildOccupancy(device, serial);
        break;
      case 'pico':
        this.log.info(`Pico/keypad "${device.name}" exposed as button events only (Matter actuator mapping is limited).`);
        return;
      default:
        return;
    }

    if (!endpoint) return;
    await this.registerDevice(endpoint);
    if (device.zone) this.zoneToDevice.set(device.zone, { endpoint, kind: device.kind });
    if (device.kind === 'occupancy') this.occToDevice.set(device.id, endpoint);
  }

  private basicInfo(endpoint: MatterbridgeEndpoint, device: LutronDevice, serial: string, type: string): MatterbridgeEndpoint {
    return endpoint.createDefaultBridgedDeviceBasicInformationClusterServer(
      device.name,
      serial,
      this.matterbridge.aggregatorVendorId,
      'Lutron',
      type,
      1,
      '1.0.0',
    );
  }

  private buildDimmer(device: LutronDevice, serial: string): MatterbridgeEndpoint {
    const endpoint = new MatterbridgeEndpoint(dimmableLight, { id: serial });
    this.basicInfo(endpoint, device, serial, device.deviceType);
    endpoint.createDefaultOnOffClusterServer(false).createDefaultLevelControlClusterServer(1).addRequiredClusterServers();

    const setLevel = async (pct: number): Promise<void> => {
      if (device.zone) await this.client?.setZoneLevel(device.zone, pct, true).catch((e) => this.log.debug((e as Error).message));
    };
    endpoint.addCommandHandler('on', async () => {
      await setLevel(100);
    });
    endpoint.addCommandHandler('off', async () => {
      await setLevel(0);
    });
    const onMove = async (data: unknown): Promise<void> => {
      const level = (data as { request?: { level?: number } }).request?.level ?? 0;
      await setLevel(levelToPct(level));
    };
    endpoint.addCommandHandler('moveToLevel', onMove);
    endpoint.addCommandHandler('moveToLevelWithOnOff', onMove);
    return endpoint;
  }

  private buildSwitch(device: LutronDevice, serial: string): MatterbridgeEndpoint {
    const endpoint = new MatterbridgeEndpoint(onOffOutlet, { id: serial });
    this.basicInfo(endpoint, device, serial, device.deviceType);
    endpoint.createDefaultOnOffClusterServer(false).addRequiredClusterServers();

    endpoint.addCommandHandler('on', async () => {
      if (device.zone) await this.client?.setZoneLevel(device.zone, 100, false).catch((e) => this.log.debug((e as Error).message));
    });
    endpoint.addCommandHandler('off', async () => {
      if (device.zone) await this.client?.setZoneLevel(device.zone, 0, false).catch((e) => this.log.debug((e as Error).message));
    });
    return endpoint;
  }

  private buildShade(device: LutronDevice, serial: string): MatterbridgeEndpoint {
    const endpoint = new MatterbridgeEndpoint(coverDevice, { id: serial });
    this.basicInfo(endpoint, device, serial, device.deviceType);
    endpoint.createDefaultLiftTiltWindowCoveringClusterServer(0).addRequiredClusterServers();

    // Matter liftPercent100ths: 0 = fully open, 10000 = fully closed. Lutron level: 100 = open.
    const setLift = async (lift100ths: number): Promise<void> => {
      const pct = 100 - Math.round(lift100ths / 100);
      if (device.zone) await this.client?.setZoneLevel(device.zone, pct, false).catch((e) => this.log.debug((e as Error).message));
    };
    endpoint.addCommandHandler('upOrOpen', async () => {
      await setLift(0);
    });
    endpoint.addCommandHandler('downOrClose', async () => {
      await setLift(10000);
    });
    endpoint.addCommandHandler('stopMotion', async () => {
      if (device.zone) await this.client?.setZoneShadeMotion(device.zone, 'Stop').catch((e) => this.log.debug((e as Error).message));
    });
    endpoint.addCommandHandler('goToLiftPercentage', async (data: unknown) => {
      const target = (data as { request?: { liftPercent100thsValue?: number } }).request?.liftPercent100thsValue ?? 0;
      await setLift(target);
    });
    return endpoint;
  }

  private buildFan(device: LutronDevice, serial: string): MatterbridgeEndpoint {
    const endpoint = new MatterbridgeEndpoint(fanDevice, { id: serial });
    this.basicInfo(endpoint, device, serial, device.deviceType);
    endpoint.createDefaultFanControlClusterServer().addRequiredClusterServers();

    endpoint.subscribeAttribute(
      FanControl.Cluster.id,
      'percentSetting',
      async (value: number | null) => {
        if (value === null || !device.zone) return;
        await this.client?.setZoneFanSpeed(device.zone, pctToFanSpeed(value)).catch((e) => this.log.debug((e as Error).message));
      },
      endpoint.log,
    );
    return endpoint;
  }

  private buildOccupancy(device: LutronDevice, serial: string): MatterbridgeEndpoint {
    const endpoint = new MatterbridgeEndpoint(occupancySensor, { id: serial });
    this.basicInfo(endpoint, device, serial, device.deviceType);
    endpoint.createDefaultOccupancySensingClusterServer(false).addRequiredClusterServers();
    return endpoint;
  }

  /** Apply a live zone status update to the matching endpoint. */
  private onZoneStatus(status: { zone: string; level: number; fanSpeed?: string }): void {
    const entry = this.zoneToDevice.get(status.zone);
    if (!entry) return;
    const { endpoint, kind } = entry;
    void (async () => {
      try {
        if (kind === 'dimmer') {
          await endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', status.level > 0, endpoint.log);
          if (status.level > 0) await endpoint.updateAttribute(LevelControl.Cluster.id, 'currentLevel', pctToLevel(status.level), endpoint.log);
        } else if (kind === 'switch') {
          await endpoint.updateAttribute(OnOff.Cluster.id, 'onOff', status.level > 0, endpoint.log);
        } else if (kind === 'shade') {
          const lift = (100 - status.level) * 100;
          await endpoint.updateAttribute(WindowCovering.Cluster.id, 'currentPositionLiftPercent100ths', lift, endpoint.log);
          await endpoint.updateAttribute(WindowCovering.Cluster.id, 'targetPositionLiftPercent100ths', lift, endpoint.log);
        } else if (kind === 'fan') {
          const pct = status.fanSpeed ? fanSpeedToPct(status.fanSpeed) : status.level;
          await endpoint.updateAttribute(FanControl.Cluster.id, 'percentCurrent', pct, endpoint.log);
          await endpoint.updateAttribute(FanControl.Cluster.id, 'percentSetting', pct, endpoint.log);
        }
      } catch (error) {
        this.log.debug(`Failed to apply zone status: ${(error as Error).message}`);
      }
    })();
  }

  /** Apply a live occupancy group update to the matching endpoint. */
  private onOccupancy(occ: { group: string; occupied: boolean }): void {
    const endpoint = this.occToDevice.get(occ.group);
    if (!endpoint) return;
    void endpoint
      .updateAttribute('OccupancySensing', 'occupancy', { occupied: occ.occupied, pir: occ.occupied, ultrasonic: false, physicalContact: false }, endpoint.log)
      .catch((e) => this.log.debug((e as Error).message));
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.client?.close();
    this.client = undefined;
    this.zoneToDevice.clear();
    this.occToDevice.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }
}
