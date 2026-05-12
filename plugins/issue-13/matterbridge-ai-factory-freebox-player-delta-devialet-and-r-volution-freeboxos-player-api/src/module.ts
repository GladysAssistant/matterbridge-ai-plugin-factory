/**
 * Matterbridge plugin: Freebox Player Delta (Devialet) and Revolution via FreeboxOS Player API.
 *
 * Exposes each detected Freebox Player as a Matter basicVideoPlayer endpoint with:
 *  - OnOff (power state, detected via AirPlay TCP probe)
 *  - LevelControl (volume 0-100)
 *  - MediaPlayback (play/pause/stop/next/previous)
 *  - KeypadInput (sendKey: up/down/left/right/ok/back/home/...)
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { basicVideoPlayer, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, type PlatformConfig, type PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { FreeboxClient, type FreeboxPlayer, tcpProbe } from './freebox.js';

/**
 * Standard Matterbridge plugin entrypoint.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Plugin logger.
 * @param {PlatformConfig} config - Persistent plugin configuration.
 * @returns {FreeboxPlayerPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): FreeboxPlayerPlatform {
  return new FreeboxPlayerPlatform(matterbridge, log, config);
}

interface ManualPlayerEntry {
  id: number;
  name?: string;
  host?: string;
}

interface PlayerRuntime {
  player: FreeboxPlayer;
  endpoint: MatterbridgeEndpoint;
  serial: string;
  name: string;
  host: string;
  playerApiVersion: string;
  lastPower: boolean;
  lastVolume: number;
  lastMute: boolean;
}

const CEC_KEY_TO_FBX: Record<number, string> = {
  0: 'ok', // Select
  1: 'up',
  2: 'down',
  3: 'left',
  4: 'right',
  9: 'home', // RootMenu
  10: 'home', // SetupMenu
  11: 'home', // ContentsMenu
  13: 'back', // Exit
  48: 'red', // ChannelUp -> use channel_up? we'll map to red as fallback
  49: 'green', // ChannelDown -> map to green
  64: 'power',
  65: 'vol_inc',
  66: 'vol_dec',
  67: 'mute',
  68: 'play',
  69: 'stop',
  70: 'pause',
  72: 'bwd',
  73: 'fwd',
};

/**
 * Dynamic platform exposing one Matter video player endpoint per Freebox player.
 */
