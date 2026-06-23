/**
 * Matterbridge plugin for Mitsubishi Electric air conditioners exposed through
 * the MELCloud (Classic) and MELCloud Home cloud APIs.
 *
 * Air-to-Air (ATA) devices are exposed as Matter air conditioners with
 * on/off, setpoint, internal temperature, operation mode and vane (vertical /
 * horizontal blade) swing control. Air-to-Water and unknown devices are
 * autodiscovered and listed but not yet controllable (MVP scope).
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  airConditioner,
  type BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  type PlatformMatterbridge,
} from 'matterbridge';
import type { AnsiLogger, LogLevel } from 'matterbridge/logger';
import type { ActionContext } from 'matterbridge/matter';
import { FanControl, OnOff, Thermostat } from 'matterbridge/matter/clusters';

import { createMelcloudClient, type AtaMode, type MelcloudApp, type MelcloudClient, type MelcloudDevice } from './melcloud/index.js';

/** Plugin configuration surfaced through the Matterbridge frontend. */
export type MelcloudPlatformConfig = BasePlatformConfig & {
  application?: MelcloudApp;
  username?: string;
  password?: string;
  pollInterval?: number;
  whiteList?: string[];
  blackList?: string[];
};

const C = 100; // Matter encodes temperatures in 0.01 °C units.

const MODE_TO_SYSTEM: Record<AtaMode, Thermostat.SystemMode> = {
  auto: Thermostat.SystemMode.Auto,
  cool: Thermostat.SystemMode.Cool,
  heat: Thermostat.SystemMode.Heat,
  fan: Thermostat.SystemMode.FanOnly,
  dry: Thermostat.SystemMode.Dry,
};

const SYSTEM_TO_MODE: Partial<Record<Thermostat.SystemMode, AtaMode>> = {
  [Thermostat.SystemMode.Auto]: 'auto',
  [Thermostat.SystemMode.Cool]: 'cool',
  [Thermostat.SystemMode.Heat]: 'heat',
  [Thermostat.SystemMode.FanOnly]: 'fan',
  [Thermostat.SystemMode.Dry]: 'dry',
};

/**
 * Entry point invoked by Matterbridge to instantiate the platform.
 *
 * @param matterbridge - The Matterbridge instance.
 * @param log - The plugin logger.
 * @param config - The plugin configuration.
 * @returns The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: MelcloudPlatformConfig): MelcloudPlatform {
  return new MelcloudPlatform(matterbridge, log, config);
}

interface Registered {
  endpoint: MatterbridgeEndpoint;
  device: MelcloudDevice;
}

/** Dynamic platform bridging MELCloud ATA devices into Matter. */
export class MelcloudPlatform extends MatterbridgeDynamicPlatform {
  #client: MelcloudClient | undefined;

  readonly #registered = new Map<string, Registered>();

  #pollTimer: NodeJS.Timeout | undefined;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: MelcloudPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.log.info('Initializing MELCloud platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const config = this.config as MelcloudPlatformConfig;
    const application: MelcloudApp = config.application === 'home' ? 'home' : 'classic';
    const username = (config.username ?? '').trim();
    const password = config.password ?? '';

    if (username === '' || password === '') {
      this.log.warn('MELCloud credentials are not configured. Set the application, username and password in the plugin config.');
      return;
    }

    this.#client = createMelcloudClient(application, username, password, this.log);

    try {
      await this.#client.login();
    } catch (error) {
      this.log.error(`MELCloud login failed: ${error instanceof Error ? error.message : String(error)}`);
      this.#client = undefined;
      return;
    }

    await this.#discoverDevices();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    await this.#refreshStates();

