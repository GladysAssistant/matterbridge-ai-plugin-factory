/**
 * Matterbridge KNX plugin — exposes KNX devices defined in a CSV (ETS export)
 * as Matter devices.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { readFileSync } from 'node:fs';

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  contactSensor,
  coverDevice,
  dimmableLight,
  humiditySensor,
  onOffLight,
  onOffSwitch,
  temperatureSensor,
  thermostatDevice,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { KnxDeviceDef, parseKnxCsv } from './csv.js';
import { decodeDpt, KnxClientWrapper, KnxConnectionConfig } from './knx.js';

export type KnxPlatformConfig = BasePlatformConfig & {
  connection?: KnxConnectionConfig;
  devices_csv?: string;
  poll_interval_seconds?: number;
  whiteList?: string[];
  blackList?: string[];
};

interface RegisteredDevice {
  def: KnxDeviceDef;
  endpoint: MatterbridgeEndpoint;
  // Update Matter attributes from a decoded KNX state value.
  applyState: (value: unknown) => Promise<void>;
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const isDimmer = (dpt: string): boolean => dpt.startsWith('5');

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger.
 * @param {KnxPlatformConfig} config - Platform configuration.
 * @returns {KnxPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: KnxPlatformConfig): KnxPlatform {
  return new KnxPlatform(matterbridge, log, config);
}

export class KnxPlatform extends MatterbridgeDynamicPlatform {
  private knx?: KnxClientWrapper;
  private pollTimer?: NodeJS.Timeout;
  // Map a KNX group address (state/read) -> registered devices listening on it.
  private readonly gaIndex = new Map<string, RegisteredDevice[]>();
  private readonly devices: RegisteredDevice[] = [];

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: KnxPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.7.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.7.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version.`);
    }

    this.log.info('Initializing KNX Platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const cfg = this.config as KnxPlatformConfig;
    const defs = this.loadCsv(cfg.devices_csv);
    if (defs.length === 0) {
      this.log.warn('No KNX devices loaded from CSV. Check the devices_csv path and content.');
    }

    this.knx = new KnxClientWrapper(cfg.connection ?? ({ type: 'tunneling', host: '', port: 3671 } as KnxConnectionConfig), this.log);
    this.knx.onIndication((ga, raw) => void this.onKnxIndication(ga, raw));
    await this.knx.connect();

    for (const def of defs) {
      await this.createDevice(def);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    // Request the current state of every readable group address.
    this.pollStates();

    const seconds = (this.config as KnxPlatformConfig).poll_interval_seconds ?? 30;
    if (seconds > 0) {
      this.pollTimer = setInterval(() => this.pollStates(), seconds * 1000);
    }
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
    await this.knx?.disconnect();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  private loadCsv(path?: string): KnxDeviceDef[] {
    if (!path) {
      this.log.error('Config "devices_csv" is not set; no devices to expose.');
      return [];
    }
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (e) {
      this.log.error(`Cannot read CSV file "${path}": ${(e as Error).message}`);
      return [];
    }
    const { devices, errors } = parseKnxCsv(content);
    for (const err of errors) this.log.warn(`CSV: ${err}`);
    this.log.info(`Loaded ${devices.length} KNX device(s) from ${path}`);
    return devices;
  }

  /** Register one KNX group address as a state source for a device. */
  private indexGa(ga: string, dev: RegisteredDevice): void {
    if (!ga) return;
    const list = this.gaIndex.get(ga) ?? [];
    list.push(dev);
    this.gaIndex.set(ga, list);
  }

  private pollStates(): void {
    if (!this.knx) return;
    for (const ga of this.gaIndex.keys()) this.knx.read(ga);
  }

  private async onKnxIndication(ga: string, raw: Buffer): Promise<void> {
    const list = this.gaIndex.get(ga);
    if (!list) return;
    for (const dev of list) {
      try {
        const value = decodeDpt(raw, dev.def.dpt);
        this.log.debug(`KNX state ${ga} -> ${JSON.stringify(value)} for "${dev.def.name}"`);
        await dev.applyState(value);
      } catch (e) {
        this.log.debug(`Failed to apply state for ${dev.def.name}: ${(e as Error).message}`);
      }
    }
  }

  private async createDevice(def: KnxDeviceDef): Promise<void> {
    this.setSelectDevice(def.name, def.name);
    if (!this.validateDevice([def.name])) return;

    let dev: RegisteredDevice;
    switch (def.deviceType) {
      case 'light':
        dev = this.buildLight(def);
        break;
      case 'switch':
        dev = this.buildSwitch(def);
        break;
      case 'cover':
        dev = this.buildCover(def);
        break;
      case 'climate':
        dev = this.buildClimate(def);
        break;
      case 'sensor_temperature':
        dev = this.buildTemperature(def);
        break;
      case 'sensor_humidity':
        dev = this.buildHumidity(def);
        break;
      case 'binary_sensor':
        dev = this.buildBinarySensor(def);
        break;
      default:
        return;
    }

    // Index state + read GAs so indications/poll responses update this device.
    this.indexGa(def.groupAddressState, dev);
    if (def.groupAddressRead && def.groupAddressRead !== def.groupAddressState) this.indexGa(def.groupAddressRead, dev);

    this.devices.push(dev);
    await this.registerDevice(dev.endpoint);
  }

  private baseEndpoint(def: KnxDeviceDef, type: ConstructorParameters<typeof MatterbridgeEndpoint>[0]): MatterbridgeEndpoint {
    const id = `knx-${def.deviceType}-${def.groupAddressWrite || def.groupAddressState}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const serial = `KNX-${def.groupAddressWrite || def.groupAddressState || def.name}`;
    return new MatterbridgeEndpoint(type, { id })
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(def.name, serial, this.matterbridge.aggregatorVendorId, 'Matterbridge KNX', def.deviceType, 1, '1.0.0');
  }

  // ---- Builders ---------------------------------------------------------

  private buildLight(def: KnxDeviceDef): RegisteredDevice {
    const dimmer = isDimmer(def.dpt);
    const endpoint = this.baseEndpoint(def, dimmer ? dimmableLight : onOffLight).addRequiredClusterServers();

    endpoint.addCommandHandler('on', () => this.writeOnOff(def, true, dimmer));
    endpoint.addCommandHandler('off', () => this.writeOnOff(def, false, dimmer));
    if (dimmer) {
      const onLevel = (data: { request?: { level?: number } }): void => {
        const level = data.request?.level ?? 0;
        const pct = clamp(Math.round((level / 254) * 100), 0, 100);
        this.knx?.write(def.groupAddressWrite, pct, def.dpt);
      };
      endpoint.addCommandHandler('moveToLevel', onLevel);
      endpoint.addCommandHandler('moveToLevelWithOnOff', onLevel);
    }

    const applyState = async (value: unknown): Promise<void> => {
      if (dimmer) {
        const pct = clamp(Math.round(Number(value)), 0, 100);
        await endpoint.setAttribute('OnOff', 'onOff', pct > 0, this.log);
        await endpoint.setAttribute('LevelControl', 'currentLevel', clamp(Math.round((pct / 100) * 254), 1, 254), this.log);
      } else {
        await endpoint.setAttribute('OnOff', 'onOff', Boolean(value), this.log);
      }
    };
    return { def, endpoint, applyState };
  }

  private buildSwitch(def: KnxDeviceDef): RegisteredDevice {
    const endpoint = this.baseEndpoint(def, onOffSwitch).addRequiredClusterServers();
    endpoint.addCommandHandler('on', () => this.knx?.write(def.groupAddressWrite, true, def.dpt));
    endpoint.addCommandHandler('off', () => this.knx?.write(def.groupAddressWrite, false, def.dpt));
    const applyState = async (value: unknown): Promise<void> => {
      await endpoint.setAttribute('OnOff', 'onOff', Boolean(value), this.log);
    };
    return { def, endpoint, applyState };
  }

  private writeOnOff(def: KnxDeviceDef, on: boolean, dimmer: boolean): void {
    if (dimmer) this.knx?.write(def.groupAddressWrite, on ? 100 : 0, def.dpt);
    else this.knx?.write(def.groupAddressWrite, on, def.dpt);
  }

  private buildCover(def: KnxDeviceDef): RegisteredDevice {
    const positional = isDimmer(def.dpt); // DPT 5.001 = absolute position; otherwise 1.008 up/down only
    const endpoint = this.baseEndpoint(def, coverDevice).createDefaultWindowCoveringClusterServer(0).addRequiredClusterServers();

    // KNX position: 0% = open, 100% = closed. Matter: 0 = open, 10000 = closed.
    endpoint.addCommandHandler('upOrOpen', () => this.coverMove(def, positional, 0));
    endpoint.addCommandHandler('downOrClose', () => this.coverMove(def, positional, 100));
    endpoint.addCommandHandler('stopMotion', () => {
      /* No dedicated stop GA in the CSV model; covers usually stop on a second up/down telegram. */
    });
    if (positional) {
      endpoint.addCommandHandler('goToLiftPercentage', (data: { request?: { liftPercent100thsValue?: number } }) => {
        const pct = clamp(Math.round((data.request?.liftPercent100thsValue ?? 0) / 100), 0, 100);
        this.knx?.write(def.groupAddressWrite, pct, def.dpt);
      });
    }

    const applyState = async (value: unknown): Promise<void> => {
      if (!positional) return; // 1.008 yields only a direction, not a position to reflect
      const pct = clamp(Math.round(Number(value)), 0, 100);
      const m = pct * 100;
      await endpoint.setAttribute('WindowCovering', 'currentPositionLiftPercent100ths', m, this.log);
      await endpoint.setAttribute('WindowCovering', 'targetPositionLiftPercent100ths', m, this.log);
    };
    return { def, endpoint, applyState };
  }

  private coverMove(def: KnxDeviceDef, positional: boolean, pct: number): void {
    if (positional) this.knx?.write(def.groupAddressWrite, pct, def.dpt);
    // DPT 1.008: 0 = Up/Open, 1 = Down/Close.
    else this.knx?.write(def.groupAddressWrite, pct >= 100, def.dpt);
  }

  private buildClimate(def: KnxDeviceDef): RegisteredDevice {
    const endpoint = this.baseEndpoint(def, thermostatDevice).createDefaultThermostatClusterServer(21, 21, 25).addRequiredClusterServers();

    endpoint.subscribeAttribute(
      'Thermostat',
      'occupiedHeatingSetpoint',
      (value: number) => {
        this.knx?.write(def.groupAddressWrite, value / 100, def.dpt); // Matter centi-°C -> KNX °C
      },
      this.log,
    );

    const applyState = async (value: unknown): Promise<void> => {
      const centi = Math.round(Number(value) * 100);
      await endpoint.setAttribute('Thermostat', 'occupiedHeatingSetpoint', centi, this.log);
    };
    return { def, endpoint, applyState };
  }

  private buildTemperature(def: KnxDeviceDef): RegisteredDevice {
    const endpoint = this.baseEndpoint(def, temperatureSensor).createDefaultTemperatureMeasurementClusterServer().addRequiredClusterServers();
    const applyState = async (value: unknown): Promise<void> => {
      await endpoint.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(Number(value) * 100), this.log);
    };
    return { def, endpoint, applyState };
  }

  private buildHumidity(def: KnxDeviceDef): RegisteredDevice {
    const endpoint = this.baseEndpoint(def, humiditySensor).createDefaultRelativeHumidityMeasurementClusterServer().addRequiredClusterServers();
    const applyState = async (value: unknown): Promise<void> => {
      await endpoint.setAttribute('RelativeHumidityMeasurement', 'measuredValue', clamp(Math.round(Number(value) * 100), 0, 10000), this.log);
    };
    return { def, endpoint, applyState };
  }

  private buildBinarySensor(def: KnxDeviceDef): RegisteredDevice {
    const endpoint = this.baseEndpoint(def, contactSensor).createDefaultBooleanStateClusterServer(true).addRequiredClusterServers();
    const applyState = async (value: unknown): Promise<void> => {
      await endpoint.setAttribute('BooleanState', 'stateValue', Boolean(value), this.log);
    };
    return { def, endpoint, applyState };
  }
}
