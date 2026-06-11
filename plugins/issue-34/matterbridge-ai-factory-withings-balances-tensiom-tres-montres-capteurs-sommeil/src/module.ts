/**
 * Matterbridge Withings plugin.
 *
 * Exposes Withings cloud devices (scales, blood pressure monitors, watches,
 * sleep/Aura monitors, thermo) as read-only Matter sensors.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  flowSensor,
  humiditySensor,
  lightSensor,
  occupancySensor,
  powerSource,
  pressureSensor,
  temperatureSensor,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { isValidString } from 'matterbridge/utils';

import { MeasType, WithingsClient, WithingsDevice, WithingsTokens } from './withingsClient.js';

/** Instance configuration for the Withings platform. */
export type WithingsPlatformConfig = BasePlatformConfig & {
  whiteList: string[];
  blackList: string[];
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  pollInterval?: number;
};

/** Supported Matter sensor kinds. */
type SensorKind = 'temperature' | 'humidity' | 'pressure' | 'illuminance' | 'flow' | 'occupancy';

/** A registered sensor endpoint and how to update it. */
interface RegisteredSensor {
  endpoint: MatterbridgeEndpoint;
  kind: SensorKind;
  /** Withings measure type id, if this sensor is fed by a measure. */
  meastype?: number;
  /** Special source for non-measure sensors. */
  source?: 'sleepDuration' | 'sleepQuality';
}

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger instance.
 * @param {WithingsPlatformConfig} config - Platform configuration.
 * @returns {WithingsPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: WithingsPlatformConfig): WithingsPlatform {
  return new WithingsPlatform(matterbridge, log, config);
}

