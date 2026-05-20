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
  /**
   * Per-endpoint suppression map: cluster.attribute -> { value, expiresAt }.
   * When a Matter command optimistically commits a value (e.g. OnOff=true via
   * the built-in OnOff.on handler), the Yeelight device echoes the change back
   * a few ms later as a `props` notification. Writing that echoed value via
   * `updateAttribute` while Matter's command transaction is still in pre-commit
   * trips the "State has not settled after 5 pre-commit cycles" guard and rolls
   * back the OnOff write. Suppressing the echo for a short window prevents that.
   */
  private readonly suppress = new Map<string, Map<string, { value: unknown; expiresAt: number }>>();

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
    this.suppress.clear();
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
    const serial = endpoint.originalId ?? endpoint.id ?? '';

    // Do not call endpoint.updateAttribute('OnOff', ...) here: the Matter `on`/`off`
    // commands already commit the OnOff attribute within the active transaction, and
    // re-writing it from inside the handler re-enters that transaction, triggering the
    // "State has not settled after 5 pre-commit cycles" infinite loop.
    //
    // Instead, register an echo suppression entry so the inbound Yeelight `props`
    // notification (which arrives ~100ms later and re-asserts the same value) does
    // NOT open a competing setStateOf transaction on the same attribute while
    // Matter's command transaction is still in pre-commit. That competition is the
    // root cause of the rollback that snaps the UI back to OFF.
    //
    // Throw on transport failure so Matter rolls back the OnOff state and the UI
    // reflects the real device state instead of silently confirming an "ON" that
    // never reached the bulb.
    endpoint.addCommandHandler('on', async () => {
      this.suppressEcho(serial, 'OnOff', 'onOff', true);
      try {
        await client.setPower(true);
      } catch (e) {
        this.clearEcho(serial, 'OnOff', 'onOff');
        const msg = (e as Error).message;
        this.log.warn(`on failed: ${msg}`);
        throw e;
      }
    });
    endpoint.addCommandHandler('off', async () => {
      this.suppressEcho(serial, 'OnOff', 'onOff', false);
      try {
        await client.setPower(false);
      } catch (e) {
        this.clearEcho(serial, 'OnOff', 'onOff');
        const msg = (e as Error).message;
        this.log.warn(`off failed: ${msg}`);
        throw e;
      }
    });
    endpoint.addCommandHandler('toggle', async () => {
      try {
        await client.send('toggle', []);
      } catch (e) {
        const msg = (e as Error).message;
        this.log.warn(`toggle failed: ${msg}`);
        throw e;
      }
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
    // Yeelight emits several separate `props` notifications per change (and a
    // get_prop snapshot on connect). Each `update` event used to spawn its own
    // detached async task, so multiple updateAttribute() -> setStateOf
    // transactions ran concurrently on the SAME endpoint. Matter.js queues them
    // ("Tx waiting on ...") and the contention trips the unsettled-state guard
    // ("State has not settled after 5 pre-commit cycles"), which rolls back the
    // OnOff write and snaps the UI back to OFF, dropping the ON confirmation.
    //
    // Serialize every update through a single promise chain so only one
    // setStateOf transaction is ever in flight, and skip redundant writes so an
    // unchanged value never opens a transaction at all. Also yield to the event
    // loop before opening a transaction so any in-flight Matter command Tx on
    // the same endpoint can settle first.
    const serial = endpoint.originalId ?? endpoint.id ?? '';
    let queue: Promise<void> = Promise.resolve();

    const writeIfChanged = async (cluster: string, attribute: string, value: number | boolean): Promise<void> => {
      if (this.consumeEcho(serial, cluster, attribute, value)) return;
      const current = endpoint.getAttribute(cluster, attribute);
      if (current === value) return;
      await endpoint.updateAttribute(cluster, attribute, value);
    };

    client.on('update', (state: Partial<YeelightState>) => {
      queue = queue
        .then(async () => {
          // Yield so any in-flight Matter command transaction on this endpoint
          // (e.g. the OnOff.on Tx that just kicked off the bulb command) gets a
          // chance to commit before we open a new setStateOf transaction here.
          await new Promise<void>((r) => setTimeout(r, 50));
          if (state.power !== undefined) {
            await writeIfChanged('OnOff', 'onOff', state.power);
          }
          if (state.bright !== undefined && (model === 'mono' || model === 'ct' || model === 'color')) {
            const level = Math.max(1, Math.min(254, Math.round((state.bright / 100) * 254)));
            await writeIfChanged('LevelControl', 'currentLevel', level);
          }
          if (state.ct !== undefined && (model === 'ct' || model === 'color')) {
            const mireds = Math.max(1, Math.round(1_000_000 / state.ct));
            await writeIfChanged('ColorControl', 'colorTemperatureMireds', mireds);
          }
          if (model === 'color') {
            if (state.hue !== undefined) {
              await writeIfChanged('ColorControl', 'currentHue', Math.round((state.hue / 359) * 254));
            }
            if (state.sat !== undefined) {
              await writeIfChanged('ColorControl', 'currentSaturation', Math.round((state.sat / 100) * 254));
            }
          }
        })
        .catch((e: unknown) => {
          this.log.warn(`State update failed: ${(e as Error).message}`);
        });
    });
  }

  /**
   * Register an expected echo from the Yeelight device so the inbound `props`
   * notification does not re-write the same attribute that Matter has just
   * committed in its own transaction. The window must outlive the round-trip
   * to the bulb but stay short enough that a real external change (e.g. via
   * the Yeelight app) is still propagated.
   *
   * @param serial Endpoint storage key.
   * @param cluster Cluster name (e.g. "OnOff").
   * @param attribute Attribute name (e.g. "onOff").
   * @param value Value the echo is expected to carry.
   */
  private suppressEcho(serial: string, cluster: string, attribute: string, value: unknown): void {
    let perEndpoint = this.suppress.get(serial);
    if (!perEndpoint) {
      perEndpoint = new Map();
      this.suppress.set(serial, perEndpoint);
    }
    perEndpoint.set(`${cluster}.${attribute}`, { value, expiresAt: Date.now() + 1500 });
  }

  /**
   * Drop a previously-registered echo suppression (used when the matter command
   * failed before it reached the bulb so the next prop notification really does
   * carry the authoritative state).
   *
   * @param serial Endpoint storage key.
   * @param cluster Cluster name.
   * @param attribute Attribute name.
   */
  private clearEcho(serial: string, cluster: string, attribute: string): void {
    this.suppress.get(serial)?.delete(`${cluster}.${attribute}`);
  }

  /**
   * Check whether an inbound props value matches a pending suppression entry
   * (and remove it if so). Expired entries are pruned lazily.
   *
   * @param serial Endpoint storage key.
   * @param cluster Cluster name.
   * @param attribute Attribute name.
   * @param value Value carried by the inbound props notification.
   * @returns true when the caller should skip writing this value.
   */
  private consumeEcho(serial: string, cluster: string, attribute: string, value: unknown): boolean {
    const perEndpoint = this.suppress.get(serial);
    if (!perEndpoint) return false;
    const key = `${cluster}.${attribute}`;
    const entry = perEndpoint.get(key);
    if (!entry) return false;
    if (entry.expiresAt < Date.now()) {
      perEndpoint.delete(key);
      return false;
    }
    if (entry.value !== value) return false;
    perEndpoint.delete(key);
    return true;
  }
}