    const config = this.config as MelcloudPlatformConfig;
    const interval = Math.max(30, config.pollInterval ?? 60) * 1000;
    this.#pollTimer = setInterval(() => {
      void this.#refreshStates();
    }, interval);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    this.#registered.clear();
    this.#client = undefined;
    if ((this.config as MelcloudPlatformConfig).unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  async #discoverDevices(): Promise<void> {
    if (!this.#client) return;
    let devices: MelcloudDevice[];
    try {
      devices = await this.#client.listDevices();
    } catch (error) {
      this.log.error(`MELCloud device discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    this.log.info(`MELCloud discovered ${String(devices.length)} device(s).`);
    for (const device of devices) {
      // Autodiscovery: surface every device in the frontend select list.
      this.setSelectDevice(device.serial, device.name);
      if (!this.validateDevice([device.name, device.serial])) continue;

      if (!device.supported || !device.ata) {
        this.log.info(`Skipping unsupported device "${device.name}" (type: ${device.type}). ATW support is planned.`);
        continue;
      }
      await this.#registerAta(device);
    }
  }

  async #registerAta(device: MelcloudDevice): Promise<void> {
    const ata = device.ata;
    if (!ata) return;

    // Matterbridge derives the Matter uniqueId (used by controllers such as
    // Gladys to recognize a device across restarts) from
    // md5(deviceName + serialNumber + vendorName + productName). Feed it ONLY
    // immutable values: device.id never changes, and a constant product name.
    // The real serial/model are best-effort API metadata that flip between
    // fetches (e.g. acModel is often undefined), which previously changed the
    // uniqueId on every restart and made the device reappear as "new".
    const endpoint = new MatterbridgeEndpoint(airConditioner, { id: device.id })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        device.name,
        device.id,
        this.matterbridge.aggregatorVendorId,
        'Mitsubishi Electric',
        'MELCloud ATA',
      )
      .createDefaultIdentifyClusterServer()
      .createDefaultOnOffClusterServer(ata.power)
      // createDefaultThermostatClusterServer expects raw °C and scales by 100 internally.
      .createDefaultThermostatClusterServer(
        ata.roomTemperature,
        ata.setTemperature,
        ata.setTemperature,
        undefined,
        ata.minSetpoint,
        ata.maxSetpoint,
        ata.minSetpoint,
        ata.maxSetpoint,
      )
      // MultiSpeed fan: discrete speeds 1..N via speedSetting plus the coarse
      // Off/Low/Med/High/Auto fanMode. Both are kept in sync in #refreshStates.
      .createCompleteFanControlClusterServer(
        fanSpeedToMode(ata.fanSpeed),
        FanControl.FanModeSequence.OffLowMedHighAuto,
        speedToPercent(ata.fanSpeed, ata.numberOfFanSpeeds),
        speedToPercent(ata.fanSpeed, ata.numberOfFanSpeeds),
        ata.numberOfFanSpeeds,
        ata.fanSpeed,
        ata.fanSpeed,
        { rockLeftRight: true, rockUpDown: true, rockRound: false },
        { rockLeftRight: ata.vaneHorizontalSwing, rockUpDown: ata.vaneVerticalSwing, rockRound: false },
      )
      .createDefaultTemperatureMeasurementClusterServer(ata.roomTemperature * C)
      .addRequiredClusterServers();

    this.#wireHandlers(endpoint, device);

    await this.registerDevice(endpoint);
    this.#registered.set(device.id, { endpoint, device });
    this.#logDeviceInfo(device);
    this.log.info(`Registered MELCloud ATA device "${device.name}".`);
  }

  #wireHandlers(endpoint: MatterbridgeEndpoint, device: MelcloudDevice): void {
    endpoint.addCommandHandler('on', () => {
      void this.#apply(device, { power: true });
    });
    endpoint.addCommandHandler('off', () => {
      void this.#apply(device, { power: false });
    });

    void endpoint.subscribeAttribute(
      Thermostat,
      'systemMode',
      (value: Thermostat.SystemMode, _old: Thermostat.SystemMode, context: ActionContext) => {
        if (context.fabric === undefined) return; // ignore our own offline updates
        const mode = SYSTEM_TO_MODE[value];
        if (mode) void this.#apply(device, { mode });
      },
      this.log,
    );
    void endpoint.subscribeAttribute(
      Thermostat,
      'occupiedHeatingSetpoint',
      (value: number, _old: number, context: ActionContext) => {
        if (context.fabric === undefined) return;
        void this.#apply(device, { setTemperature: Math.round(value / C) });
      },
      this.log,
    );
    void endpoint.subscribeAttribute(
      Thermostat,
      'occupiedCoolingSetpoint',
      (value: number, _old: number, context: ActionContext) => {
        if (context.fabric === undefined) return;
        void this.#apply(device, { setTemperature: Math.round(value / C) });
      },
      this.log,
    );
    void endpoint.subscribeAttribute(
      FanControl,
      'fanMode',
      (value: FanControl.FanMode, _old: FanControl.FanMode, context: ActionContext) => {
        if (context.fabric === undefined) return;
        // "Off" on the fan turns the whole unit off (there is no fan-off state on a MELCloud unit).
        if (value === FanControl.FanMode.Off) {
          void this.#apply(device, { power: false });
          return;
        }
        void this.#apply(device, { power: true, fanSpeed: fanModeToSpeed(value, device.ata?.numberOfFanSpeeds ?? 5) });
      },
      this.log,
    );
    // Discrete speed slider (MultiSpeed feature): 1..numberOfFanSpeeds.
    void endpoint.subscribeAttribute(
      FanControl,
      'speedSetting',
      (value: number | null, _old: number | null, context: ActionContext) => {
        if (context.fabric === undefined || value === null) return;
        const max = device.ata?.numberOfFanSpeeds ?? 5;
        const speed = Math.max(0, Math.min(max, Math.round(value)));
        void this.#apply(device, speed === 0 ? { fanSpeed: 0 } : { power: true, fanSpeed: speed });
      },
      this.log,
    );
    // Percentage slider: mapped onto the discrete MELCloud speeds.
    void endpoint.subscribeAttribute(
      FanControl,
      'percentSetting',
      (value: number | null, _old: number | null, context: ActionContext) => {
        if (context.fabric === undefined || value === null) return;
        const max = device.ata?.numberOfFanSpeeds ?? 5;
        const speed = percentToSpeed(value, max);
        void this.#apply(device, speed === 0 ? { fanSpeed: 0 } : { power: true, fanSpeed: speed });
      },
      this.log,
    );
    void endpoint.subscribeAttribute(
      FanControl,
      'rockSetting',
      (value: { rockLeftRight?: boolean; rockUpDown?: boolean }, _old: unknown, context: ActionContext) => {
        if (context.fabric === undefined) return;
        void this.#apply(device, {
          vaneHorizontalSwing: value.rockLeftRight === true,
          vaneVerticalSwing: value.rockUpDown === true,
        });
      },
      this.log,
    );
  }

  async #apply(device: MelcloudDevice, patch: Parameters<MelcloudClient['setAta']>[1]): Promise<void> {
    if (!this.#client) return;
    try {
      await this.#client.setAta(device, patch);
      this.log.info(`Updated "${device.name}": ${JSON.stringify(patch)}`);
    } catch (error) {
      this.log.error(`Failed to update "${device.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #refreshStates(): Promise<void> {
    if (!this.#client || this.#registered.size === 0) return;
    let devices: MelcloudDevice[];
    try {
      devices = await this.#client.listDevices();
    } catch (error) {
      this.log.debug(`MELCloud state refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    for (const device of devices) {
      const registered = this.#registered.get(device.id);
      if (!registered || !device.ata) continue;
      const { endpoint } = registered;
      const ata = device.ata;
      await endpoint.setAttribute(OnOff, 'onOff', ata.power, this.log);
      await endpoint.setAttribute(Thermostat, 'localTemperature', Math.round(ata.roomTemperature * C), this.log);
      await endpoint.setAttribute(Thermostat, 'occupiedHeatingSetpoint', Math.round(ata.setTemperature * C), this.log);
      await endpoint.setAttribute(Thermostat, 'occupiedCoolingSetpoint', Math.round(ata.setTemperature * C), this.log);
      await endpoint.setAttribute(Thermostat, 'systemMode', MODE_TO_SYSTEM[ata.mode], this.log);
      // Keep fanMode, the discrete speed and the percentage all consistent with the unit.
      await endpoint.setAttribute(FanControl, 'fanMode', ata.power ? fanSpeedToMode(ata.fanSpeed) : FanControl.FanMode.Off, this.log);
      await endpoint.setAttribute(FanControl, 'speedSetting', ata.fanSpeed, this.log);
      await endpoint.setAttribute(FanControl, 'speedCurrent', ata.fanSpeed, this.log);
      await endpoint.setAttribute(FanControl, 'percentSetting', speedToPercent(ata.fanSpeed, ata.numberOfFanSpeeds), this.log);
      await endpoint.setAttribute(FanControl, 'percentCurrent', speedToPercent(ata.fanSpeed, ata.numberOfFanSpeeds), this.log);
      await endpoint.setAttribute(
        FanControl,
        'rockSetting',
        { rockLeftRight: ata.vaneHorizontalSwing, rockUpDown: ata.vaneVerticalSwing, rockRound: false },
        this.log,
      );
      await endpoint.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(ata.roomTemperature * C), this.log);
    }
  }

  /** Log the inventory metadata (models, serials, Wi-Fi adapter, house) mirrored from the web app. */
  #logDeviceInfo(device: MelcloudDevice): void {
    const info = device.info;
    if (!info) return;
    const parts: string[] = [];
    if (info.buildingName) parts.push(`house="${info.buildingName}"`);
    if (info.acModel) parts.push(`acModel="${info.acModel}"`);
    if (info.acSerial) parts.push(`acSerial="${info.acSerial}"`);
    if (info.outdoorModel) parts.push(`outdoorModel="${info.outdoorModel}"`);
    if (info.outdoorSerial) parts.push(`outdoorSerial="${info.outdoorSerial}"`);
    if (info.wifiModel) parts.push(`wifiModel="${info.wifiModel}"`);
    if (info.wifiSerial) parts.push(`wifiSerial="${info.wifiSerial}"`);
    if (info.macAddress) parts.push(`mac="${info.macAddress}"`);
    if (parts.length > 0) this.log.info(`MELCloud device "${device.name}" info: ${parts.join(', ')}`);
  }
}

/** Map a MELCloud fan speed index (0 = auto) to the coarse Matter {@link FanControl.FanMode}. */
function fanSpeedToMode(fanSpeed: number): FanControl.FanMode {
  if (fanSpeed <= 0) return FanControl.FanMode.Auto;
  if (fanSpeed <= 1) return FanControl.FanMode.Low;
  if (fanSpeed <= 3) return FanControl.FanMode.Medium;
  return FanControl.FanMode.High;
}

/**
 * Map a Matter {@link FanControl.FanMode} back to a MELCloud fan speed index.
 * Low = 1, Medium = 3, High = max, Auto/Smart = 0. "Off" is handled by callers
 * as a power-off and never reaches this function.
 */
function fanModeToSpeed(mode: FanControl.FanMode, max: number): number {
  switch (mode) {
    case FanControl.FanMode.Low:
      return 1;
    case FanControl.FanMode.Medium:
      return Math.min(3, max);
    case FanControl.FanMode.High:
    case FanControl.FanMode.On:
      return max;
    default:
      return 0; // Auto / Smart
  }
}

/** Convert a MELCloud speed index (0..max) to a 0-100 percentage for the FanControl percent attributes. */
function speedToPercent(fanSpeed: number, max: number): number {
  if (fanSpeed <= 0 || max <= 0) return 0;
  return Math.round((Math.min(fanSpeed, max) / max) * 100);
}

/** Convert a 0-100 percentage to the nearest MELCloud speed index (1..max, or 0 when zero). */
function percentToSpeed(percent: number, max: number): number {
  if (percent <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(max, Math.round((percent / 100) * max)));
}
