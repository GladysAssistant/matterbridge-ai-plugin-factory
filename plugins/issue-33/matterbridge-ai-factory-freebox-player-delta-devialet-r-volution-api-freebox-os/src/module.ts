/**
 * Matterbridge plugin exposing Freebox Player (Delta/Devialet, Révolution) and
 * optionally the Freebox Server to Matter through the Freebox OS API.
 *
 * Players are exposed as Basic Video Players with:
 * - OnOff: power state (detected via an AirPlay TCP probe, toggled via the
 *   virtual remote `power` key)
 * - LevelControl: volume 0..100
 * - MediaPlayback: play / pause / stop / next / previous (best effort)
 * - KeypadInput: virtual remote navigation keys (up/down/left/right/ok/back/home)
 *
 * The optional Freebox Server device exposes CPU temperature, WAN connection
 * state and a (gated) reboot switch.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import {
  BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  PlatformMatterbridge,
  contactSensor,
  onOffSwitch,
  temperatureSensor,
} from 'matterbridge';
import { BasicVideoPlayer } from 'matterbridge/devices';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { BooleanState, LevelControl, MediaPlayback, OnOff, TemperatureMeasurement } from 'matterbridge/matter/clusters';

import { FreeboxClient, FreeboxPlayer } from './freebox.js';

/** Plugin configuration shape. */
export type FreeboxPlatformConfig = BasePlatformConfig & {
  whiteList: string[];
  blackList: string[];
  host?: string;
  useHttps?: boolean;
  appId?: string;
  appName?: string;
  appVersion?: string;
  deviceName?: string;
  appToken?: string;
  powerProbePort?: number;
  pollInterval?: number;
  enableServer?: boolean;
  allowReboot?: boolean;
};

/** CEC key code (KeypadInput.sendKey) to Freebox remote key mapping. */
const CEC_TO_REMOTE: Record<number, string> = {
  0x00: 'ok', // Select
  0x01: 'up',
  0x02: 'down',
  0x03: 'left',
  0x04: 'right',
  0x09: 'home', // Root menu
  0x0d: 'back', // Exit
  0x20: '0',
  0x21: '1',
  0x22: '2',
  0x23: '3',
  0x24: '4',
  0x25: '5',
  0x26: '6',
  0x27: '7',
  0x28: '8',
  0x29: '9',
};

/** Internal binding between a Matter endpoint and a Freebox player. */
interface PlayerBinding {
  player: FreeboxPlayer;
  endpoint: MatterbridgeEndpoint;
  host: string;
}

