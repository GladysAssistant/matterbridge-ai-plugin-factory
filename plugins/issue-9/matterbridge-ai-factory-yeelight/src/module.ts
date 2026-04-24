/**
 * Matterbridge Yeelight plugin entry point.
 *
 * Exposes Yeelight LAN-controlled lights as Matter devices with on/off,
 * brightness, color temperature and color (hue/saturation) controls.
 */

import {
  colorTemperatureLight,
  dimmableLight,
  extendedColorLight,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  onOffLight,
  type PlatformConfig,
  type PlatformMatterbridge,
} from 'matterbridge';
import { AnsiLogger, type LogLevel } from 'matterbridge/logger';

import { YeelightClient, type YeelightState } from './yeelight.js';

/** Configuration for a single Yeelight device. */
interface YeelightConfigEntry {
  name: string;
  host: string;
  port?: number;
  model?: 'color' | 'ct' | 'mono';
}

/**
 * Plugin initialization hook called by Matterbridge.
 *
 * @param matterbridge The running Matterbridge instance.
 * @param log Plugin-scoped logger.
 * @param config Plugin configuration.
 * @returns The plugin platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): YeelightPlatform {
  return new YeelightPlatform(matterbridge, log, config);
}

/** Matterbridge dynamic platform for Yeelight devices. */
export class YeelightPlatform extends MatterbridgeDynamicPlatform {
  private readonly clients = new Map<string, YeelightClient>();
  private readonly endpoints = new Map<string, MatterbridgeEndpoint>();

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.4.0". Current version: ${this.matterbridge.matterbridgeVersion}.`);
    }

    this.log.info('Initializing Yeelight platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const lights = Array.isArray(this.config.lights) ? (this.config.lights as YeelightConfigEntry[]) : [];
    if (lights.length === 0) {
      this.log.warn('No Yeelight devices configured. Add entries under "lights" in the plugin config.');
      return;
    }

    for (const entry of lights) {
      if (!entry?.host || !entry?.name) {
        this.log.warn(`Skipping invalid Yeelight entry: ${JSON.stringify(entry)}`);
        continue;
      }
      await this.addLight(entry);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    for (const [serial, client] of this.clients) {
      this.log.info(`Connecting to Yeelight ${serial} at ${client.host}:${client.port}`);
      client.connect();
    }
  }

  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.endpoints.clear();
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private async addLight(entry: YeelightConfigEntry): Promise<void> {
    const serial = `yeelight-${entry.host.replace(/[^a-z0-9]/gi, '-')}`;
    const model = entry.model ?? 'color';
    const deviceType = model === 'color' ? extendedColorLight : model === 'ct' ? colorTemperatureLight : model === 'mono' ? dimmableLight : onOffLight;

    const endpoint = new MatterbridgeEndpoint(deviceType, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(entry.name, serial, this.matterbridge.aggregatorVendorId, 'Yeelight', `Yeelight ${model}`, 1, '1.0.0')
      .addRequiredClusterServers();

    this.setSelectDevice(serial, entry.name);
    const selected = this.validateDevice([entry.name, serial]);
    if (!selected) return;

    const client = new YeelightClient(entry.host, entry.port ?? 55443);
    this.clients.set(serial, client);
    this.endpoints.set(serial, endpoint);

    this.wireCommands(endpoint, client, model);
    this.wireStateUpdates(endpoint, client, model);

    client.on('error', (err) => this.log.debug(`Yeelight ${serial} error: ${err.message}`));
    client.on('connect', () => this.log.info(`Yeelight ${serial} connected`));
    client.on('disconnect', () => this.log.info(`Yeelight ${serial} disconnected`));

    await this.registerDevice(endpoint);
  }

  private wireCommands(endpoint: MatterbridgeEndpoint, client: YeelightClient, model: 'color' | 'ct' | 'mono'): void {
    endpoint.addCommandHandler('on', async () => {
      await client.setPower(true).catch((e: Error) => this.log.warn(`on failed: ${e.message}`));
    });
    endpoint.addCommandHandler('off', async () => {
      await client.setPower(false).catch((e: Error) => this.log.warn(`off failed: ${e.message}`));
    });
    endpoint.addCommandHandler('toggle', async () => {
      await client.send('toggle', []).catch((e: Error) => this.log.warn(`toggle failed: ${e.message}`));
    });

    if (model === 'mono' || model === 'ct' || model === 'color') {
      endpoint.addCommandHandler('moveToLevel', async ({ request }) => {
        const level = Number((request as { level?: number }).level ?? 0);
        const pct = Math.max(1, Math.round((level / 254) * 100));
        await client.setBrightness(pct).catch((e: Error) => this.log.warn(`moveToLevel failed: ${e.message}`));
      });
      endpoint.addCommandHandler('moveToLevelWithOnOff', async ({ request }) => {
        const level = Number((request as { level?: number }).level ?? 0);
        if (level <= 0) {
          await client.setPower(false).catch(() => {});
        } else {
          const pct = Math.max(1, Math.round((level / 254) * 100));
          await client.setPower(true).catch(() => {});
          await client.setBrightness(pct).catch((e: Error) => this.log.warn(`moveToLevelWithOnOff failed: ${e.message}`));
        }
      });
    }

    if (model === 'ct' || model === 'color') {
      endpoint.addCommandHandler('moveToColorTemperature', async ({ request }) => {
        const mireds = Number((request as { colorTemperatureMireds?: number }).colorTemperatureMireds ?? 250);
        const kelvin = Math.round(1_000_000 / Math.max(1, mireds));
        await client.setColorTemperature(kelvin).catch((e: Error) => this.log.warn(`moveToColorTemperature failed: ${e.message}`));
      });
    }

    if (model === 'color') {
      let lastHue = 0;
      let lastSat = 0;

      const pushHsv = async (): Promise<void> => {
        await client.setHsv(Math.round((lastHue / 254) * 359), Math.round((lastSat / 254) * 100)).catch((e: Error) => this.log.warn(`setHsv failed: ${e.message}`));
      };

      endpoint.addCommandHandler('moveToHue', async ({ request }) => {
        lastHue = Number((request as { hue?: number }).hue ?? 0);
        await pushHsv();
      });
      endpoint.addCommandHandler('moveToSaturation', async ({ request }) => {
        lastSat = Number((request as { saturation?: number }).saturation ?? 0);
        await pushHsv();
      });
      endpoint.addCommandHandler('moveToHueAndSaturation', async ({ request }) => {
        lastHue = Number((request as { hue?: number }).hue ?? 0);
        lastSat = Number((request as { saturation?: number }).saturation ?? 0);
        await pushHsv();
      });
      endpoint.addCommandHandler('moveToColor', async ({ request }) => {
        // xy color space -> approximate via kelvin fallback: ignore, Yeelight prefers HSV
        const x = Number((request as { colorX?: number }).colorX ?? 0);
        const y = Number((request as { colorY?: number }).colorY ?? 0);
        this.log.debug(`moveToColor x=${x} y=${y} ignored (using HSV path)`);
      });
    }
  }

  private wireStateUpdates(endpoint: MatterbridgeEndpoint, client: YeelightClient, model: 'color' | 'ct' | 'mono'): void {
    client.on('update', (state: Partial<YeelightState>) => {
      if (state.power !== undefined) {
        void endpoint.updateAttribute('OnOff', 'onOff', state.power);
      }
      if (state.bright !== undefined && (model === 'mono' || model === 'ct' || model === 'color')) {
        const level = Math.max(1, Math.min(254, Math.round((state.bright / 100) * 254)));
        void endpoint.updateAttribute('LevelControl', 'currentLevel', level);
      }
      if (state.ct !== undefined && (model === 'ct' || model === 'color')) {
        const mireds = Math.max(1, Math.round(1_000_000 / state.ct));
        void endpoint.updateAttribute('ColorControl', 'colorTemperatureMireds', mireds);
      }
      if (model === 'color') {
        if (state.hue !== undefined) {
          void endpoint.updateAttribute('ColorControl', 'currentHue', Math.round((state.hue / 359) * 254));
        }
        if (state.sat !== undefined) {
          void endpoint.updateAttribute('ColorControl', 'currentSaturation', Math.round((state.sat / 100) * 254));
        }
      }
    });
  }
}
