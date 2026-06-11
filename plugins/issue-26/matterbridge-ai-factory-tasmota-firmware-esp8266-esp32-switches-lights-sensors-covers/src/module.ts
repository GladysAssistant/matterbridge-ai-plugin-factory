/**
 * Matterbridge Tasmota plugin (ESP8266/ESP32 — switches, lights, sensors, covers).
 *
 * HTTP-mode integration with Tasmota firmware devices via the `/cm?cmnd=` web API.
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
}

/** Plugin configuration. */
export type TasmotaPlatformConfig = BasePlatformConfig & {
  devices?: TasmotaDeviceConfig[];
  pollIntervalSeconds?: number;
  whiteList: string[];
  blackList: string[];
};

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
}

/** Tasmota HTTP platform for Matterbridge. */
export class TasmotaPlatform extends MatterbridgeDynamicPlatform {
  private readonly runtimes: TasmotaRuntime[] = [];
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
    if (devices.length === 0) {
      this.log.warn('No Tasmota devices configured. Add devices in the plugin config (name, host, type).');
    }

    for (const cfg of devices) {
      try {
        await this.createDevice(cfg);
      } catch (error) {
        this.log.error(`Failed to create device ${cfg.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
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
   * @returns {Promise<Record<string, unknown> | undefined>} The JSON response or undefined on error.
   */
  private async send(cfg: TasmotaDeviceConfig, command: string): Promise<Record<string, unknown> | undefined> {
    const url = this.buildUrl(cfg, command);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
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
   * Create and register a Matter endpoint for a Tasmota device.
   *
   * @param {TasmotaDeviceConfig} cfg - The device configuration.
   * @returns {Promise<void>} Resolves when the device is registered.
   */
  private async createDevice(cfg: TasmotaDeviceConfig): Promise<void> {
    const serial = `tasmota-${(cfg.topic || cfg.host).replace(/[^a-zA-Z0-9]/g, '-')}-${cfg.type}`;
    const ch = cfg.powerChannel ?? 1;

    this.setSelectDevice(serial, cfg.name);
    if (!this.validateDevice([cfg.name, serial])) {
      this.log.info(`Device ${cfg.name} filtered out by white/black list`);
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

      case 'sensor':
        device = new MatterbridgeEndpoint([temperatureSensor, humiditySensor, electricalSensor], { id: serial })
          .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'Tasmota', 'Tasmota Sensor')
          .createDefaultPowerSourceWiredClusterServer()
          .createDefaultTemperatureMeasurementClusterServer()
          .createDefaultRelativeHumidityMeasurementClusterServer()
          .createDefaultElectricalPowerMeasurementClusterServer()
          .createDefaultElectricalEnergyMeasurementClusterServer()
          .addRequiredClusterServers();
        break;

      default:
        this.log.error(`Unknown device type "${cfg.type as string}" for ${cfg.name}`);
        return;
    }

    await this.registerDevice(device);
    this.runtimes.push({ cfg, device });
    this.log.info(`Registered Tasmota ${cfg.type} "${cfg.name}" (${cfg.host})`);
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

      if (cfg.type === 'sensor') await this.updateSensor(device, sns);
    } catch (error) {
      this.log.debug(`Update failed for ${cfg.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Update sensor attributes from the StatusSNS payload.
   *
   * @param {MatterbridgeEndpoint} device - The endpoint.
   * @param {Record<string, unknown>} sns - The StatusSNS object.
   * @returns {Promise<void>} Resolves when attributes are updated.
   */
  private async updateSensor(device: MatterbridgeEndpoint, sns: Record<string, unknown>): Promise<void> {
    let temperature: number | undefined;
    let humidity: number | undefined;

    for (const value of Object.values(sns)) {
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (typeof obj.Temperature === 'number') temperature = obj.Temperature;
        if (typeof obj.Humidity === 'number') humidity = obj.Humidity;
      }
    }

    if (temperature !== undefined && device.hasAttributeServer('TemperatureMeasurement', 'measuredValue')) {
      await device.updateAttribute('TemperatureMeasurement', 'measuredValue', Math.round(temperature * 100), this.log);
    }
    if (humidity !== undefined && device.hasAttributeServer('RelativeHumidityMeasurement', 'measuredValue')) {
      await device.updateAttribute('RelativeHumidityMeasurement', 'measuredValue', Math.round(humidity * 100), this.log);
    }

    const energy = sns.ENERGY as { Voltage?: number; Current?: number; Power?: number; Total?: number } | undefined;
    if (energy) {
      if (typeof energy.Voltage === 'number' && device.hasAttributeServer('ElectricalPowerMeasurement', 'voltage')) {
        await device.updateAttribute('ElectricalPowerMeasurement', 'voltage', Math.round(energy.Voltage * 1000), this.log);
      }
      if (typeof energy.Current === 'number' && device.hasAttributeServer('ElectricalPowerMeasurement', 'activeCurrent')) {
        await device.updateAttribute('ElectricalPowerMeasurement', 'activeCurrent', Math.round(energy.Current * 1000), this.log);
      }
      if (typeof energy.Power === 'number' && device.hasAttributeServer('ElectricalPowerMeasurement', 'activePower')) {
        await device.updateAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(energy.Power * 1000), this.log);
      }
      if (typeof energy.Total === 'number' && device.hasAttributeServer('ElectricalEnergyMeasurement', 'cumulativeEnergyImported')) {
        await device.updateAttribute(
          'ElectricalEnergyMeasurement',
          'cumulativeEnergyImported',
          { energy: Math.round(energy.Total * 1000000) },
          this.log,
        );
      }
    }
  }
}
