/**
 * Matterbridge Tasmota plugin (ESP8266/ESP32 — switches, lights, sensors, covers).
 *
 * HTTP-mode integration with Tasmota firmware devices via the `/cm?cmnd=` web API.
 * Supports manual device configuration and automatic discovery by IP range scan.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  coverDevice,
  dimmableLight,
  electricalSensor,
  extendedColorLight,
  humiditySensor,
  onOffOutlet,
  temperatureSensor,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

/** Supported Tasmota device types mapped to Matter device types. */
export type TasmotaDeviceType = 'switch' | 'dimmer' | 'rgb' | 'cover' | 'sensor';

/** Configuration for a single Tasmota device. */
export interface TasmotaDeviceConfig {
  name: string;
  host: string;
  topic?: string;
  type: TasmotaDeviceType;
  powerChannel?: number;
  username?: string;
  password?: string;
  /** Force-add electrical power/energy measurement (smart plugs with ENERGY block). */
  energyMonitoring?: boolean;
}

/** Automatic discovery configuration (HTTP IP range scan). */
export interface TasmotaDiscoveryConfig {
  enabled?: boolean;
  subnet?: string;
  start?: number;
  end?: number;
}

/** Plugin configuration. */
export type TasmotaPlatformConfig = BasePlatformConfig & {
  devices?: TasmotaDeviceConfig[];
  discovery?: TasmotaDiscoveryConfig;
  pollIntervalSeconds?: number;
  whiteList: string[];
  blackList: string[];
};

/** Tasmota `Status 0` response shape (subset). */
interface TasmotaStatus {
  Status?: { FriendlyName?: string[]; DeviceName?: string; Topic?: string; Module?: number };
  StatusSTS?: Record<string, unknown>;
  StatusSNS?: Record<string, unknown>;
}

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The logger instance.
 * @param {TasmotaPlatformConfig} config - The platform configuration.
 * @returns {TasmotaPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: TasmotaPlatformConfig): TasmotaPlatform {
  return new TasmotaPlatform(matterbridge, log, config);
}

/** Pairs a registered Matter endpoint with its Tasmota device configuration. */
interface TasmotaRuntime {
  cfg: TasmotaDeviceConfig;
  device: MatterbridgeEndpoint;
  temperature?: MatterbridgeEndpoint;
  humidity?: MatterbridgeEndpoint;
  energy?: MatterbridgeEndpoint;
}

