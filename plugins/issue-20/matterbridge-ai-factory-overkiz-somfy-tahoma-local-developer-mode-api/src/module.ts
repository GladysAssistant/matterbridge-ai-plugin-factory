/**
 * Matterbridge plugin for Overkiz / Somfy TaHoma using the local Developer Mode API.
 *
 * Exposes Overkiz devices (covers, switches, lights and sensors) to Matter by
 * talking directly to the local gateway (no Somfy cloud).
 *
 * @file module.ts
 * @author Matterbridge AI Factory
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  coverDevice,
  onOffOutlet,
  onOffLight,
  dimmableLight,
  temperatureSensor,
  contactSensor,
  lightSensor,
} from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { OverkizDevice, OverkizLocalClient, OverkizState } from './overkizClient.js';

/** Plugin configuration. */
export type OverkizPlatformConfig = BasePlatformConfig & {
  host?: string;
  port?: number;
  token?: string;
  verifySsl?: boolean;
  ca?: string;
  pollingInterval?: number;
  whiteList: string[];
  blackList: string[];
};

/** Supported Matter mappings for an Overkiz device. */
type Category = 'cover' | 'switch' | 'light' | 'dimmableLight' | 'temperature' | 'contact' | 'luminance';

/** Internal record linking an Overkiz device to its Matter endpoint. */
interface MappedDevice {
  device: OverkizDevice;
  endpoint: MatterbridgeEndpoint;
  category: Category;
  positionCommand?: string;
}

/**
 * Entry point invoked by Matterbridge.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger.
 * @param {OverkizPlatformConfig} config - Platform configuration.
 * @returns {OverkizPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: OverkizPlatformConfig): OverkizPlatform {
  return new OverkizPlatform(matterbridge, log, config);
}

const COVER_UICLASSES = new Set([
  'RollerShutter',
  'Awning',
  'ExteriorScreen',
  'Screen',
  'Window',
  'GarageDoor',
  'Gate',
  'Curtain',
  'Pergola',
  'VenetianBlind',
  'ExteriorVenetianBlind',
  'SwingingShutter',
]);

/** Dynamic platform bridging Overkiz local devices to Matter. */
export class OverkizPlatform extends MatterbridgeDynamicPlatform {
  private client?: OverkizLocalClient;
  private readonly mapped = new Map<string, MappedDevice>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: OverkizPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.7.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.7.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing Overkiz / Somfy TaHoma local platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const config = this.config as OverkizPlatformConfig;
    if (!config.host || !config.token) {
      this.log.error('Missing "host" and/or "token" in the plugin configuration. Configure the gateway IP/host and the Developer Mode Bearer token.');
      return;
    }

    this.client = new OverkizLocalClient({
      host: config.host,
      port: config.port ?? 8443,
      token: config.token,
      verifySsl: config.verifySsl ?? false,
      ca: config.ca,
      log: this.log,
    });

    this.client.on('stateChanged', (deviceURL: string, states: OverkizState[]) => {
      void this.onStateChanged(deviceURL, states);
    });

