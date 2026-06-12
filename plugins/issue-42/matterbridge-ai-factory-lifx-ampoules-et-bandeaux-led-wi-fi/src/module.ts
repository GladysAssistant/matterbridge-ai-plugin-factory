/**
 * Matterbridge LIFX plugin (ampoules et bandeaux LED Wi-Fi).
 *
 * Exposes LIFX lights discovered on the LAN (UDP 56700) as Matter lights:
 * On/Off, Brightness, Color temperature (Kelvin), RGB color (HSBK) and Infrared
 * (Nightvision models). Multizone devices are exposed as a single light (zones = v2).
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { BasePlatformConfig, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformMatterbridge, colorTemperatureLight, dimmableLight, extendedColorLight, onOffLight } from 'matterbridge';
import { createRequire } from 'node:module';

import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { ColorControl } from 'matterbridge/matter/clusters';

// lifx-lan-client is a CommonJS package: load it via createRequire from this ES module.
const require = createRequire(import.meta.url);
const { Client } = require('lifx-lan-client') as { Client: new () => LifxClient };

/** lifx-lan-client Client surface used by this plugin. */
interface LifxClient {
  init(opts?: object, cb?: () => void): void;
  destroy(): void;
  on(ev: string, cb: (light: LifxLight) => void): void;
}

/** Plugin configuration. */
export type LifxPlatformConfig = BasePlatformConfig & {
  whiteList: string[];
  blackList: string[];
  /** Optional list of LIFX IP addresses to target directly (skips broadcast-only discovery). */
  lights?: string[];
  /** Broadcast address for discovery. */
  broadcast?: string;
  /** Polling interval in seconds to refresh device state. */
  pollInterval?: number;
};

/** Minimal HSBK color as reported by lifx-lan-client (hue 0-360, sat/bri 0-100, kelvin). */
interface LifxColor {
  hue: number;
  saturation: number;
  brightness: number;
  kelvin: number;
}

/** Light features as reported by lifx-lan-client product database. */
interface LifxFeatures {
  color?: boolean;
  infrared?: boolean;
  multizone?: boolean;
  temperature_range?: [number, number];
}

/** A discovered LIFX light handle (lifx-lan-client). */
interface LifxLight {
  id: string;
  address: string;
  label: string | null;
  on(duration?: number, cb?: (e: Error | null) => void): void;
  off(duration?: number, cb?: (e: Error | null) => void): void;
  color(hue: number, saturation: number, brightness: number, kelvin?: number, duration?: number, cb?: (e: Error | null) => void): void;
  maxIR(brightness: number, cb?: (e: Error | null) => void): void;
  getState(cb: (e: Error | null, s: { color: LifxColor; power: number; label: string } | null) => void): void;
  getMaxIR(cb: (e: Error | null, b: number | null) => void): void;
  getHardwareVersion(cb: (e: Error | null, v: { productName?: string; vendorName?: string; productFeatures?: LifxFeatures } | null) => void): void;
}

/** Per-device runtime context. */
interface DeviceContext {
  light: LifxLight;
  features: LifxFeatures;
  device: MatterbridgeEndpoint;
  irDevice?: MatterbridgeEndpoint;
}

const LIFX_VENDOR_ID = 0x131c; // not a real Matter vendor id; cosmetic only.