/** Withings dynamic platform. */
export class WithingsPlatform extends MatterbridgeDynamicPlatform {
  private client?: WithingsClient;
  private sensors: RegisteredSensor[] = [];
  private pollTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
   * @param {AnsiLogger} log - Logger instance.
   * @param {WithingsPlatformConfig} config - Platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: WithingsPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`);
    }

    this.log.info('Initializing Withings platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const config = this.config as WithingsPlatformConfig;
    if (!isValidString(config.clientId, 1) || !isValidString(config.clientSecret, 1) || !isValidString(config.refreshToken, 1)) {
      this.log.warn('Withings credentials are not configured (clientId, clientSecret, refreshToken). No devices will be created. Complete the OAuth2 flow on https://developer.withings.com/ and fill the plugin config.');
      return;
    }

    const tokens: WithingsTokens = {
      accessToken: config.accessToken ?? '',
      refreshToken: config.refreshToken,
      expiresAt: 0,
    };
    this.client = new WithingsClient(config.clientId, config.clientSecret, tokens, this.log, (t) => this.persistTokens(t));

    try {
      const devices = await this.client.getDevices();
      this.log.info(`Discovered ${devices.length} Withings device(s)`);
      for (const device of devices) await this.createDeviceSensors(device);
    } catch (error) {
      this.log.error(`Failed to discover Withings devices: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    if (!this.client) return;
    await this.poll();
    const intervalMs = Math.max(5, (this.config as WithingsPlatformConfig).pollInterval ?? 15) * 60_000;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, intervalMs);
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
    this.sensors = [];
    this.client = undefined;
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Persists refreshed OAuth tokens back into the plugin config.
   *
   * @param {WithingsTokens} tokens - The new tokens.
   */
  private persistTokens(tokens: WithingsTokens): void {
    const config = this.config as WithingsPlatformConfig;
    config.accessToken = tokens.accessToken;
    config.refreshToken = tokens.refreshToken;
    this.log.debug('Withings tokens refreshed');
  }

  /**
   * Maps a Withings device type to the metric sensors it should expose.
   *
   * @param {string} type - The Withings device type.
   * @returns {{ key: string; label: string; kind: SensorKind; meastype?: number; source?: 'sleepDuration' | 'sleepQuality' }[]} Sensor definitions.
   */
  private sensorDefsForType(type: string): { key: string; label: string; kind: SensorKind; meastype?: number; source?: 'sleepDuration' | 'sleepQuality' }[] {
    const t = type.toLowerCase();
    if (t.includes('scale') || t.includes('balance')) {
      return [
        { key: 'weight', label: 'Weight', kind: 'flow', meastype: MeasType.weight },
        { key: 'fat', label: 'Fat Ratio', kind: 'humidity', meastype: MeasType.fatRatio },
        { key: 'muscle', label: 'Muscle Mass', kind: 'flow', meastype: MeasType.muscleMass },
        { key: 'hr', label: 'Heart Rate', kind: 'flow', meastype: MeasType.heartRate },
        { key: 'temp', label: 'Body Temperature', kind: 'temperature', meastype: MeasType.bodyTemperature },
      ];
    }
    if (t.includes('pressure') || t.includes('bpm')) {
      return [
        { key: 'sys', label: 'Systolic', kind: 'pressure', meastype: MeasType.systolic },
        { key: 'dia', label: 'Diastolic', kind: 'pressure', meastype: MeasType.diastolic },
        { key: 'hr', label: 'Heart Rate', kind: 'flow', meastype: MeasType.heartRate },
      ];
    }
    if (t.includes('thermo')) {
      return [{ key: 'temp', label: 'Body Temperature', kind: 'temperature', meastype: MeasType.bodyTemperature }];
    }
    if (t.includes('sleep') || t.includes('aura')) {
      return [
        { key: 'duration', label: 'Sleep Duration', kind: 'flow', source: 'sleepDuration' },
        { key: 'quality', label: 'Sleep Quality', kind: 'humidity', source: 'sleepQuality' },
        { key: 'roomtemp', label: 'Room Temperature', kind: 'temperature', meastype: MeasType.temperature },
      ];
    }
    // Watches / activity trackers (Steel, ScanWatch, Activity Tracker).
    return [
      { key: 'hr', label: 'Heart Rate', kind: 'flow', meastype: MeasType.heartRate },
      { key: 'spo2', label: 'SpO2', kind: 'humidity', meastype: MeasType.spo2 },
    ];
  }

  /**
   * Creates and registers all sensor endpoints for a Withings device.
   *
   * @param {WithingsDevice} device - The Withings device.
   */
  private async createDeviceSensors(device: WithingsDevice): Promise<void> {
    const baseName = `${device.model || device.type} ${device.deviceid}`.trim();
    this.setSelectDevice(device.deviceid, baseName);
    if (!this.validateDevice([baseName, device.deviceid])) return;

    for (const def of this.sensorDefsForType(device.type)) {
      const name = `${device.model || device.type} ${def.label}`;
      const serial = `WTH-${device.deviceid}-${def.key}`;
      const endpoint = this.buildSensorEndpoint(`wth_${device.deviceid}_${def.key}`, name, serial, device, def.kind);
      await this.registerDevice(endpoint);
      this.sensors.push({ endpoint, kind: def.kind, meastype: def.meastype, source: def.source });
    }
  }

  /**
   * Builds a single read-only Matter sensor endpoint.
   *
   * @param {string} id - Stable endpoint id.
   * @param {string} name - Device name.
   * @param {string} serial - Serial number.
   * @param {WithingsDevice} device - The owning Withings device.
   * @param {SensorKind} kind - The Matter sensor kind.
   * @returns {MatterbridgeEndpoint} The configured endpoint.
   */
  private buildSensorEndpoint(id: string, name: string, serial: string, device: WithingsDevice, kind: SensorKind): MatterbridgeEndpoint {
    const deviceType = {
      temperature: temperatureSensor,
      humidity: humiditySensor,
      pressure: pressureSensor,
      illuminance: lightSensor,
      flow: flowSensor,
      occupancy: occupancySensor,
    }[kind];

    const endpoint = new MatterbridgeEndpoint([deviceType, powerSource], { id }).createDefaultBridgedDeviceBasicInformationClusterServer(
      name,
      serial,
      this.matterbridge.aggregatorVendorId,
      'Withings',
      device.model || device.type,
    );

    switch (kind) {
      case 'temperature':
        endpoint.createDefaultTemperatureMeasurementClusterServer();
        break;
      case 'humidity':
        endpoint.createDefaultRelativeHumidityMeasurementClusterServer();
        break;
      case 'pressure':
        endpoint.createDefaultPressureMeasurementClusterServer();
        break;
      case 'illuminance':
        endpoint.createDefaultIlluminanceMeasurementClusterServer();
        break;
      case 'flow':
        endpoint.createDefaultFlowMeasurementClusterServer();
        break;
      case 'occupancy':
        endpoint.createDefaultOccupancySensingClusterServer();
        break;
    }

    endpoint.createDefaultPowerSourceReplaceableBatteryClusterServer(this.batteryPercent(device));
    endpoint.addRequiredClusterServers();
    return endpoint;
  }

  /**
   * Converts the Withings battery level string into a percentage.
   *
   * @param {WithingsDevice} device - The Withings device.
   * @returns {number} Battery percentage (0-100).
   */
  private batteryPercent(device: WithingsDevice): number {
    switch ((device.battery ?? '').toLowerCase()) {
      case 'high':
        return 100;
      case 'medium':
        return 50;
      case 'low':
        return 15;
      default:
        return 100;
    }
  }

  /** Polls the Withings cloud and updates all registered sensors. */
  private async poll(): Promise<void> {
    if (!this.client) return;
    try {
      const meastypes = [...new Set(this.sensors.filter((s) => s.meastype !== undefined).map((s) => s.meastype as number))];
      const measures = meastypes.length ? await this.client.getLatestMeasures(meastypes) : new Map<number, number>();
      const needSleep = this.sensors.some((s) => s.source);
      const sleep = needSleep ? await this.client.getSleepSummary() : undefined;

      for (const sensor of this.sensors) {
        let value: number | undefined;
        if (sensor.meastype !== undefined) value = measures.get(sensor.meastype);
        else if (sensor.source === 'sleepDuration') value = sleep?.durationMin;
        else if (sensor.source === 'sleepQuality') value = sleep?.quality;
        if (value !== undefined) await this.applyValue(sensor, value);
      }
      this.log.debug('Withings poll completed');
    } catch (error) {
      this.log.error(`Withings poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Writes a real-world value into the Matter cluster of a sensor.
   *
   * Health values are intentionally never logged.
   *
   * @param {RegisteredSensor} sensor - The target sensor.
   * @param {number} value - The real-world value.
   */
  private async applyValue(sensor: RegisteredSensor, value: number): Promise<void> {
    const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(v)));
    switch (sensor.kind) {
      case 'temperature':
        await sensor.endpoint.setAttribute('TemperatureMeasurement', 'measuredValue', clamp(value * 100, -27315, 32767));
        break;
      case 'humidity':
        await sensor.endpoint.setAttribute('RelativeHumidityMeasurement', 'measuredValue', clamp(value * 100, 0, 10000));
        break;
      case 'pressure':
        await sensor.endpoint.setAttribute('PressureMeasurement', 'measuredValue', clamp(value, -32768, 32767));
        break;
      case 'illuminance':
        await sensor.endpoint.setAttribute('IlluminanceMeasurement', 'measuredValue', clamp(value, 0, 65534));
        break;
      case 'flow':
        await sensor.endpoint.setAttribute('FlowMeasurement', 'measuredValue', clamp(value * 10, 0, 65534));
        break;
      case 'occupancy':
        await sensor.endpoint.setAttribute('OccupancySensing', 'occupancy', { occupied: value > 0 });
        break;
    }
  }
}
