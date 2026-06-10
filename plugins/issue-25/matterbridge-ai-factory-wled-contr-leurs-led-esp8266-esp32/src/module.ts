/**
 * Matterbridge plugin for WLED (contrôleurs LED ESP8266/ESP32).
 *
 * Exposes each configured WLED controller as a Matter Extended Color Light
 * (On/Off + Brightness + RGB + Color Temperature) using the local WLED JSON API.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { BasePlatformConfig, extendedColorLight, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { ColorControl, LevelControl, OnOff } from 'matterbridge/matter/clusters';
import { hslColorToRgbColor, kelvinToMireds, miredsToKelvin, rgbColorToHslColor, xyColorToRgbColor } from 'matterbridge/utils';

import { WledClient, WledJson } from './wledClient.js';

/** Configuration of a single WLED controller. */
export interface WledControllerConfig {
  host: string;
  name?: string;
}

/** Plugin configuration. */
export type WledPlatformConfig = BasePlatformConfig & {
  whiteList: string[];
  blackList: string[];
  controllers: WledControllerConfig[];
  pollInterval: number;
};

/** WLED color temperature range mapped to Matter (mireds). */
const CT_MIN_KELVIN = 2000;
const CT_MAX_KELVIN = 6500;

/**
 * Standard plugin entrypoint.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The plugin logger.
 * @param {WledPlatformConfig} config - The plugin configuration.
 * @returns {WledPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: WledPlatformConfig): WledPlatform {
  return new WledPlatform(matterbridge, log, config);
}

/**
 * WLED dynamic platform: one Matter Extended Color Light per WLED controller.
 */
export class WledPlatform extends MatterbridgeDynamicPlatform {
  private readonly clients = new Map<string, WledClient>();
  private readonly endpoints = new Map<string, MatterbridgeEndpoint>();
  private pollTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
   * @param {AnsiLogger} log - The plugin logger.
   * @param {WledPlatformConfig} config - The plugin configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: WledPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.6.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.6.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing WLED Platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();
    await this.discoverDevices();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    await this.pollAll();