/**
 * Initialize the plugin. Standard Matterbridge entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
 * @param {AnsiLogger} log - Logger instance.
 * @param {FreeboxPlatformConfig} config - Plugin configuration.
 * @returns {FreeboxPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: FreeboxPlatformConfig): FreeboxPlatform {
  return new FreeboxPlatform(matterbridge, log, config);
}

/** Freebox Player Matterbridge dynamic platform. */
export class FreeboxPlatform extends MatterbridgeDynamicPlatform {
  private client?: FreeboxClient;
  private readonly bindings: PlayerBinding[] = [];
  private serverEndpoint?: MatterbridgeEndpoint;
  private pollTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - Matterbridge instance.
   * @param {AnsiLogger} log - Logger instance.
   * @param {FreeboxPlatformConfig} config - Plugin configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: FreeboxPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(`This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`);
    }

    this.log.info('Initializing Freebox Player platform...');
  }

  /** @returns {FreeboxPlatformConfig} The typed plugin config. */
  private cfg(): FreeboxPlatformConfig {
    return this.config as FreeboxPlatformConfig;
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    const c = this.cfg();
    const host = c.host && c.host.length > 0 ? c.host : 'mafreebox.freebox.fr';

    this.client = new FreeboxClient(this.log, {
      host,
      useHttps: c.useHttps ?? false,
      appId: c.appId ?? 'org.gladys.matterbridge.freebox',
      appName: c.appName ?? 'Matterbridge Freebox',
      appVersion: c.appVersion ?? '1.0.0',
      deviceName: c.deviceName ?? 'Matterbridge',
      appToken: c.appToken,
    });

    try {
      await this.bootstrap(host);
    } catch (error) {
      this.log.warn(`Freebox not reachable, no devices registered: ${(error as Error).message}`);
    }
  }

  /**
   * Discover, authenticate and create the Matter devices.
   *
   * @param {string} host - Freebox host/IP.
   * @returns {Promise<void>} Resolves once devices have been created.
   */
  private async bootstrap(host: string): Promise<void> {
    if (!this.client) return;
    await this.client.discover();

    if (!this.client.appToken) {
      const { trackId } = await this.client.requestAuthorization();
      this.log.warn('Freebox authorization requested. Please press the "✓" (right arrow) on the Freebox front panel to grant access.');
      const granted = await this.waitForAuthorization(trackId);
      if (!granted) {
        this.log.error('Freebox authorization not granted. Configure the appToken or retry. No devices registered.');
        return;
      }
      this.cfg().appToken = this.client.appToken;
      this.saveConfig(this.config);
      this.log.info('Freebox app token granted and persisted.');
    }

    await this.client.login();

    const players = await this.client.getPlayers();
    this.log.info(`Found ${players.length} Freebox player(s).`);
    for (const player of players) {
      await this.createPlayerDevice(player, host);
    }

    if (this.cfg().enableServer) {
      await this.createServerDevice();
    }

    this.startPolling();
  }

  /**
   * Poll the authorization tracking status until granted, denied or timeout.
   *
   * @param {number} trackId - Tracking id.
   * @returns {Promise<boolean>} True when granted.
   */
  private async waitForAuthorization(trackId: number): Promise<boolean> {
    if (!this.client) return false;
    for (let i = 0; i < 30; i++) {
      const status = await this.client.getAuthorizationStatus(trackId);
      if (status === 'granted') return true;
      if (status === 'denied' || status === 'timeout') {
        this.log.error(`Freebox authorization ${status}.`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  /**
   * Create and register a Matter device for a Freebox player.
   *
   * @param {FreeboxPlayer} player - The player.
   * @param {string} host - Freebox host (used for the power probe).
   * @returns {Promise<void>} Resolves once registered.
   */
  private async createPlayerDevice(player: FreeboxPlayer, host: string): Promise<void> {
    const name = player.name && player.name.length > 0 ? player.name : `Freebox Player ${player.id}`;
    const serial = `fbx-player-${player.id}`;

    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const device = new BasicVideoPlayer(name, serial);
    device.createDefaultLevelControlClusterServer(0, 0, 100);

    device
      .addCommandHandler('on', () => this.safe(() => this.client?.remoteKey(player, 'power'), 'power on'))
      .addCommandHandler('off', () => this.safe(() => this.client?.remoteKey(player, 'power'), 'power off'))
      .addCommandHandler('moveToLevel', (data) => this.handleVolume(player, data))
      .addCommandHandler('moveToLevelWithOnOff', (data) => this.handleVolume(player, data))
      .addCommandHandler('play', () => this.safe(() => this.client?.mediaControl(player, 'play'), 'play'))
      .addCommandHandler('pause', () => this.safe(() => this.client?.mediaControl(player, 'pause'), 'pause'))
      .addCommandHandler('stop', () => this.safe(() => this.client?.mediaControl(player, 'stop'), 'stop'))
      .addCommandHandler('next', () => this.safe(() => this.client?.mediaControl(player, 'next'), 'next'))
      .addCommandHandler('previous', () => this.safe(() => this.client?.mediaControl(player, 'prev'), 'previous'))
      .addCommandHandler('sendKey', (data) => this.handleSendKey(player, data));

    await this.registerDevice(device);
    this.bindings.push({ player, endpoint: device, host });
  }

  /**
   * Handle a LevelControl move command by setting the player volume.
   *
   * @param {FreeboxPlayer} player - Target player.
   * @param {{ request?: { level?: number } }} data - Command data.
   * @returns {Promise<void>} Resolves when the command was sent.
   */
  private async handleVolume(player: FreeboxPlayer, data: { request?: { level?: number } }): Promise<void> {
    const level = data.request?.level ?? 0;
    const volume = Math.round((level / 254) * 100);
    await this.safe(() => this.client?.setVolume(player, volume), `volume ${volume}`);
  }

  /**
   * Handle a KeypadInput.sendKey command by mapping the CEC code to a remote key.
   *
   * @param {FreeboxPlayer} player - Target player.
   * @param {{ request?: { keyCode?: number } }} data - Command data.
   * @returns {Promise<void>} Resolves when the command was sent.
   */
  private async handleSendKey(player: FreeboxPlayer, data: { request?: { keyCode?: number } }): Promise<void> {
    const code = data.request?.keyCode ?? -1;
    const key = CEC_TO_REMOTE[code];
    if (!key) {
      this.log.debug(`Unmapped CEC key code 0x${code.toString(16)}`);
      return;
    }
    await this.safe(() => this.client?.remoteKey(player, key), `remote ${key}`);
  }

  /**
   * Create the optional Freebox Server device (CPU temp, connection, reboot).
   *
   * @returns {Promise<void>} Resolves once registered.
   */
  private async createServerDevice(): Promise<void> {
    const serial = 'fbx-server';
    const name = 'Freebox Server';
    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) return;

    const device = new MatterbridgeEndpoint([temperatureSensor, contactSensor], { id: 'FreeboxServer' })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'Freebox', 'Freebox Server')
      .createDefaultTemperatureMeasurementClusterServer(0)
      .createDefaultBooleanStateClusterServer(true)
      .addRequiredClusterServers();
    await this.registerDevice(device);
    this.serverEndpoint = device;

    if (this.cfg().allowReboot) {
      const rebootSerial = 'fbx-server-reboot';
      this.setSelectDevice(rebootSerial, 'Freebox Reboot');
      const reboot = new MatterbridgeEndpoint(onOffSwitch, { id: 'FreeboxReboot' })
        .createDefaultBridgedDeviceBasicInformationClusterServer('Freebox Reboot', rebootSerial, this.matterbridge.aggregatorVendorId, 'Freebox', 'Freebox Reboot')
        .addRequiredClusterServers()
        .addCommandHandler('on', async () => {
          this.log.warn('Reboot command received: rebooting the Freebox Server!');
          await this.safe(() => this.client?.reboot(), 'reboot');
          await reboot.setAttribute(OnOff, 'onOff', false);
        });
      await this.registerDevice(reboot);
    }
  }

  /** Start the periodic status/power polling loop. */
  private startPolling(): void {
    const interval = Math.max(5, this.cfg().pollInterval ?? 15) * 1000;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, interval);
    void this.poll();
  }

  /**
   * Poll players and server for their current state and push updates to Matter.
   *
   * @returns {Promise<void>} Resolves once the poll finished.
   */
  private async poll(): Promise<void> {
    if (!this.client) return;
    const port = this.cfg().powerProbePort ?? 7000;
    for (const b of this.bindings) {
      try {
        const on = await FreeboxClient.probePower(b.host, port);
        await b.endpoint.updateAttribute(OnOff, 'onOff', on, this.log);
        if (!on) {
          await b.endpoint.updateAttribute(MediaPlayback, 'currentState', MediaPlayback.PlaybackState.NotPlaying, this.log);
          continue;
        }
        const status = await this.client.getPlayerStatus(b.player);
        const volume = status?.audio?.volume ?? status?.player?.volume;
        if (typeof volume === 'number') {
          await b.endpoint.updateAttribute(LevelControl, 'currentLevel', Math.round((volume / 100) * 254), this.log);
        }
      } catch (error) {
        this.log.debug(`Poll failed for player ${b.player.id}: ${(error as Error).message}`);
      }
    }

    if (this.serverEndpoint) {
      try {
        const system = await this.client.getSystem();
        if (typeof system?.tempCpu === 'number') {
          await this.serverEndpoint.updateAttribute(TemperatureMeasurement, 'measuredValue', Math.round(system.tempCpu * 100), this.log);
        }
        const up = await this.client.getConnectionUp();
        if (typeof up === 'boolean') {
          await this.serverEndpoint.updateAttribute(BooleanState, 'stateValue', up, this.log);
        }
      } catch (error) {
        this.log.debug(`Server poll failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Run an async action, swallowing and logging any error (best effort control).
   *
   * @param {() => Promise<unknown> | undefined} action - The action to run.
   * @param {string} what - Human readable description for logs.
   * @returns {Promise<void>} Always resolves.
   */
  private async safe(action: () => Promise<unknown> | undefined, what: string): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.log.warn(`Freebox command "${what}" failed: ${(error as Error).message}`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');
    await this.poll();
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
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }
}