    await this.discoverDevices();
    await this.client.startEvents(config.pollingInterval ?? 5000);
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    for (const mapped of this.mapped.values()) {
      await this.applyStates(mapped, mapped.device.states ?? []);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    await this.client?.stop();
    this.client = undefined;
    this.mapped.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Classify an Overkiz device into a supported Matter category.
   *
   * @param {OverkizDevice} device - The Overkiz device.
   * @returns {Category | undefined} The mapped category, or undefined if unsupported.
   */
  private classify(device: OverkizDevice): Category | undefined {
    const uiClass = device.definition?.uiClass ?? '';
    if (COVER_UICLASSES.has(uiClass)) return 'cover';
    if (uiClass === 'TemperatureSensor') return 'temperature';
    if (uiClass === 'ContactSensor' || uiClass === 'DoorWindowSensor' || uiClass === 'WindowHandle') return 'contact';
    if (uiClass === 'LightSensor' || uiClass === 'LuminanceSensor') return 'luminance';
    if (uiClass === 'Light' || uiClass === 'SwitchableLight') {
      return this.hasCommand(device, 'setIntensity') ? 'dimmableLight' : 'light';
    }
    if (uiClass === 'OnOff' || uiClass === 'Plug' || this.hasCommand(device, 'on')) return 'switch';
    return undefined;
  }

  /**
   * Check whether a device advertises a given command.
   *
   * @param {OverkizDevice} device - The Overkiz device.
   * @param {string} name - Command name to look for.
   * @returns {boolean} True if the command is supported.
   */
  private hasCommand(device: OverkizDevice, name: string): boolean {
    return (device.definition?.commands ?? []).some((c) => (c.commandName ?? c.name) === name);
  }

  /**
   * Discover devices from the gateway and register the supported ones.
   *
   * @returns {Promise<void>} Resolves when discovery completes.
   */
  private async discoverDevices(): Promise<void> {
    if (!this.client) return;
    this.log.info('Discovering Overkiz devices...');
    let devices: OverkizDevice[];
    try {
      devices = await this.client.getDevices();
    } catch (error) {
      this.log.error(`Failed to fetch devices from the gateway: ${(error as Error).message}`);
      return;
    }
    this.log.info(`Gateway returned ${devices.length} device(s)`);

    for (const device of devices) {
      // Skip the gateway/protocol pseudo devices that have no usable endpoint.
      if (!device.deviceURL || device.deviceURL.endsWith('#0') === false && device.controllableName?.includes('ProtocolGateway')) continue;
      const category = this.classify(device);
      if (!category) {
        this.log.debug(`Skipping unsupported device "${device.label}" (uiClass=${device.definition?.uiClass})`);
        continue;
      }

      const serial = device.deviceURL;
      this.setSelectDevice(serial, device.label);
      if (!this.validateDevice([device.label, serial])) continue;

      const endpoint = this.buildEndpoint(device, category);
      if (!endpoint) continue;
      await this.registerDevice(endpoint);
      this.log.info(`Registered "${device.label}" as ${category}`);
    }
  }

  /**
   * Build a Matter endpoint for an Overkiz device.
   *
   * @param {OverkizDevice} device - The Overkiz device.
   * @param {Category} category - The mapped category.
   * @returns {MatterbridgeEndpoint | undefined} The endpoint, or undefined on error.
   */
  private buildEndpoint(device: OverkizDevice, category: Category): MatterbridgeEndpoint | undefined {
    const id = device.deviceURL.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const serial = device.deviceURL;
    const url = device.deviceURL;

    const base = (deviceType: typeof coverDevice): MatterbridgeEndpoint =>
      new MatterbridgeEndpoint(deviceType, { id })
        .createDefaultIdentifyClusterServer()
        .createDefaultBridgedDeviceBasicInformationClusterServer(device.label, serial, 0xfff1, 'Somfy', device.definition?.widgetName ?? device.controllableName ?? 'Overkiz Device');

    let mapped: MappedDevice;

    switch (category) {
      case 'cover': {
        const positionCommand = this.hasCommand(device, 'setClosure') ? 'setClosure' : this.hasCommand(device, 'setPosition') ? 'setPosition' : undefined;
        const start = this.closureToLift(this.readNumber(device.states ?? [], 'core:ClosureState'));
        const endpoint = base(coverDevice).createDefaultWindowCoveringClusterServer(start ?? 0).addRequiredClusterServers();
        endpoint
          .addCommandHandler('upOrOpen', () => void this.client?.sendCommand(url, 'open'))
          .addCommandHandler('downOrClose', () => void this.client?.sendCommand(url, 'close'))
          .addCommandHandler('stopMotion', () => void this.client?.sendCommand(url, 'stop'))
          .addCommandHandler('goToLiftPercentage', (data) => {
            const liftPercent100ths = (data.request as { liftPercent100thsValue: number }).liftPercent100thsValue;
            if (!positionCommand) return;
            const closurePct = positionCommand === 'setClosure' ? Math.round(liftPercent100ths / 100) : Math.round(100 - liftPercent100ths / 100);
            void this.client?.sendCommand(url, positionCommand, [closurePct]);
          });
        mapped = { device, endpoint, category, positionCommand };
        break;
      }
      case 'switch': {
        const endpoint = base(onOffOutlet).createDefaultOnOffClusterServer().addRequiredClusterServers();
        endpoint
          .addCommandHandler('on', () => void this.client?.sendCommand(url, 'on'))
          .addCommandHandler('off', () => void this.client?.sendCommand(url, 'off'));
        mapped = { device, endpoint, category };
        break;
      }
      case 'light': {
        const endpoint = base(onOffLight).createDefaultOnOffClusterServer().addRequiredClusterServers();
        endpoint
          .addCommandHandler('on', () => void this.client?.sendCommand(url, 'on'))
          .addCommandHandler('off', () => void this.client?.sendCommand(url, 'off'));
        mapped = { device, endpoint, category };
        break;
      }
      case 'dimmableLight': {
        const endpoint = base(dimmableLight).createDefaultOnOffClusterServer().createDefaultLevelControlClusterServer().addRequiredClusterServers();
        endpoint
          .addCommandHandler('on', () => void this.client?.sendCommand(url, 'on'))
          .addCommandHandler('off', () => void this.client?.sendCommand(url, 'off'));
        const setLevel = (data: { request: { level: number } }): void => {
          const pct = Math.max(0, Math.min(100, Math.round((data.request.level / 254) * 100)));
          void this.client?.sendCommand(url, 'setIntensity', [pct]);
        };
        endpoint.addCommandHandler('moveToLevel', (data) => setLevel(data as { request: { level: number } }));
        endpoint.addCommandHandler('moveToLevelWithOnOff', (data) => setLevel(data as { request: { level: number } }));
        mapped = { device, endpoint, category };
        break;
      }
      case 'temperature': {
        const endpoint = base(temperatureSensor).createDefaultTemperatureMeasurementClusterServer().addRequiredClusterServers();
        mapped = { device, endpoint, category };
        break;
      }
      case 'contact': {
        const endpoint = base(contactSensor).createDefaultBooleanStateClusterServer(false).addRequiredClusterServers();
        mapped = { device, endpoint, category };
        break;
      }
      case 'luminance': {
        const endpoint = base(lightSensor).createDefaultIlluminanceMeasurementClusterServer().addRequiredClusterServers();
        mapped = { device, endpoint, category };
        break;
      }
    }

    this.mapped.set(url, mapped);
    return mapped.endpoint;
  }

  /**
   * Handle a state change event coming from the gateway.
   *
   * @param {string} deviceURL - The device URL.
   * @param {OverkizState[]} states - The changed states.
   * @returns {Promise<void>} Resolves when attributes are updated.
   */
  private async onStateChanged(deviceURL: string, states: OverkizState[]): Promise<void> {
    const mapped = this.mapped.get(deviceURL);
    if (!mapped) return;
    await this.applyStates(mapped, states);
  }

  /**
   * Apply Overkiz states onto the Matter endpoint attributes.
   *
   * @param {MappedDevice} mapped - The mapped device.
   * @param {OverkizState[]} states - The states to apply.
   * @returns {Promise<void>} Resolves when attributes are updated.
   */
  private async applyStates(mapped: MappedDevice, states: OverkizState[]): Promise<void> {
    const { endpoint, category } = mapped;
    try {
      switch (category) {
        case 'cover': {
          const lift = this.closureToLift(this.readNumber(states, 'core:ClosureState'));
          if (lift !== undefined) {
            await endpoint.setAttribute('WindowCovering', 'currentPositionLiftPercent100ths', lift * 100);
            await endpoint.setAttribute('WindowCovering', 'targetPositionLiftPercent100ths', lift * 100);
          }
          break;
        }
        case 'switch':
        case 'light': {
          const on = this.readString(states, 'core:OnOffState');
          if (on !== undefined) await endpoint.setAttribute('OnOff', 'onOff', on === 'on');
          break;
        }
        case 'dimmableLight': {
          const on = this.readString(states, 'core:OnOffState');
          if (on !== undefined) await endpoint.setAttribute('OnOff', 'onOff', on === 'on');
          const intensity = this.readNumber(states, 'core:LightIntensityState') ?? this.readNumber(states, 'core:IntensityState');
          if (intensity !== undefined) await endpoint.setAttribute('LevelControl', 'currentLevel', Math.max(1, Math.round((intensity / 100) * 254)));
          break;
        }
        case 'temperature': {
          const temp = this.readNumber(states, 'core:TemperatureState');
          if (temp !== undefined) await endpoint.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(temp * 100));
          break;
        }
        case 'contact': {
          const contact = this.readString(states, 'core:ContactState');
          if (contact !== undefined) await endpoint.setAttribute('BooleanState', 'stateValue', contact === 'closed');
          break;
        }
        case 'luminance': {
          const lux = this.readNumber(states, 'core:LuminanceState');
          if (lux !== undefined && lux > 0) await endpoint.setAttribute('IlluminanceMeasurement', 'measuredValue', Math.round(10000 * Math.log10(lux) + 1));
          break;
        }
      }
    } catch (error) {
      this.log.debug(`Failed to apply states for ${mapped.device.label}: ${(error as Error).message}`);
    }
  }

  /**
   * Convert an Overkiz closure percentage (0 open, 100 closed) to a Matter lift
   * percentage (0 open, 100 closed). They share the same orientation.
   *
   * @param {number | undefined} closure - Overkiz closure value.
   * @returns {number | undefined} Lift percentage 0-100 or undefined.
   */
  private closureToLift(closure: number | undefined): number | undefined {
    if (closure === undefined) return undefined;
    return Math.max(0, Math.min(100, Math.round(closure)));
  }

  /**
   * Read a numeric state value.
   *
   * @param {OverkizState[]} states - States to search.
   * @param {string} name - State name.
   * @returns {number | undefined} The numeric value or undefined.
   */
  private readNumber(states: OverkizState[], name: string): number | undefined {
    const value = states.find((s) => s.name === name)?.value;
    return typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value)) ? Number(value) : undefined;
  }

  /**
   * Read a string state value.
   *
   * @param {OverkizState[]} states - States to search.
   * @param {string} name - State name.
   * @returns {string | undefined} The string value or undefined.
   */
  private readString(states: OverkizState[], name: string): string | undefined {
    const value = states.find((s) => s.name === name)?.value;
    return typeof value === 'string' ? value : undefined;
  }
}