    const interval = Math.max(5, (this.config as WledPlatformConfig).pollInterval || 30) * 1000;
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, interval);
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
    this.clients.clear();
    this.endpoints.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Discovers and registers every configured WLED controller.
   *
   * @returns {Promise<void>} Resolves when discovery completes.
   */
  private async discoverDevices(): Promise<void> {
    const controllers = (this.config as WledPlatformConfig).controllers ?? [];
    if (controllers.length === 0) {
      this.log.warn('No WLED controllers configured. Add controllers (host + optional name) in the plugin config.');
      return;
    }

    for (const controller of controllers) {
      if (!controller?.host) {
        this.log.warn('Skipping a controller entry without a host.');
        continue;
      }
      await this.addController(controller);
    }
  }

  /**
   * Connects to one WLED controller and creates the matching Matter device.
   *
   * @param {WledControllerConfig} controller - The controller configuration.
   * @returns {Promise<void>} Resolves when the device is registered (or skipped).
   */
  private async addController(controller: WledControllerConfig): Promise<void> {
    const client = new WledClient(controller.host);
    let json: WledJson;
    try {
      json = await client.getJson();
    } catch (error) {
      this.log.error(`Failed to reach WLED controller at ${controller.host}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const name = controller.name || json.info.name || `WLED ${controller.host}`;
    const serial = json.info.mac ? json.info.mac.replace(/:/g, '') : `wled-${controller.host}`.replace(/[^a-zA-Z0-9]/g, '');

    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) {
      this.log.info(`Skipping WLED device ${name} (${serial}) filtered by white/black list.`);
      return;
    }

    const device = new MatterbridgeEndpoint(extendedColorLight, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        name,
        serial,
        this.matterbridge.aggregatorVendorId,
        'WLED',
        'WLED Controller',
        undefined,
        json.info.ver,
      )
      .createDefaultIdentifyClusterServer()
      .createDefaultOnOffClusterServer(json.state.on)
      .createDefaultLevelControlClusterServer(this.briToLevel(json.state.bri))
      .createDefaultColorControlClusterServer()
      .addRequiredClusterServers();

    this.registerHandlers(device, client);

    this.clients.set(serial, client);
    this.endpoints.set(serial, device);

    await this.registerDevice(device);
    this.log.info(`Registered WLED device ${name} (${serial}) fw ${json.info.ver}.`);
  }

  /**
   * Wires Matter command handlers to WLED JSON API calls.
   *
   * @param {MatterbridgeEndpoint} device - The Matter endpoint.
   * @param {WledClient} client - The WLED client for this device.
   * @returns {void}
   */
  private registerHandlers(device: MatterbridgeEndpoint, client: WledClient): void {
    const safe = (fn: () => Promise<void>): void => {
      fn().catch((error: unknown) => this.log.error(`WLED command failed: ${error instanceof Error ? error.message : String(error)}`));
    };

    device.addCommandHandler('on', () => safe(() => client.setState({ on: true })));
    device.addCommandHandler('off', () => safe(() => client.setState({ on: false })));
    device.addCommandHandler('toggle', () => safe(async () => client.setState({ on: !(await client.getState()).on })));

    const onLevel = (data: { request: Record<string, unknown> }): void => {
      safe(() => client.setState({ bri: this.levelToBri(Number(data.request.level)) }));
    };
    device.addCommandHandler('moveToLevel', onLevel);
    device.addCommandHandler('moveToLevelWithOnOff', onLevel);

    device.addCommandHandler('moveToHue', (data) => {
      safe(() => this.applyHsl(client, Number(data.request.hue), Number(data.attributes.currentSaturation ?? 0)));
    });
    device.addCommandHandler('moveToSaturation', (data) => {
      safe(() => this.applyHsl(client, Number(data.attributes.currentHue ?? 0), Number(data.request.saturation)));
    });
    device.addCommandHandler('moveToHueAndSaturation', (data) => {
      safe(() => this.applyHsl(client, Number(data.request.hue), Number(data.request.saturation)));
    });
    device.addCommandHandler('moveToColor', (data) => {
      const rgb = xyColorToRgbColor(Number(data.request.colorX) / 65536, Number(data.request.colorY) / 65536);
      safe(() => client.setState({ seg: [{ id: 0, col: [[rgb.r, rgb.g, rgb.b]] }] }));
    });
    device.addCommandHandler('moveToColorTemperature', (data) => {
      const kelvin = Math.round(miredsToKelvin(Number(data.request.colorTemperatureMireds)));
      safe(() => client.setState({ seg: [{ id: 0, col: [[0, 0, 0]], cct: kelvin }] }));
    });
  }

  /**
   * Converts a Matter hue/saturation pair into an RGB WLED segment update.
   *
   * @param {WledClient} client - The WLED client.
   * @param {number} hue - Matter currentHue (0-254).
   * @param {number} saturation - Matter currentSaturation (0-254).
   * @returns {Promise<void>} Resolves when the state is applied.
   */
  private async applyHsl(client: WledClient, hue: number, saturation: number): Promise<void> {
    const rgb = hslColorToRgbColor((hue / 254) * 360, (saturation / 254) * 100, 50);
    await client.setState({ seg: [{ id: 0, col: [[rgb.r, rgb.g, rgb.b]] }] });
  }

  /**
   * Polls all controllers and updates Matter attributes from WLED state.
   *
   * @returns {Promise<void>} Resolves when all controllers are polled.
   */
  private async pollAll(): Promise<void> {
    for (const [serial, client] of this.clients) {
      const device = this.endpoints.get(serial);
      if (!device) continue;
      try {
        const state = await client.getState();
        await device.updateAttribute(OnOff.Cluster.id, 'onOff', state.on, device.log);
        await device.updateAttribute(LevelControl.Cluster.id, 'currentLevel', this.briToLevel(state.bri), device.log);

        const seg = state.seg?.[0];
        const col = seg?.col?.[0];
        if (col && col.length >= 3) {
          const hsl = rgbColorToHslColor({ r: col[0], g: col[1], b: col[2] });
          await device.updateAttribute(ColorControl.Cluster.id, 'currentHue', Math.round((hsl.h / 360) * 254), device.log);
          await device.updateAttribute(ColorControl.Cluster.id, 'currentSaturation', Math.round((hsl.s / 100) * 254), device.log);
        }
        if (typeof seg?.cct === 'number') {
          const kelvin = seg.cct > 255 ? seg.cct : CT_MIN_KELVIN + (seg.cct / 255) * (CT_MAX_KELVIN - CT_MIN_KELVIN);
          await device.updateAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds', Math.round(kelvinToMireds(kelvin)), device.log);
        }
      } catch (error) {
        this.log.debug(`Polling WLED ${serial} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Converts WLED brightness (0-255) to Matter level (1-254).
   *
   * @param {number} bri - WLED brightness.
   * @returns {number} Matter level.
   */
  private briToLevel(bri: number): number {
    return Math.max(1, Math.min(254, Math.round((bri / 255) * 254)));
  }

  /**
   * Converts Matter level (1-254) to WLED brightness (0-255).
   *
   * @param {number} level - Matter level.
   * @returns {number} WLED brightness.
   */
  private levelToBri(level: number): number {
    return Math.max(0, Math.min(255, Math.round((level / 254) * 255)));
  }
}