export class FreeboxPlayerPlatform extends MatterbridgeDynamicPlatform {
  private client?: FreeboxClient;
  private players: PlayerRuntime[] = [];
  private pollTimer?: NodeJS.Timeout;
  private authTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
   * @param {AnsiLogger} log - Plugin logger.
   * @param {PlatformConfig} config - Plugin configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(`This plugin requires Matterbridge >= 3.4.0 (current: ${this.matterbridge.matterbridgeVersion}).`);
    }

    this.log.info('Initializing Freebox Player platform...');

    // Apply config defaults non-destructively.
    if (!this.config.host) this.config.host = 'mafreebox.freebox.fr';
    if (!this.config.appId) this.config.appId = 'com.matterbridge.freebox';
    if (!this.config.appName) this.config.appName = 'Matterbridge Freebox';
    if (!this.config.appVersion) this.config.appVersion = '1.0.0';
    if (!this.config.deviceName) this.config.deviceName = 'Matterbridge';
    if (typeof this.config.airplayPort !== 'number') this.config.airplayPort = 7000;
    if (typeof this.config.alternativeAirplayPort !== 'number') this.config.alternativeAirplayPort = 54243;
    if (typeof this.config.pollIntervalMs !== 'number') this.config.pollIntervalMs = 15000;
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart (reason=${reason ?? 'none'})`);
    await this.ready;
    await this.clearSelect();

    this.client = new FreeboxClient(
      {
        host: String(this.config.host),
        appId: String(this.config.appId),
        appName: String(this.config.appName),
        appVersion: String(this.config.appVersion),
        deviceName: String(this.config.deviceName),
        appToken: typeof this.config.appToken === 'string' ? this.config.appToken : '',
      },
      this.log,
    );

    // Try to discover the Freebox API (best-effort).
    try {
      await this.client.discoverApiVersion();
      this.log.info(`Freebox detected: ${this.client.deviceName || 'unknown'} (api v${this.client.apiMajor})`);
    } catch (err) {
      this.log.warn(`Freebox API discovery failed (${(err as Error).message}). Plugin will keep retrying in background.`);
    }

    // Auth flow: if no app_token, request authorization and store it asynchronously.
    if (!this.client.appToken) {
      this.log.warn('No app_token in config — registering a new app. PLEASE VALIDATE on the Freebox front panel.');
      void this.registerAppFlow();
    }

    // Discover players (manual override wins; otherwise hit the API).
    const manual = this.readManualPlayers();
    let discovered: FreeboxPlayer[] = [];
    if (manual.length > 0) {
      this.log.info(`Using ${manual.length} manually-configured player(s).`);
      discovered = manual.map((m) => ({
        id: m.id,
        device_name: m.name ?? `Freebox Player ${m.id}`,
        api_version: '6',
        reachable: true,
        lan_host: m.host ? { l3connectivities: [{ addr: m.host }], primary_name: m.host } : undefined,
      }));
    } else if (this.client.appToken) {
      try {
        discovered = await this.client.listPlayers();
        this.log.info(`Discovered ${discovered.length} player(s) from Freebox API.`);
      } catch (err) {
        this.log.warn(`Player discovery failed (${(err as Error).message}). Falling back to placeholder.`);
      }
    }

    // If still nothing, expose a single placeholder so the user sees the device.
    if (discovered.length === 0) {
      discovered = [
        {
          id: 1,
          device_name: 'Freebox Player',
          api_version: '6',
          reachable: false,
        },
      ];
      this.log.info('No player discovered yet; exposing a placeholder Freebox Player device.');
    }

    for (const p of discovered) {
      await this.registerPlayer(p);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    // Seed persisted attribute values from a single poll, then start the poll loop.
    await this.pollAll().catch((err) => this.log.debug(`initial poll failed: ${(err as Error).message}`));

    const intervalMs = Math.max(3000, Number(this.config.pollIntervalMs) || 15000);
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, intervalMs);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown (reason=${reason ?? 'none'})`);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = undefined;
    }
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /** Read the optional config.players array (manual overrides). */
  private readManualPlayers(): ManualPlayerEntry[] {
    const arr = this.config.players;
    if (!Array.isArray(arr)) return [];
    const out: ManualPlayerEntry[] = [];
    for (const e of arr) {
      if (!e || typeof e !== 'object') continue;
      const id = Number((e as Record<string, unknown>).id);
      if (!Number.isFinite(id)) continue;
      out.push({
        id,
        name: typeof (e as Record<string, unknown>).name === 'string' ? ((e as Record<string, unknown>).name as string) : undefined,
        host: typeof (e as Record<string, unknown>).host === 'string' ? ((e as Record<string, unknown>).host as string) : undefined,
      });
    }
    return out;
  }

  /** Background app-registration flow. The user MUST validate on the Freebox front panel. */
  private async registerAppFlow(): Promise<void> {
    if (!this.client) return;
    try {
      const auth = await this.client.authorize();
      this.log.notice(`Freebox: authorize request sent (track ${auth.track_id}). Please ACCEPT on the front panel.`);
      const maxTries = 60;
      let tries = 0;
      const poll = (): void => {
        this.authTimer = setTimeout(() => {
          void (async (): Promise<void> => {
            if (!this.client) return;
            tries += 1;
            try {
              const tr = await this.client.pollAuthorize(auth.track_id);
              if (tr.status === 'granted') {
                this.config.appToken = this.client.appToken;
                this.saveConfig(this.config);
                this.log.notice('Freebox: app_token granted and saved to plugin config.');
                return;
              }
              if (tr.status === 'denied' || tr.status === 'timeout') {
                this.log.error(`Freebox: app registration ${tr.status}.`);
                return;
              }
              if (tries < maxTries) poll();
              else this.log.error('Freebox: app registration timed out (no response in 5 min).');
            } catch (err) {
              this.log.debug(`pollAuthorize error: ${(err as Error).message}`);
              if (tries < maxTries) poll();
            }
          })();
        }, 5000);
      };
      poll();
    } catch (err) {
      this.log.warn(`Freebox: cannot start app registration (${(err as Error).message}).`);
    }
  }

  /** Build the player host used for AirPlay TCP probe (fallback to global host). */
  private playerHost(player: FreeboxPlayer): string {
    const addr = player.lan_host?.l3connectivities?.find((c) => typeof c.addr === 'string' && c.addr.length > 0)?.addr;
    if (addr) return addr;
    if (player.lan_host?.primary_name) return player.lan_host.primary_name;
    return String(this.config.host);
  }

  /** Build a stable serial number for the player endpoint. */
  private playerSerial(player: FreeboxPlayer): string {
    return `freebox-player-${player.id}`;
  }

  /** Register one Matter video player endpoint for the given Freebox player. */
  private async registerPlayer(player: FreeboxPlayer): Promise<void> {
    const name = (player.device_name && player.device_name.length > 0 ? player.device_name : `Freebox Player ${player.id}`).slice(0, 32);
    const serial = this.playerSerial(player);
    const playerApiVersion = player.api_version ?? '6';
    const host = this.playerHost(player);

    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const endpoint = new MatterbridgeEndpoint(basicVideoPlayer, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        name,
        serial,
        this.matterbridge.aggregatorVendorId,
        'Free',
        player.device_model ?? 'Freebox Player',
        1,
        String(this.config.appVersion ?? '1.0.0'),
      )
      .addRequiredClusterServers();

    // OnOff: we cannot truly turn the Freebox on, but we accept the command and
    // emulate via the toggle remote key (which wakes/sleeps the player from standby).
    endpoint.addCommandHandler('on', () => void this.handlePower(serial, true));
    endpoint.addCommandHandler('off', () => void this.handlePower(serial, false));
    endpoint.addCommandHandler('toggle', () => void this.handleToggle(serial));

    // LevelControl: volume.
    endpoint.addCommandHandler('moveToLevel', (data) => void this.handleVolume(serial, data));
    endpoint.addCommandHandler('moveToLevelWithOnOff', (data) => void this.handleVolume(serial, data));

    // MediaPlayback.
    endpoint.addCommandHandler('play', () => void this.handleMedia(serial, 'play'));
    endpoint.addCommandHandler('pause', () => void this.handleMedia(serial, 'pause'));
    endpoint.addCommandHandler('stop', () => void this.handleMedia(serial, 'stop'));
    endpoint.addCommandHandler('next', () => void this.handleMedia(serial, 'next'));
    endpoint.addCommandHandler('previous', () => void this.handleMedia(serial, 'prev'));

    // KeypadInput.
    endpoint.addCommandHandler('sendKey', (data) => void this.handleKey(serial, data));

    await this.registerDevice(endpoint);

    this.players.push({
      player,
      endpoint,
      serial,
      name,
      host,
      playerApiVersion,
      lastPower: false,
      lastVolume: 0,
      lastMute: false,
    });
    this.log.info(`Registered Freebox player "${name}" (id=${player.id}, host=${host}).`);
  }

  private find(serial: string): PlayerRuntime | undefined {
    return this.players.find((p) => p.serial === serial);
  }

  /** Power handler — uses CEC PowerToggle remote-key (Freebox has no direct power API). */
  private async handlePower(serial: string, on: boolean): Promise<void> {
    const rt = this.find(serial);
    if (!rt || !this.client) return;
    this.log.info(`Power ${on ? 'ON' : 'OFF'} -> ${rt.name}`);
    try {
      if (rt.lastPower !== on) {
        await this.client.remoteKey(rt.player.id, rt.playerApiVersion, 'power');
      }
    } catch (err) {
      this.log.warn(`power: ${(err as Error).message}`);
    }
  }

  private async handleToggle(serial: string): Promise<void> {
    const rt = this.find(serial);
    if (!rt || !this.client) return;
    try {
      await this.client.remoteKey(rt.player.id, rt.playerApiVersion, 'power');
    } catch (err) {
      this.log.warn(`toggle: ${(err as Error).message}`);
    }
  }

  /** Volume handler — Matter level is 0-254, Freebox volume is 0-100. */
  private async handleVolume(serial: string, data: unknown): Promise<void> {
    const rt = this.find(serial);
    if (!rt || !this.client) return;
    const req = (data as { request?: { level?: number } }).request;
    const level = Math.max(0, Math.min(254, Math.round(Number(req?.level ?? 0))));
    const volume = Math.round((level / 254) * 100);
    this.log.info(`Volume -> ${volume} (${rt.name})`);
    try {
      await this.client.setVolume(rt.player.id, rt.playerApiVersion, { volume });
      rt.lastVolume = volume;
    } catch (err) {
      this.log.warn(`setVolume: ${(err as Error).message}`);
    }
  }

  /** Media transport handler. */
  private async handleMedia(serial: string, cmd: 'play' | 'pause' | 'stop' | 'next' | 'prev'): Promise<void> {
    const rt = this.find(serial);
    if (!rt || !this.client) return;
    this.log.info(`Media ${cmd} -> ${rt.name}`);
    try {
      await this.client.mediaControl(rt.player.id, rt.playerApiVersion, cmd);
    } catch (err) {
      this.log.warn(`mediaControl ${cmd}: ${(err as Error).message}`);
    }
  }

  /** KeypadInput sendKey handler — maps CEC key codes to Freebox remote keys. */
  private async handleKey(serial: string, data: unknown): Promise<void> {
    const rt = this.find(serial);
    if (!rt || !this.client) return;
    const req = (data as { request?: { keyCode?: number } }).request;
    const code = Number(req?.keyCode ?? -1);
    const fbxKey = CEC_KEY_TO_FBX[code];
    if (!fbxKey) {
      this.log.warn(`sendKey: unsupported CEC key code ${code}`);
      return;
    }
    this.log.info(`sendKey ${code} -> '${fbxKey}' (${rt.name})`);
    try {
      await this.client.remoteKey(rt.player.id, rt.playerApiVersion, fbxKey);
    } catch (err) {
      this.log.warn(`remoteKey ${fbxKey}: ${(err as Error).message}`);
    }
  }

  /** Poll every player: probe power, fetch status, update attributes. */
  private async pollAll(): Promise<void> {
    for (const rt of this.players) {
      try {
        await this.pollOne(rt);
      } catch (err) {
        this.log.debug(`poll ${rt.name}: ${(err as Error).message}`);
      }
    }
  }

  private async pollOne(rt: PlayerRuntime): Promise<void> {
    // Power: AirPlay TCP probe (default 7000), fallback to alternative port.
    const primaryPort = Number(this.config.airplayPort) || 7000;
    const altPort = Number(this.config.alternativeAirplayPort) || 54243;
    let power = await tcpProbe(rt.host, primaryPort, 1500);
    if (!power && altPort && altPort !== primaryPort) {
      power = await tcpProbe(rt.host, altPort, 1500);
    }
    if (power !== rt.lastPower) {
      rt.lastPower = power;
      await rt.endpoint.updateAttribute('OnOff', 'onOff', power).catch(() => undefined);
      this.log.debug(`${rt.name}: power=${power ? 'on' : 'off'}`);
    }

    // Volume + media state via authenticated API (only if app_token is present).
    if (!this.client?.appToken) return;
    try {
      const status = await this.client.getPlayerStatus(rt.player.id, rt.playerApiVersion);
      const vol = Math.max(0, Math.min(100, Number(status.audio_ctrl?.volume ?? rt.lastVolume)));
      const mute = Boolean(status.audio_ctrl?.muted);
      const level = Math.round((vol / 100) * 254);
      if (vol !== rt.lastVolume) {
        rt.lastVolume = vol;
        await rt.endpoint.updateAttribute('LevelControl', 'currentLevel', level).catch(() => undefined);
      }
      if (mute !== rt.lastMute) {
        rt.lastMute = mute;
        this.log.debug(`${rt.name}: muted=${mute}`);
      }
      this.log.debug(
        `${rt.name}: app=${status.foreground_app?.package ?? '-'} channel=${status.channel?.channel_name ?? '-'} vol=${vol}${mute ? ' (muted)' : ''}`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      // 'not_implemented' is returned by some firmwares for some endpoints — log once at debug.
      if (msg.includes('not_implemented')) {
        this.log.debug(`${rt.name}: status not_implemented (firmware limitation)`);
      } else {
        this.log.debug(`${rt.name}: status: ${msg}`);
      }
    }
  }
}