/**
 * Initialize the plugin.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The logger.
 * @param {LifxPlatformConfig} config - The platform configuration.
 * @returns {LifxPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: LifxPlatformConfig): LifxPlatform {
  return new LifxPlatform(matterbridge, log, config);
}

/** LIFX dynamic platform. */
export class LifxPlatform extends MatterbridgeDynamicPlatform {
  private client: LifxClient | undefined;
  private readonly contexts = new Map<string, DeviceContext>();
  private pollTimer?: NodeJS.Timeout;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: LifxPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`);
    }

    this.log.info('Initializing LIFX platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const config = this.config as LifxPlatformConfig;
    const client = new Client();
    this.client = client;

    client.on('light-new', (light: LifxLight) => {
      void this.onLightNew(light);
    });
    client.on('light-online', (light: LifxLight) => {
      this.log.debug(`LIFX light online: ${light.id}`);
    });
    client.on('light-offline', (light: LifxLight) => {
      this.log.warn(`LIFX light offline: ${light.id}`);
    });

    await new Promise<void>((resolve) => {
      client.init({ broadcast: config.broadcast ?? '255.255.255.255', lights: config.lights ?? [] }, () => {
        this.log.info('LIFX discovery started (UDP 56700).');
        resolve();
      });
    });
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    const seconds = (this.config as LifxPlatformConfig).pollInterval ?? 30;
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, Math.max(5, seconds) * 1000);

    await this.pollAll();
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
    try {
      this.client?.destroy();
    } catch {
      /* ignore */
    }
    this.contexts.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Handle a newly discovered LIFX light: read its features and register a Matter device.
   *
   * @param {LifxLight} light - The discovered light.
   * @returns {Promise<void>} Resolves when registration completes.
   */
  private async onLightNew(light: LifxLight): Promise<void> {
    if (this.contexts.has(light.id)) return;

    const info = await new Promise<{ productName?: string; productFeatures?: LifxFeatures } | null>((resolve) => {
      light.getHardwareVersion((err, v) => resolve(err ? null : v));
    });
    const label = await new Promise<string>((resolve) => {
      light.getState((err, s) => resolve(!err && s ? s.label : (light.label ?? light.id)));
    });

    const features: LifxFeatures = info?.productFeatures ?? { color: true, temperature_range: [2500, 9000] };
    const name = label || info?.productName || `LIFX ${light.id}`;
    const serial = light.id;

    this.setSelectDevice(serial, name, light.address);
    if (!this.validateDevice([name, serial])) {
      this.log.info(`Skipping LIFX device ${name} (${serial}) due to white/black list.`);
      return;
    }

    const [minK, maxK] = features.temperature_range ?? [2500, 9000];
    const minMireds = Math.round(1_000_000 / maxK);
    const maxMireds = Math.round(1_000_000 / minK);

    let deviceType = onOffLight;
    if (features.color) deviceType = extendedColorLight;
    else if (features.temperature_range) deviceType = colorTemperatureLight;
    else deviceType = dimmableLight;

    const device = new MatterbridgeEndpoint(deviceType, { id: `lifx-${serial}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, LIFX_VENDOR_ID, 'LIFX', info?.productName ?? 'LIFX Light', 1, '1.0.0')
      .createDefaultIdentifyClusterServer()
      .createDefaultOnOffClusterServer();

    if (deviceType !== onOffLight) device.createDefaultLevelControlClusterServer(254);
    if (features.color) device.createDefaultColorControlClusterServer(0, 0, 0, 0, maxMireds, minMireds, maxMireds);
    else if (features.temperature_range) device.createCtColorControlClusterServer(maxMireds, minMireds, maxMireds);

    device.addRequiredClusterServers();

    this.addOnOffHandlers(device, light);
    if (deviceType !== onOffLight) this.addLevelHandlers(device, light);
    if (features.color || features.temperature_range) this.addColorHandlers(device, light, features);

    await this.registerDevice(device);

    const ctx: DeviceContext = { light, features, device };

    // Infrared (Nightvision) models: expose IR brightness as a separate dimmable light.
    if (features.infrared) {
      const ir = new MatterbridgeEndpoint(dimmableLight, { id: `lifx-${serial}-ir` })
        .createDefaultBridgedDeviceBasicInformationClusterServer(`${name} IR`, `${serial}-ir`, LIFX_VENDOR_ID, 'LIFX', 'LIFX Infrared', 1, '1.0.0')
        .createDefaultIdentifyClusterServer()
        .createDefaultOnOffClusterServer()
        .createDefaultLevelControlClusterServer(0)
        .addRequiredClusterServers();
      this.addIrHandlers(ir, light);
      await this.registerDevice(ir);
      ctx.irDevice = ir;
    }

    this.contexts.set(light.id, ctx);
    await this.refresh(ctx);
    this.log.info(`Registered LIFX device ${name} (${serial}) type=${features.color ? 'color' : features.temperature_range ? 'ct' : 'dimmable'}.`);
  }

  /**
   * Register On/Off command handlers.
   *
   * @param {MatterbridgeEndpoint} device - The endpoint.
   * @param {LifxLight} light - The LIFX light.
   */
  private addOnOffHandlers(device: MatterbridgeEndpoint, light: LifxLight): void {
    device.addCommandHandler('on', () => light.on(0));
    device.addCommandHandler('off', () => light.off(0));
    device.addCommandHandler('toggle', async () => {
      const on = await device.getAttribute('OnOff', 'onOff');
      if (on) light.off(0);
      else light.on(0);
    });
  }

  /**
   * Register LevelControl (brightness) handlers.
   *
   * @param {MatterbridgeEndpoint} device - The endpoint.
   * @param {LifxLight} light - The LIFX light.
   */
  private addLevelHandlers(device: MatterbridgeEndpoint, light: LifxLight): void {
    const apply = async (level: number): Promise<void> => {
      await device.setAttribute('LevelControl', 'currentLevel', level);
      await this.applyColor(device, light);
    };
    device.addCommandHandler('moveToLevel', ({ request }) => void apply(request.level));
    device.addCommandHandler('moveToLevelWithOnOff', ({ request }) => void apply(request.level));
  }

  /**
   * Register ColorControl handlers (hue/sat and color temperature).
   *
   * @param {MatterbridgeEndpoint} device - The endpoint.
   * @param {LifxLight} light - The LIFX light.
   * @param {LifxFeatures} features - The light features.
   */
  private addColorHandlers(device: MatterbridgeEndpoint, light: LifxLight, features: LifxFeatures): void {
    if (features.color) {
      device.addCommandHandler('moveToHue', async ({ request }) => {
        await device.setAttribute('ColorControl', 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
        await device.setAttribute('ColorControl', 'currentHue', request.hue);
        await this.applyColor(device, light);
      });
      device.addCommandHandler('moveToSaturation', async ({ request }) => {
        await device.setAttribute('ColorControl', 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
        await device.setAttribute('ColorControl', 'currentSaturation', request.saturation);
        await this.applyColor(device, light);
      });
      device.addCommandHandler('moveToHueAndSaturation', async ({ request }) => {
        await device.setAttribute('ColorControl', 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation);
        await device.setAttribute('ColorControl', 'currentHue', request.hue);
        await device.setAttribute('ColorControl', 'currentSaturation', request.saturation);
        await this.applyColor(device, light);
      });
    }
    device.addCommandHandler('moveToColorTemperature', async ({ request }) => {
      await device.setAttribute('ColorControl', 'colorMode', ColorControl.ColorMode.ColorTemperatureMireds);
      await device.setAttribute('ColorControl', 'colorTemperatureMireds', request.colorTemperatureMireds);
      await this.applyColor(device, light);
    });
  }

  /**
   * Register handlers for the infrared (Nightvision) child endpoint.
   *
   * @param {MatterbridgeEndpoint} ir - The IR endpoint.
   * @param {LifxLight} light - The LIFX light.
   */
  private addIrHandlers(ir: MatterbridgeEndpoint, light: LifxLight): void {
    const setIr = async (): Promise<void> => {
      const on = await ir.getAttribute('OnOff', 'onOff');
      const level = (await ir.getAttribute('LevelControl', 'currentLevel')) ?? 0;
      light.maxIR(on ? Math.round((level / 254) * 100) : 0);
    };
    ir.addCommandHandler('on', () => void setIr());
    ir.addCommandHandler('off', () => light.maxIR(0));
    ir.addCommandHandler('moveToLevel', ({ request }) => void ir.setAttribute('LevelControl', 'currentLevel', request.level).then(setIr));
    ir.addCommandHandler('moveToLevelWithOnOff', ({ request }) => void ir.setAttribute('LevelControl', 'currentLevel', request.level).then(setIr));
  }

  /**
   * Compute the full HSBK from current Matter attributes and push it to the LIFX light.
   *
   * @param {MatterbridgeEndpoint} device - The endpoint.
   * @param {LifxLight} light - The LIFX light.
   * @returns {Promise<void>} Resolves when sent.
   */
  private async applyColor(device: MatterbridgeEndpoint, light: LifxLight): Promise<void> {
    const level = ((await device.getAttribute('LevelControl', 'currentLevel')) as number | undefined) ?? 254;
    const brightness = Math.round((Math.max(1, level) / 254) * 100);
    const mode = (await device.getAttribute('ColorControl', 'colorMode')) as number | undefined;

    if (mode === ColorControl.ColorMode.ColorTemperatureMireds) {
      const mireds = ((await device.getAttribute('ColorControl', 'colorTemperatureMireds')) as number | undefined) ?? 250;
      const kelvin = Math.min(9000, Math.max(2500, Math.round(1_000_000 / mireds)));
      light.color(0, 0, brightness, kelvin, 0);
      return;
    }

    const hue = ((await device.getAttribute('ColorControl', 'currentHue')) as number | undefined) ?? 0;
    const sat = ((await device.getAttribute('ColorControl', 'currentSaturation')) as number | undefined) ?? 0;
    light.color(Math.round((hue / 254) * 360), Math.round((sat / 254) * 100), brightness, 3500, 0);
  }

  /** Poll all known devices. */
  private async pollAll(): Promise<void> {
    for (const ctx of this.contexts.values()) {
      await this.refresh(ctx);
    }
  }

  /**
   * Refresh Matter attributes from the LIFX light state.
   *
   * @param {DeviceContext} ctx - The device context.
   * @returns {Promise<void>} Resolves when updated.
   */
  private async refresh(ctx: DeviceContext): Promise<void> {
    const state = await new Promise<{ color: LifxColor; power: number } | null>((resolve) => {
      ctx.light.getState((err, s) => resolve(err ? null : s));
    });
    if (!state) return;

    const { device, features } = ctx;
    await device.updateAttribute('OnOff', 'onOff', state.power === 1, this.log);

    if (features.color || features.temperature_range) {
      await device.updateAttribute('LevelControl', 'currentLevel', Math.max(1, Math.round((state.color.brightness / 100) * 254)), this.log);
    }

    if (state.color.saturation > 0 && features.color) {
      await device.updateAttribute('ColorControl', 'colorMode', ColorControl.ColorMode.CurrentHueAndCurrentSaturation, this.log);
      await device.updateAttribute('ColorControl', 'currentHue', Math.round((state.color.hue / 360) * 254), this.log);
      await device.updateAttribute('ColorControl', 'currentSaturation', Math.round((state.color.saturation / 100) * 254), this.log);
    } else if (features.color || features.temperature_range) {
      await device.updateAttribute('ColorControl', 'colorMode', ColorControl.ColorMode.ColorTemperatureMireds, this.log);
      await device.updateAttribute('ColorControl', 'colorTemperatureMireds', Math.round(1_000_000 / Math.min(9000, Math.max(2500, state.color.kelvin))), this.log);
    }

    if (ctx.irDevice) {
      await new Promise<void>((resolve) => {
        ctx.light.getMaxIR(async (err, b) => {
          if (!err && b != null) {
            await ctx.irDevice?.updateAttribute('OnOff', 'onOff', b > 0, this.log);
            await ctx.irDevice?.updateAttribute('LevelControl', 'currentLevel', Math.round((b / 100) * 254), this.log);
          }
          resolve();
        });
      });
    }
  }
}
