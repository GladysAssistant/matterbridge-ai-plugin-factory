/**
 * Matterbridge plugin for Govee Bluetooth Low Energy devices: LED lights/strips
 * (on/off, brightness, RGB, color temperature) and BLE sensors (temperature,
 * humidity, motion, contact, water leak, buttons). No cloud — pure local BLE.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  colorTemperatureLight,
  contactSensor,
  DeviceTypeDefinition,
  dimmableLight,
  extendedColorLight,
  genericSwitch,
  humiditySensor,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  occupancySensor,
  PlatformMatterbridge,
  temperatureSensor,
  waterLeakDetector,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { BooleanState, ColorControl, OccupancySensing } from 'matterbridge/matter/clusters';

import { BleAdvertisement, BleManager, normAddr } from './ble.js';
import {
  buildBrightness,
  buildColor,
  buildColorTemperature,
  buildPower,
  GoveeReadings,
  hsvToRgb,
  miredsToKelvin,
  parseAdvertisement,
} from './govee.js';

/** A single device entry from the plugin configuration. */
export interface GoveeDeviceConfig {
  name: string;
  address: string;
  type: 'light' | 'sensor';
  /** Govee model code, e.g. "H6159", "H5179", "H5121". Drives capabilities. */
  model?: string;
}

export type GoveePlatformConfig = BasePlatformConfig & {
  devices?: GoveeDeviceConfig[];
  scan_interval_seconds?: number;
  whiteList?: string[];
  blackList?: string[];
};

/** Capability set derived from a model code. */
interface SensorCaps {
  tempHumidity: boolean;
  motion: boolean;
  contact: boolean;
  leak: boolean;
  button: boolean;
}

const TEMP_HUM_MODELS = ['H5179', 'H5075', 'H5074', 'H5072', 'H5102', 'H5101', 'H5100', 'H5052', 'H5174'];

function sensorCaps(model?: string): SensorCaps {
  const m = (model ?? '').toUpperCase();
  return {
    tempHumidity: TEMP_HUM_MODELS.some((x) => m.includes(x)) || (!m.startsWith('H51') && !m.startsWith('H505') && !m.startsWith('H512')),
    motion: m.includes('H5121'),
    contact: m.includes('H5123'),
    leak: m.includes('H5054'),
    button: m.includes('H5127'),
  };
}

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger.
 * @param {GoveePlatformConfig} config - Platform configuration.
 * @returns {GoveeBlePlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: GoveePlatformConfig): GoveeBlePlatform {
  return new GoveeBlePlatform(matterbridge, log, config);
}