/** Tasmota HTTP platform for Matterbridge. */
export class TasmotaPlatform extends MatterbridgeDynamicPlatform {
  private readonly runtimes: TasmotaRuntime[] = [];
  private readonly knownHosts = new Set<string>();
  private pollTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
   * @param {AnsiLogger} log - The logger instance.
   * @param {TasmotaPlatformConfig} config - The platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: TasmotaPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.7.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.7.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info(`Initializing Tasmota platform...`);
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const devices = (this.config as TasmotaPlatformConfig).devices ?? [];
    for (const cfg of devices) {
      try {
        await this.createDevice(cfg);
      } catch (error) {
        this.log.error(`Failed to create device ${cfg.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.discover();

    if (this.runtimes.length === 0) {
      this.log.warn('No Tasmota devices configured or discovered. Add devices or enable discovery in the plugin config.');
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    // Initial state read.
    await this.pollAll();

    // Start periodic polling.
    const seconds = Math.max(2, (this.config as TasmotaPlatformConfig).pollIntervalSeconds ?? 10);
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, seconds * 1000);
    this.log.info(`Polling ${this.runtimes.length} device(s) every ${seconds}s`);
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
    this.runtimes.length = 0;
    this.knownHosts.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Normalize a host/IP string for duplicate detection.
   *
   * @param {string} host - The host or IP.
   * @returns {string} The normalized lowercase host without protocol.
   */
  private normalizeHost(host: string): string {
    return host
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
  }

  /**
   * Build the Tasmota HTTP command URL.
   *
   * @param {TasmotaDeviceConfig} cfg - The device configuration.
   * @param {string} command - The Tasmota command (e.g. "Power TOGGLE").
   * @returns {string} The full command URL.
   */
  private buildUrl(cfg: TasmotaDeviceConfig, command: string): string {
    const params = new URLSearchParams();
    if (cfg.username) params.set('user', cfg.username);
    if (cfg.password) params.set('password', cfg.password);
    params.set('cmnd', command);
    const host = cfg.host.startsWith('http') ? cfg.host : `http://${cfg.host}`;
    return `${host}/cm?${params.toString()}`;
  }

  /**
   * Send a Tasmota command over HTTP and return the parsed JSON response.
   *
   * @param {TasmotaDeviceConfig} cfg - The device configuration.
   * @param {string} command - The Tasmota command.
   * @param {number} timeoutMs - Request timeout in milliseconds.
   * @returns {Promise<Record<string, unknown> | undefined>} The JSON response or undefined on error.
   */
  private async send(cfg: TasmotaDeviceConfig, command: string, timeoutMs = 5000): Promise<Record<string, unknown> | undefined> {
    const url = this.buildUrl(cfg, command);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        this.log.warn(`HTTP ${res.status} from ${cfg.name} (${command})`);
        return undefined;
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (error) {
      this.log.debug(`Request failed for ${cfg.name} (${command}): ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Detect whether a `Status 0` payload reports an ENERGY measurement block.
   *
   * @param {TasmotaStatus} status - The Status 0 response.
   * @returns {boolean} True when an ENERGY block is present.
   */
  private hasEnergyBlock(status: TasmotaStatus): boolean {
    return Boolean(status.StatusSNS && typeof status.StatusSNS === 'object' && status.StatusSNS.ENERGY);
  }

  /**
   * Infer the Tasmota device type from a `Status 0` payload.
   *
   * @param {TasmotaStatus} status - The Status 0 response.
   * @returns {TasmotaDeviceType} The detected device type.
   */
  private detectType(status: TasmotaStatus): TasmotaDeviceType {
    const sts = (status.StatusSTS ?? {}) as Record<string, unknown>;
    const sns = (status.StatusSNS ?? {}) as Record<string, unknown>;

    const hasShutter = Object.keys(sts).some((k) => /^Shutter\d/.test(k)) || Object.keys(sns).some((k) => /^Shutter\d/.test(k));
    if (hasShutter) return 'cover';

    const hasColor = typeof sts.Color === 'string' || typeof sts.HSBColor === 'string';
    const hasDimmer = typeof sts.Dimmer === 'number';
    if (hasColor) return 'rgb';
    if (hasDimmer) return 'dimmer';

    const hasPower = Object.keys(sts).some((k) => /^POWER\d?$/.test(k));
    if (hasPower) return 'switch';

    const hasSensorData =
      this.hasEnergyBlock(status) ||
      Object.values(sns).some((v) => v && typeof v === 'object' && ('Temperature' in (v as object) || 'Humidity' in (v as object)));
    if (hasSensorData) return 'sensor';

    return 'switch';
  }

  /**
   * Automatically discover Tasmota devices by scanning an IP range over HTTP.
   *
   * @returns {Promise<void>} Resolves when discovery completes.
   */
  private async discover(): Promise<void> {
    const discovery = (this.config as TasmotaPlatformConfig).discovery;
    if (!discovery?.enabled) return;

    const subnet = (discovery.subnet ?? '').replace(/\.+$/, '');
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) {
      this.log.error(`Discovery enabled but "subnet" is invalid (expected e.g. "192.168.1"): "${subnet}"`);
      return;
    }

    const start = Math.max(1, Math.min(254, discovery.start ?? 1));
    const end = Math.max(start, Math.min(254, discovery.end ?? 254));
    this.log.info(`Discovery scanning ${subnet}.${start}-${end} ...`);

    const batchSize = 32;
    let found = 0;
    for (let i = start; i <= end; i += batchSize) {
      const batch: Promise<void>[] = [];
      for (let j = i; j < i + batchSize && j <= end; j++) {
        const host = `${subnet}.${j}`;
        batch.push(this.probeAndCreate(host).then((created) => void (created && found++)));
      }
      await Promise.all(batch);
    }
    this.log.info(`Discovery finished: ${found} new device(s) added.`);
  }

  /**
   * Probe a single host and create a device if it is a Tasmota device not already known.
   *
   * @param {string} host - The IP/host to probe.
   * @returns {Promise<boolean>} True when a new device was created.
   */
  private async probeAndCreate(host: string): Promise<boolean> {
    if (this.knownHosts.has(this.normalizeHost(host))) return false;

    const probeCfg: TasmotaDeviceConfig = { name: host, host, type: 'switch' };
    const status = (await this.send(probeCfg, 'Status 0', 1500)) as TasmotaStatus | undefined;
    if (!status || typeof status.Status !== 'object') return false;

    const info = status.Status;
    const name = info.FriendlyName?.[0] || info.DeviceName || `Tasmota ${host}`;
    const topic = info.Topic;
    const type = this.detectType(status);

    const cfg: TasmotaDeviceConfig = { name, host, topic, type, energyMonitoring: this.hasEnergyBlock(status) };
    try {
      await this.createDevice(cfg, status);
      return true;
    } catch (error) {
      this.log.error(`Failed to create discovered device ${name} (${host}): ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Create and register a Matter endpoint for a Tasmota device.
   *
   * @param {TasmotaDeviceConfig} cfg - The device configuration.
   * @param {TasmotaStatus} [probed] - An optional pre-fetched Status 0 response.
   * @returns {Promise<void>} Resolves when the device is registered.
   */
  private async createDevice(cfg: TasmotaDeviceConfig, probed?: TasmotaStatus): Promise<void> {
    const normalized = this.normalizeHost(cfg.host);
    if (this.knownHosts.has(normalized)) {
      this.log.debug(`Skipping duplicate device for host ${cfg.host}`);
      return;
    }

    const serial = `tasmota-${(cfg.topic || cfg.host).replace(/[^a-zA-Z0-9]/g, '-')}-${cfg.type}`;
    const ch = cfg.powerChannel ?? 1;

    this.setSelectDevice(serial, cfg.name);
    if (!this.validateDevice([cfg.name, serial])) {
      this.log.info(`Device ${cfg.name} filtered out by white/black list`);
      return;
    }

    if (cfg.type === 'sensor') {
      await this.createSensorDevice(cfg, serial, probed);
      this.knownHosts.add(normalized);
      return;
    }

    let device: MatterbridgeEndpoint;

    switch (cfg.type) {
      case 'switch':
        device = new MatterbridgeEndpoint(onOffOutlet, { id: serial })
          .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'Tasmota', 'Tasmota Switch')
          .createDefaultPowerSourceWiredClusterServer()
          .addRequiredClusterServers();
        device.addCommandHandler('on', () => void this.send(cfg, `Power${ch} ON`));
        device.addCommandHandler('off', () => void this.send(cfg, `Power${ch} OFF`));
        break;

      case 'dimmer':
        device = new MatterbridgeEndpoint(dimmableLight, { id: serial })
          .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'Tasmota', 'Tasmota Dimmer')
          .createDefaultPowerSourceWiredClusterServer()
          .addRequiredClusterServers();
        device.addCommandHandler('on', () => void this.send(cfg, `Power${ch} ON`));
        device.addCommandHandler('off', () => void this.send(cfg, `Power${ch} OFF`));
        this.addLevelHandlers(device, cfg);
        break;

      case 'rgb':
        device = new MatterbridgeEndpoint(extendedColorLight, { id: serial })
          .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'Tasmota', 'Tasmota RGB Light')
          .createDefaultPowerSourceWiredClusterServer()
          .addRequiredClusterServers();
        device.addCommandHandler('on', () => void this.send(cfg, `Power${ch} ON`));
        device.addCommandHandler('off', () => void this.send(cfg, `Power${ch} OFF`));
        this.addLevelHandlers(device, cfg);
        this.addColorHandlers(device, cfg);
        break;

      case 'cover':
        device = new MatterbridgeEndpoint(coverDevice, { id: serial })
          .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'Tasmota', 'Tasmota Shutter')
          .createDefaultPowerSourceWiredClusterServer()
          .addRequiredClusterServers();
        device.addCommandHandler('upOrOpen', () => void this.send(cfg, `ShutterOpen${ch}`));
        device.addCommandHandler('downOrClose', () => void this.send(cfg, `ShutterClose${ch}`));
        device.addCommandHandler('stopMotion', () => void this.send(cfg, `ShutterStop${ch}`));
        device.addCommandHandler('goToLiftPercentage', (data) => {
          const lift = Number((data.request as { liftPercent100thsValue?: number }).liftPercent100thsValue ?? 0);
          // Matter 0=open..10000=closed -> Tasmota 100=open..0=closed.
          const tasmotaPos = Math.round(100 - lift / 100);
          void this.send(cfg, `ShutterPosition${ch} ${tasmotaPos}`);
        });
        break;

      default:
        this.log.error(`Unknown device type "${cfg.type as string}" for ${cfg.name}`);
        return;
    }

    const runtime: TasmotaRuntime = { cfg, device };

    // Add an electrical measurement child endpoint for smart plugs / power-monitoring relays.
    if (cfg.energyMonitoring) {
      const energy = device
        .addChildDeviceType('Energy', electricalSensor, { id: `${serial}-energy` })
        .createDefaultElectricalPowerMeasurementClusterServer()
        .createDefaultElectricalEnergyMeasurementClusterServer()
        .addRequiredClusterServers();
      runtime.energy = energy;
    }

    await this.registerDevice(device);
    this.runtimes.push(runtime);
    this.knownHosts.add(normalized);
    this.log.info(`Registered Tasmota ${cfg.type} "${cfg.name}" (${cfg.host})`);
  }

  /**
   * Create a composed sensor device with one child endpoint per measurement capability.
   *
   * @param {TasmotaDeviceConfig} cfg - The device configuration.
   * @param {string} serial - The stable serial / endpoint id.
   * @param {TasmotaStatus} [probed] - An optional pre-fetched Status 0 response.
   * @returns {Promise<void>} Resolves when the device is registered.
   */
  private async createSensorDevice(cfg: TasmotaDeviceConfig, serial: string, probed?: TasmotaStatus): Promise<void> {
    const status = probed ?? ((await this.send(cfg, 'Status 0')) as TasmotaStatus | undefined);
    const sns = (status?.StatusSNS ?? {}) as Record<string, unknown>;

    let hasTemp = false;
    let hasHum = false;
    for (const v of Object.values(sns)) {
      if (v && typeof v === 'object') {
        if ('Temperature' in (v as object)) hasTemp = true;
        if ('Humidity' in (v as object)) hasHum = true;
      }
    }
    const hasEnergy = cfg.energyMonitoring || (status ? this.hasEnergyBlock(status) : false);

    // If probing failed, expose all capabilities so nothing is silently dropped.
    if (!status) {
      hasTemp = true;
      hasHum = true;
    }
    if (!hasTemp && !hasHum && !hasEnergy) hasTemp = true;

    const device = new MatterbridgeEndpoint(temperatureSensor, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'Tasmota', 'Tasmota Sensor')
      .createDefaultPowerSourceWiredClusterServer()
      .createDefaultTemperatureMeasurementClusterServer()
      .addRequiredClusterServers();

    const runtime: TasmotaRuntime = { cfg, device, temperature: device };

    if (hasHum) {
      runtime.humidity = device
        .addChildDeviceType('Humidity', humiditySensor, { id: `${serial}-humidity` })
        .createDefaultRelativeHumidityMeasurementClusterServer()
        .addRequiredClusterServers();
    }

    if (hasEnergy) {
      runtime.energy = device
        .addChildDeviceType('Energy', electricalSensor, { id: `${serial}-energy` })
        .createDefaultElectricalPowerMeasurementClusterServer()
        .createDefaultElectricalEnergyMeasurementClusterServer()
        .addRequiredClusterServers();
    }

    await this.registerDevice(device);
    this.runtimes.push(runtime);
    this.log.info(`Registered Tasmota sensor "${cfg.name}" (${cfg.host}) [temp=${hasTemp} hum=${hasHum} energy=${hasEnergy}]`);
  }

  /**
   * Add LevelControl command handlers (Tasmota Dimmer 0-100).
   *
   * @param {MatterbridgeEndpoint} device - The endpoint.
   * @param {TasmotaDeviceConfig} cfg - The device configuration.
   */
  private addLevelHandlers(device: MatterbridgeEndpoint, cfg: TasmotaDeviceConfig): void {
    const handler = (data: { request: unknown }): void => {
      const level = Number((data.request as { level?: number }).level ?? 0);
      const percent = Math.max(0, Math.min(100, Math.round((level / 254) * 100)));
      void this.send(cfg, `Dimmer ${percent}`);
    };
    device.addCommandHandler('moveToLevel', handler);
    device.addCommandHandler('moveToLevelWithOnOff', handler);
  }

  /**
   * Add ColorControl command handlers (hue/saturation and color temperature).
   *
   * @param {MatterbridgeEndpoint} device - The endpoint.
   * @param {TasmotaDeviceConfig} cfg - The device configuration.
   */
  private addColorHandlers(device: MatterbridgeEndpoint, cfg: TasmotaDeviceConfig): void {
    device.addCommandHandler('moveToHueAndSaturation', (data) => {
      const req = data.request as { hue?: number; saturation?: number };
      const hue = Math.round(((req.hue ?? 0) / 254) * 360);
      const sat = Math.round(((req.saturation ?? 0) / 254) * 100);
      void this.send(cfg, `HSBColor ${hue},${sat},100`);
    });
    device.addCommandHandler('moveToHue', (data) => {
      const hue = Math.round((((data.request as { hue?: number }).hue ?? 0) / 254) * 360);
      void this.send(cfg, `HSBColor1 ${hue}`);
    });
    device.addCommandHandler('moveToSaturation', (data) => {
      const sat = Math.round((((data.request as { saturation?: number }).saturation ?? 0) / 254) * 100);
      void this.send(cfg, `HSBColor2 ${sat}`);
    });
    device.addCommandHandler('moveToColorTemperature', (data) => {
      const mireds = Number((data.request as { colorTemperatureMireds?: number }).colorTemperatureMireds ?? 153);
      void this.send(cfg, `CT ${Math.max(153, Math.min(500, mireds))}`);
    });
  }

  /**
   * Poll all registered devices for state.
   *
   * @returns {Promise<void>} Resolves when polling completes.
   */
  private async pollAll(): Promise<void> {
    await Promise.all(this.runtimes.map((rt) => this.pollDevice(rt)));
  }

  /**
   * Poll a single device with `Status 0` and update Matter attributes.
   *
   * @param {TasmotaRuntime} rt - The runtime entry.
   * @returns {Promise<void>} Resolves when the update completes.
   */
  private async pollDevice(rt: TasmotaRuntime): Promise<void> {
    const { cfg, device } = rt;
    const status = await this.send(cfg, 'Status 0');
    if (!status) return;

    const ch = cfg.powerChannel ?? 1;
    const sts = (status.StatusSTS ?? {}) as Record<string, unknown>;
    const sns = (status.StatusSNS ?? {}) as Record<string, unknown>;

    try {
      // Power state.
      const powerKey = (sts[`POWER${ch}`] !== undefined ? `POWER${ch}` : 'POWER') as string;
      const powerVal = sts[powerKey];
      if (powerVal !== undefined && device.hasAttributeServer('OnOff', 'onOff')) {
        await device.updateAttribute('OnOff', 'onOff', powerVal === 'ON', this.log);
      }

      // Dimmer level.
      if (typeof sts.Dimmer === 'number' && device.hasAttributeServer('LevelControl', 'currentLevel')) {
        await device.updateAttribute('LevelControl', 'currentLevel', Math.round((sts.Dimmer / 100) * 254), this.log);
      }

      // Color temperature.
      if (typeof sts.CT === 'number' && device.hasAttributeServer('ColorControl', 'colorTemperatureMireds')) {
        await device.updateAttribute('ColorControl', 'colorTemperatureMireds', sts.CT, this.log);
      }

      // Cover position: Tasmota Shutter1.Position 0..100 (100=open) -> Matter 0=open..10000=closed.
      const shutter = (sns[`Shutter${ch}`] ?? sts[`Shutter${ch}`]) as { Position?: number } | undefined;
      if (shutter && typeof shutter.Position === 'number' && device.hasAttributeServer('WindowCovering', 'currentPositionLiftPercent100ths')) {
        const lift = Math.round((100 - shutter.Position) * 100);
        await device.updateAttribute('WindowCovering', 'currentPositionLiftPercent100ths', lift, this.log);
        await device.updateAttribute('WindowCovering', 'targetPositionLiftPercent100ths', lift, this.log);
      }

      await this.updateSensor(rt, sns);
    } catch (error) {
      this.log.debug(`Update failed for ${cfg.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Update sensor / energy attributes from the StatusSNS payload on their child endpoints.
   *
   * @param {TasmotaRuntime} rt - The runtime entry.
   * @param {Record<string, unknown>} sns - The StatusSNS object.
   * @returns {Promise<void>} Resolves when attributes are updated.
   */
  private async updateSensor(rt: TasmotaRuntime, sns: Record<string, unknown>): Promise<void> {
    let temperature: number | undefined;
    let humidity: number | undefined;

    for (const value of Object.values(sns)) {
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (typeof obj.Temperature === 'number') temperature = obj.Temperature;
        if (typeof obj.Humidity === 'number') humidity = obj.Humidity;
      }
    }

    const tempEp = rt.temperature;
    if (temperature !== undefined && tempEp?.hasAttributeServer('TemperatureMeasurement', 'measuredValue')) {
      await tempEp.updateAttribute('TemperatureMeasurement', 'measuredValue', Math.round(temperature * 100), this.log);
    }

    const humEp = rt.humidity;
    if (humidity !== undefined && humEp?.hasAttributeServer('RelativeHumidityMeasurement', 'measuredValue')) {
      await humEp.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', Math.round(humidity * 100), this.log);
    }

    const energyEp = rt.energy;
    const energy = sns.ENERGY as { Voltage?: number; Current?: number; Power?: number; Total?: number } | undefined;
    if (energy && energyEp) {
      if (typeof energy.Voltage === 'number' && energyEp.hasAttributeServer('ElectricalPowerMeasurement', 'voltage')) {
        await energyEp.updateAttribute('ElectricalPowerMeasurement', 'voltage', Math.round(energy.Voltage * 1000), this.log);
      }
      if (typeof energy.Current === 'number' && energyEp.hasAttributeServer('ElectricalPowerMeasurement', 'activeCurrent')) {
        await energyEp.updateAttribute('ElectricalPowerMeasurement', 'activeCurrent', Math.round(energy.Current * 1000), this.log);
      }
      if (typeof energy.Power === 'number' && energyEp.hasAttributeServer('ElectricalPowerMeasurement', 'activePower')) {
        await energyEp.updateAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(energy.Power * 1000), this.log);
      }
      if (typeof energy.Total === 'number' && energyEp.hasAttributeServer('ElectricalEnergyMeasurement', 'cumulativeEnergyImported')) {
        await energyEp.updateAttribute(
          'ElectricalEnergyMeasurement',
          'cumulativeEnergyImported',
          { energy: Math.round(energy.Total * 1000000) },
          this.log,
        );
      }
    }
  }
}
