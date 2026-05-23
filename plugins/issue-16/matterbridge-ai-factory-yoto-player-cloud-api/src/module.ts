/**
 * Matterbridge plugin: Yoto Player (Cloud API).
 *
 * Bridges Yoto Players over Matter using the Yoto cloud API. Handles OAuth2
 * device-flow authorization, persists tokens, prefers real-time MQTT updates
 * with a polling fallback, and exposes each player as a small set of bridged
 * Matter accessories (player, nightlight, sensors, day-mode switch).
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { MatterbridgeDynamicPlatform, PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { YotoApi, YotoDeviceInfo, YotoDeviceStatus, YotoTokens } from './yotoApi.js';
import { YotoMqtt } from './yotoMqtt.js';
import { YotoPlayer } from './yotoPlayer.js';

/**
 * Matterbridge plugin entry point.
 *
 * @param matterbridge - The hosting Matterbridge instance.
 * @param log - Logger instance.
 * @param config - Persistent plugin configuration.
 * @returns The constructed dynamic platform.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): YotoPlatform {
  return new YotoPlatform(matterbridge, log, config);
}

export class YotoPlatform extends MatterbridgeDynamicPlatform {
  private api!: YotoApi;
  private mqtt?: YotoMqtt;
  private players: Map<string, YotoPlayer> = new Map();
  private pollTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private authInFlight = false;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }

    this.log.info('Initializing Yoto Player (Cloud API) platform…');

    const clientId = typeof config.clientId === 'string' && config.clientId.length > 0 ? config.clientId : 'matterbridge-yoto';
    const tokens: YotoTokens | null =
      typeof config.accessToken === 'string' && (config.accessToken as string).length > 0
        ? {
            accessToken: config.accessToken as string,
            refreshToken: (config.refreshToken as string) ?? '',
            expiresAt: (config.tokenExpiresAt as number) ?? 0,
          }
        : null;

    this.api = new YotoApi(this.log, clientId, tokens, {
      saveTokens: (t: YotoTokens) => this.persistTokens(t),
    });
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    if (!this.api.hasTokens()) {
      // Run device-flow authorization in the background — onStart must not block forever.
      this.runDeviceAuth().catch((err) => this.log.error(`Device authorization failed: ${(err as Error).message}`));
      this.log.warn('No Yoto tokens stored — authorize the plugin (see logs above) then restart it.');
      return;
    }

    await this.discoverAndRegisterDevices();
    await this.refreshAllStatus();
    await this.startRealtimeUpdates();
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    // Re-apply the latest snapshot so persisted attributes match real state after restart.
    await this.refreshAllStatus();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.pollTimer = undefined;
    this.refreshTimer = undefined;
    await this.mqtt?.disconnect();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  // --- OAuth device flow ---

  private async runDeviceAuth(): Promise<void> {
    if (this.authInFlight) return;
    this.authInFlight = true;
    try {
      const dc = await this.api.requestDeviceCode();
      const verifyUrl = dc.verification_uri_complete ?? `${dc.verification_uri}?code=${dc.user_code}`;
      this.log.notice('============================================================');
      this.log.notice('Yoto authorization required');
      this.log.notice(`  1. Visit: ${verifyUrl}`);
      this.log.notice(`  2. Enter code: ${dc.user_code}`);
      this.log.notice(`  Code expires in ${dc.expires_in}s`);
      this.log.notice('============================================================');
      const tokens = await this.api.pollForToken(dc.device_code, dc.interval, dc.expires_in);
      this.log.notice('Yoto authorization successful — tokens persisted.');
      await this.persistTokens(tokens);
      await this.discoverAndRegisterDevices();
      await this.refreshAllStatus();
      await this.startRealtimeUpdates();
    } finally {
      this.authInFlight = false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async persistTokens(tokens: YotoTokens): Promise<void> {
    this.config.accessToken = tokens.accessToken;
    this.config.refreshToken = tokens.refreshToken;
    this.config.tokenExpiresAt = tokens.expiresAt;
    try {
      this.saveConfig(this.config);
    } catch (err) {
      this.log.debug(`Could not persist tokens via saveConfig: ${(err as Error).message}`);
    }
  }

  // --- device discovery / status ---

  private async discoverAndRegisterDevices(): Promise<void> {
    let devices: YotoDeviceInfo[] = [];
    try {
      devices = await this.api.listDevices();
    } catch (err) {
      this.log.error(`Failed to list Yoto devices: ${(err as Error).message}`);
      return;
    }
    this.log.info(`Discovered ${devices.length} Yoto device(s).`);
    for (const dev of devices) {
      if (!dev.deviceId) continue;
      const name = dev.name || dev.deviceId;
      this.setSelectDevice(dev.deviceId, name);
      if (!this.validateDevice([name, dev.deviceId])) {
        this.log.debug(`Skipping ${name} (filtered by white/black list).`);
        continue;
      }
      if (this.players.has(dev.deviceId)) continue;
      const player = new YotoPlayer(this.log, this, this.api, dev);
      try {
        await player.register();
        this.players.set(dev.deviceId, player);
      } catch (err) {
        this.log.error(`Failed to register Yoto player ${name}: ${(err as Error).message}`);
      }
    }
  }

  private async refreshAllStatus(): Promise<void> {
    for (const player of this.players.values()) {
      try {
        const status = await this.api.getStatus(player.deviceId);
        await player.applyStatus(status);
      } catch (err) {
        this.log.debug(`Status refresh failed for ${player.name}: ${(err as Error).message}`);
      }
    }
  }

  // --- real-time updates ---

  private async startRealtimeUpdates(): Promise<void> {
    const useMqtt = this.config.useMqtt !== false;
    if (useMqtt) {
      this.mqtt = new YotoMqtt(this.log, this.api);
      const ok = await this.mqtt.connect([...this.players.keys()], (deviceId, status) => this.onMqttStatus(deviceId, status));
      if (ok) {
        // Keep a slow polling heartbeat to catch missed events.
        this.pollTimer = setInterval(() => void this.refreshAllStatus(), 5 * 60 * 1000);
        return;
      }
      this.log.warn('MQTT unavailable; falling back to HTTP polling.');
    }
    const interval = Math.max(10, (this.config.pollingIntervalSeconds as number) ?? 30) * 1000;
    this.pollTimer = setInterval(() => void this.refreshAllStatus(), interval);
  }

  private onMqttStatus(deviceId: string, status: YotoDeviceStatus): void {
    const player = this.players.get(deviceId);
    if (!player) return;
    void player.applyStatus(status).catch((err) => this.log.debug(`applyStatus failed: ${(err as Error).message}`));
  }
}