export class GoveeBlePlatform extends MatterbridgeDynamicPlatform {
  private readonly ble: BleManager;
  /** Endpoints by normalised address. */
  private readonly endpoints = new Map<string, MatterbridgeEndpoint>();
  /** Device config by normalised address. */
  private readonly configs = new Map<string, GoveeDeviceConfig>();
  /** Last RGB written to a light, for combining with color-temperature. */
  private readonly lastRgb = new Map<string, [number, number, number]>();
  private rescanTimer?: NodeJS.Timeout;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: GoveePlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.ble = new BleManager(this.log);
    this.log.info('Initializing Govee BLE Platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    await this.ble.init();
    this.ble.onAdvertisement((adv) => this.onAdvertisement(adv));

    const devices = (this.config as GoveePlatformConfig).devices ?? [];
    for (const dev of devices) {
      if (!dev.address || !dev.name) {
        this.log.warn(`Skipping device with missing name/address: ${JSON.stringify(dev)}`);
        continue;
      }
      this.setSelectDevice(normAddr(dev.address), dev.name);
      if (!this.validateDevice([dev.name, dev.address, normAddr(dev.address)])) continue;
      if (dev.type === 'light') await this.createLight(dev);
      else await this.createSensor(dev);
    }

    await this.ble.startScanning();

    const interval = Math.max(10, (this.config as GoveePlatformConfig).scan_interval_seconds ?? 30) * 1000;
    this.rescanTimer = setInterval(() => {
      void this.ble.startScanning();
    }, interval);
    this.rescanTimer.unref?.();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    for (const device of this.getDevices()) {
      this.log.info(`Configuring device ${device.deviceName}`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    await this.ble.stop();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  // ---- Lights ---------------------------------------------------------------

  private async createLight(dev: GoveeDeviceConfig): Promise<void> {
    const addr = normAddr(dev.address);
    const m = (dev.model ?? '').toUpperCase();
    // Most Govee LED products are RGB. Allow opting into simpler types via model hints.
    const supportsBrightnessOnly = m.includes('DIMMABLE');
    const ctOnly = m.includes('WHITE') || m.includes('CT');
    const deviceType = supportsBrightnessOnly ? dimmableLight : ctOnly ? colorTemperatureLight : extendedColorLight;

    const endpoint = new MatterbridgeEndpoint(deviceType, { id: `govee-${addr}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(dev.name, dev.address, this.matterbridge.aggregatorVendorId, 'Govee', dev.model ?? 'Govee BLE Light', 1, '1.0.0')
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers();

    endpoint
      .addCommandHandler('on', async () => {
        await this.ble.writeLight(addr, [buildPower(true)]);
      })
      .addCommandHandler('off', async () => {
        await this.ble.writeLight(addr, [buildPower(false)]);
      })
      .addCommandHandler('moveToLevel', async (data) => {
        const level = (data.request as { level: number }).level;
        await this.ble.writeLight(addr, [buildBrightness(level)]);
      })
      .addCommandHandler('moveToLevelWithOnOff', async (data) => {
        const level = (data.request as { level: number }).level;
        await this.ble.writeLight(addr, [buildPower(level > 0), buildBrightness(level)]);
      });

    if (!supportsBrightnessOnly) {
      endpoint
        .addCommandHandler('moveToHueAndSaturation', async (data) => {
          const req = data.request as { hue: number; saturation: number };
          await this.applyHueSat(addr, req.hue, req.saturation);
        })
        .addCommandHandler('moveToHue', async (data) => {
          const hue = (data.request as { hue: number }).hue;
          const sat = (endpoint.getAttribute(ColorControl.Cluster.id, 'currentSaturation') as number) ?? 254;
          await this.applyHueSat(addr, hue, sat);
        })
        .addCommandHandler('moveToSaturation', async (data) => {
          const sat = (data.request as { saturation: number }).saturation;
          const hue = (endpoint.getAttribute(ColorControl.Cluster.id, 'currentHue') as number) ?? 0;
          await this.applyHueSat(addr, hue, sat);
        })
        .addCommandHandler('moveToColorTemperature', async (data) => {
          const mireds = (data.request as { colorTemperatureMireds: number }).colorTemperatureMireds;
          const rgb = this.lastRgb.get(addr) ?? [255, 255, 255];
          await this.ble.writeLight(addr, [buildColorTemperature(miredsToKelvin(mireds), ...rgb)]);
        });
    }

    await this.registerDevice(endpoint);
    this.endpoints.set(addr, endpoint);
    this.configs.set(addr, dev);
    this.log.info(`Registered Govee light "${dev.name}" (${dev.address})`);
  }

  private async applyHueSat(addr: string, hue: number, sat: number): Promise<void> {
    const [r, g, b] = hsvToRgb(hue, sat, 254);
    this.lastRgb.set(addr, [r, g, b]);
    await this.ble.writeLight(addr, [buildColor(r, g, b)]);
  }

  // ---- Sensors --------------------------------------------------------------

  private async createSensor(dev: GoveeDeviceConfig): Promise<void> {
    const addr = normAddr(dev.address);
    const caps = sensorCaps(dev.model);

    const deviceTypes: [DeviceTypeDefinition, ...DeviceTypeDefinition[]] = caps.motion
      ? [occupancySensor]
      : caps.contact
        ? [contactSensor]
        : caps.leak
          ? [waterLeakDetector]
          : caps.button
            ? [genericSwitch]
            : caps.tempHumidity
              ? [temperatureSensor, humiditySensor]
              : [temperatureSensor];

    const endpoint = new MatterbridgeEndpoint(deviceTypes, { id: `govee-${addr}` }).createDefaultBridgedDeviceBasicInformationClusterServer(
      dev.name,
      dev.address,
      this.matterbridge.aggregatorVendorId,
      'Govee',
      dev.model ?? 'Govee BLE Sensor',
      1,
      '1.0.0',
    );

    if (caps.tempHumidity) {
      endpoint.createDefaultTemperatureMeasurementClusterServer(null).createDefaultRelativeHumidityMeasurementClusterServer(null);
    }
    endpoint.createDefaultPowerSourceReplaceableBatteryClusterServer();
    endpoint.addRequiredClusterServers();

    await this.registerDevice(endpoint);
    this.endpoints.set(addr, endpoint);
    this.configs.set(addr, dev);
    this.log.info(`Registered Govee sensor "${dev.name}" (${dev.address})`);
  }

  // ---- Advertisement handling ----------------------------------------------

  private onAdvertisement(adv: BleAdvertisement): void {
    const dev = this.configs.get(adv.address);
    const endpoint = this.endpoints.get(adv.address);
    if (!dev || !endpoint || dev.type !== 'sensor') return;

    const readings = parseAdvertisement(dev.model, adv.manufacturerData, adv.localName);
    void this.applyReadings(endpoint, readings);
  }

  private async applyReadings(endpoint: MatterbridgeEndpoint, r: GoveeReadings): Promise<void> {
    try {
      if (r.temperature !== undefined) {
        await endpoint.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(r.temperature * 100), this.log);
      }
      if (r.humidity !== undefined) {
        await endpoint.setAttribute('RelativeHumidityMeasurement', 'measuredValue', Math.round(r.humidity * 100), this.log);
      }
      if (r.battery !== undefined) {
        await endpoint.setAttribute('PowerSource', 'batPercentRemaining', Math.max(0, Math.min(100, r.battery)) * 2, this.log);
      }
      if (r.motion !== undefined) {
        await endpoint.setAttribute(OccupancySensing.Cluster.id, 'occupancy', { occupied: r.motion }, this.log);
      }
      if (r.contactOpen !== undefined) {
        // BooleanState stateValue: true = closed/contact for Matter contact sensor.
        await endpoint.setAttribute(BooleanState.Cluster.id, 'stateValue', !r.contactOpen, this.log);
      }
      if (r.leak !== undefined) {
        await endpoint.setAttribute(BooleanState.Cluster.id, 'stateValue', r.leak, this.log);
      }
    } catch (err) {
      this.log.debug(`Failed to apply readings: ${(err as Error).message}`);
    }
  }
}
