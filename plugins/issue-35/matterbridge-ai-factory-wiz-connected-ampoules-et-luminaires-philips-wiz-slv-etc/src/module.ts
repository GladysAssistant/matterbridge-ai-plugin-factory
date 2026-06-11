/**
 * Matterbridge WiZ Connected plugin (Philips WiZ, SLV, etc.).
 * Local UDP control (no cloud). Exposes WiZ bulbs/plugs as Matter devices.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { BasePlatformConfig, colorTemperatureLight, dimmableLight, extendedColorLight, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, onOffOutlet, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { ColorControl, LevelControl, OnOff } from 'matterbridge/matter/clusters';

import { discover, WizDevice, WizPilotParams } from './wizClient.js';

export type WizDeviceConfig = {
  name: string;
  ip: string;
  type?: 'rgbcw' | 'cct' | 'dimmable' | 'plug';
};

export type WizPlatformConfig = BasePlatformConfig & {
  whiteList: string[];
  blackList: string[];
  devices?: WizDeviceConfig[];
  discovery?: boolean;
  pollInterval?: number; // seconds
};

// WiZ CCT range. Mireds = 1e6 / Kelvin.
const KELVIN_MIN = 2200;
const KELVIN_MAX = 6500;
const MIREDS_MIN = Math.round(1e6 / KELVIN_MAX); // ~153 (coolest)
const MIREDS_MAX = Math.round(1e6 / KELVIN_MIN); // ~454 (warmest)

/**
 * Plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger.
 * @param {WizPlatformConfig} config - Platform config.
 * @returns {WizPlatform} The platform.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: WizPlatformConfig): WizPlatform {
  return new WizPlatform(matterbridge, log, config);
}

export class WizPlatform extends MatterbridgeDynamicPlatform {
  private readonly wizByName = new Map<string, WizDevice>();
  private readonly endpointByName = new Map<string, MatterbridgeEndpoint>();
  private pollTimer?: NodeJS.Timeout;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: WizPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`);
    }

    this.log.info('Initializing WiZ Connected platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const cfg = this.config as WizPlatformConfig;
    const configured: WizDeviceConfig[] = [...(cfg.devices ?? [])];

    // Optional UDP discovery.
    if (cfg.discovery) {
      this.log.info('Discovering WiZ devices via UDP broadcast...');
      try {
        const discovered = await discover();
        for (const d of discovered) {
          if (!configured.some((c) => c.ip === d.ip)) {
            configured.push({ name: `WiZ-${d.mac.slice(-6)}`, ip: d.ip, type: 'rgbcw' });
            this.log.info(`Discovered WiZ device ${d.mac} at ${d.ip}`);
          }
        }
      } catch (error) {
        this.log.warn(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const dev of configured) {
      await this.registerWizDevice(dev);
    }
  }

  private async registerWizDevice(cfg: WizDeviceConfig): Promise<void> {
    if (!cfg.name || !cfg.ip) {
      this.log.warn(`Skipping invalid device entry: ${JSON.stringify(cfg)}`);
      return;
    }
    const type = cfg.type ?? 'rgbcw';
    const serial = `wiz-${cfg.ip.replace(/\./g, '-')}`;
    this.setSelectDevice(serial, cfg.name);
    if (!this.validateDevice([cfg.name, serial])) return;

    const wiz = new WizDevice(cfg.ip);
    let endpoint: MatterbridgeEndpoint;

    if (type === 'plug') {
      endpoint = new MatterbridgeEndpoint(onOffOutlet, { id: serial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'WiZ', 'WiZ Smart Plug', 1, '1.0.0')
        .createDefaultPowerSourceWiredClusterServer()
        .createDefaultElectricalPowerMeasurementClusterServer()
        .addRequiredClusterServers();
      this.addOnOff(endpoint, wiz);
    } else if (type === 'dimmable') {
      endpoint = new MatterbridgeEndpoint(dimmableLight, { id: serial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'WiZ', 'WiZ Dimmable Light', 1, '1.0.0')
        .createDefaultPowerSourceWiredClusterServer()
        .addRequiredClusterServers();
      this.addOnOff(endpoint, wiz);
      this.addLevel(endpoint, wiz);
    } else if (type === 'cct') {
      endpoint = new MatterbridgeEndpoint(colorTemperatureLight, { id: serial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'WiZ', 'WiZ Tunable White', 1, '1.0.0')
        .createDefaultPowerSourceWiredClusterServer()
        .createCtColorControlClusterServer(MIREDS_MIN, MIREDS_MIN, MIREDS_MAX)
        .addRequiredClusterServers();
      this.addOnOff(endpoint, wiz);
      this.addLevel(endpoint, wiz);
      this.addColorTemp(endpoint, wiz);
    } else {
      // rgbcw: full extended color light (RGB + CCT)
      endpoint = new MatterbridgeEndpoint(extendedColorLight, { id: serial })
        .createDefaultBridgedDeviceBasicInformationClusterServer(cfg.name, serial, this.matterbridge.aggregatorVendorId, 'WiZ', 'WiZ Color Light', 1, '1.0.0')
        .createDefaultPowerSourceWiredClusterServer()
        .createDefaultColorControlClusterServer(0, 0, 0, 0, MIREDS_MIN, MIREDS_MIN, MIREDS_MAX)
        .addRequiredClusterServers();
      this.addOnOff(endpoint, wiz);
      this.addLevel(endpoint, wiz);
      this.addColorTemp(endpoint, wiz);
      this.addColor(endpoint, wiz);
    }

    await this.registerDevice(endpoint);
    this.wizByName.set(cfg.name, wiz);
    this.endpointByName.set(cfg.name, endpoint);
    this.log.info(`Registered WiZ ${type} "${cfg.name}" at ${cfg.ip}`);
  }

  private async pilot(wiz: WizDevice, params: WizPilotParams): Promise<void> {
    try {
      await wiz.setPilot(params);
    } catch (error) {
      this.log.error(`setPilot ${wiz.ip} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private addOnOff(endpoint: MatterbridgeEndpoint, wiz: WizDevice): void {
    endpoint
      .addCommandHandler('on', async () => {
        await this.pilot(wiz, { state: true });
      })
      .addCommandHandler('off', async () => {
        await this.pilot(wiz, { state: false });
      });
  }

  private addLevel(endpoint: MatterbridgeEndpoint, wiz: WizDevice): void {
    const handler = async (data: { request: { level: number } }): Promise<void> => {
      // Matter level 0..254 -> WiZ dimming 10..100.
      const dimming = Math.max(10, Math.round((data.request.level / 254) * 100));
      await this.pilot(wiz, { state: true, dimming });
    };
    endpoint.addCommandHandler('moveToLevel', handler).addCommandHandler('moveToLevelWithOnOff', handler);
  }

  private addColorTemp(endpoint: MatterbridgeEndpoint, wiz: WizDevice): void {
    endpoint.addCommandHandler('moveToColorTemperature', async (data: { request: { colorTemperatureMireds: number } }) => {
      const mireds = Math.min(MIREDS_MAX, Math.max(MIREDS_MIN, data.request.colorTemperatureMireds));
      const kelvin = Math.round(1e6 / mireds);
      await this.pilot(wiz, { state: true, temp: kelvin });
    });
  }

  private addColor(endpoint: MatterbridgeEndpoint, wiz: WizDevice): void {
    const apply = async (): Promise<void> => {
      const hue = endpoint.getAttribute(ColorControl.Cluster.id, 'currentHue') ?? 0;
      const sat = endpoint.getAttribute(ColorControl.Cluster.id, 'currentSaturation') ?? 0;
      const { r, g, b } = hsToRgb((hue / 254) * 360, sat / 254);
      await this.pilot(wiz, { state: true, r, g, b });
    };
    endpoint
      .addCommandHandler('moveToHue', apply)
      .addCommandHandler('moveToSaturation', apply)
      .addCommandHandler('moveToHueAndSaturation', apply);
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    await this.refreshAll();

    const cfg = this.config as WizPlatformConfig;
    const interval = Math.max(10, cfg.pollInterval ?? 60) * 1000;
    this.pollTimer = setInterval(() => {
      void this.refreshAll();
    }, interval);
  }

  private async refreshAll(): Promise<void> {
    for (const [name, wiz] of this.wizByName) {
      const endpoint = this.endpointByName.get(name);
      if (!endpoint) continue;
      try {
        const state = await wiz.getPilot();
        if (typeof state.state === 'boolean') {
          await endpoint.setAttribute(OnOff.Cluster.id, 'onOff', state.state, this.log);
        }
        if (typeof state.dimming === 'number') {
          const level = Math.round((state.dimming / 100) * 254);
          await endpoint.setAttribute(LevelControl.Cluster.id, 'currentLevel', level, this.log);
        }
        if (typeof state.temp === 'number' && endpoint.hasClusterServer(ColorControl.Cluster.id)) {
          const mireds = Math.min(MIREDS_MAX, Math.max(MIREDS_MIN, Math.round(1e6 / state.temp)));
          await endpoint.setAttribute(ColorControl.Cluster.id, 'colorTemperatureMireds', mireds, this.log);
        }
        // Smart plug power sensor (mW -> mW attribute), if present.
        if (typeof state.power === 'number' && endpoint.hasClusterServer('ElectricalPowerMeasurement')) {
          await endpoint.setAttribute('ElectricalPowerMeasurement', 'activePower', Math.round(state.power), this.log);
        }
      } catch (error) {
        this.log.debug(`Poll ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
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
    this.wizByName.clear();
    this.endpointByName.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }
}

/**
 * Convert HSV (with full value) to 0..255 RGB.
 *
 * @param {number} h - Hue in degrees 0..360.
 * @param {number} s - Saturation 0..1.
 * @returns {{ r: number; g: number; b: number }} RGB triplet.
 */
export function hsToRgb(h: number, s: number): { r: number; g: number; b: number } {
  const c = s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = 1 - c;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}
