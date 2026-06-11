/**
 * Freebox OS API client for the Matterbridge Freebox Player plugin.
 *
 * Implements the Freebox OS authentication flow (app authorization, session
 * challenge with HMAC-SHA1), the Player control endpoints (status, volume,
 * media control, open url, virtual remote) and a small subset of the Freebox
 * Server endpoints (system info, reboot). Also provides an AirPlay TCP probe
 * used to detect whether a Player is powered on.
 *
 * @file freebox.ts
 * @license Apache-2.0
 */

import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { AnsiLogger } from 'matterbridge/logger';

/** Options used to construct a {@link FreeboxClient}. */
export interface FreeboxClientOptions {
  /** Hostname or IP of the Freebox (default `mafreebox.freebox.fr`). */
  host: string;
  /** Use HTTPS instead of plain HTTP on the LAN. */
  useHttps: boolean;
  /** Application identifier registered against the Freebox. */
  appId: string;
  /** Human readable application name shown on the Freebox screen. */
  appName: string;
  /** Application version string. */
  appVersion: string;
  /** Device name shown on the Freebox screen. */
  deviceName: string;
  /** Persisted application token, if already granted. */
  appToken?: string;
}

/** A Freebox Player as returned by `GET /player`. */
export interface FreeboxPlayer {
  /** Numeric player id used in control endpoints. */
  id: number;
  /** Player display name. */
  name: string;
  /** Player model id (e.g. `fbxgw-r2/full`). */
  device_model?: string;
  /** Player local API version (used to build the `/api/v{n}` path). */
  api_version?: string;
  /** Whether the player is currently reachable. */
  reachable?: boolean;
}

/** Player status payload (best effort, fields vary by firmware). */
export interface FreeboxPlayerStatus {
  /** Currently focused application package (e.g. `tv`, `netflix`). */
  power_state?: string;
  foreground_app?: { package?: string; cur_url?: string };
  /** Audio volume 0..100. */
  audio?: { volume?: number; mute?: boolean };
  player?: { volume?: number; mute?: boolean };
}

/** Generic Freebox API envelope. */
interface FreeboxResponse<T> {
  success: boolean;
  error_code?: string;
  msg?: string;
  result?: T;
}

/** Error thrown when the Freebox reports `auth_required`. */
export class FreeboxAuthError extends Error {}

/**
 * Minimal Freebox OS API client.
 */
export class FreeboxClient {
  private readonly log: AnsiLogger;
  private readonly options: FreeboxClientOptions;
  private apiBaseUrl = '/api/';
  private apiVersionMajor = 8;
  private sessionToken?: string;
  /** Resolved application token (granted by the user on the Freebox). */
  public appToken?: string;

  /**
   * @param {AnsiLogger} log - Logger instance.
   * @param {FreeboxClientOptions} options - Client options.
   */
  constructor(log: AnsiLogger, options: FreeboxClientOptions) {
    this.log = log;
    this.options = options;
    this.appToken = options.appToken;
  }

  /** @returns {string} The base URL prefix including the API major version. */
  private base(): string {
    const scheme = this.options.useHttps ? 'https' : 'http';
    return `${scheme}://${this.options.host}${this.apiBaseUrl}v${this.apiVersionMajor}`;
  }

  /**
   * Perform a raw HTTP(S) JSON request against the Freebox.
   *
   * @param {string} method - HTTP method.
   * @param {string} url - Absolute URL.
   * @param {unknown} [body] - Optional JSON body.
   * @returns {Promise<FreeboxResponse<T>>} Parsed Freebox response envelope.
   */
  private request<T>(method: string, url: string, body?: unknown): Promise<FreeboxResponse<T>> {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const isHttps = url.startsWith('https:');
    const lib = isHttps ? https : http;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(data));
    }
    if (this.sessionToken) headers['X-Fbx-App-Auth'] = this.sessionToken;
    // The Freebox uses a self-signed certificate on the LAN.
    const agentOptions = isHttps ? { rejectUnauthorized: false } : {};
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method, headers, ...agentOptions, timeout: 8000 }, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(raw ? (JSON.parse(raw) as FreeboxResponse<T>) : { success: true });
          } catch {
            reject(new Error(`Invalid JSON from ${url}: ${raw.slice(0, 120)}`));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`Timeout calling ${url}`)));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  /**
   * Discover the API base url and major version via `GET /api_version`.
   *
   * @returns {Promise<void>} Resolves once discovery completed.
   */
  async discover(): Promise<void> {
    const scheme = this.options.useHttps ? 'https' : 'http';
    const res = await this.request<never>('GET', `${scheme}://${this.options.host}/api_version`);
    const info = res as unknown as { api_base_url?: string; api_version?: string; device_name?: string };
    if (info.api_base_url) this.apiBaseUrl = info.api_base_url;
    if (info.api_version) this.apiVersionMajor = parseInt(info.api_version, 10) || this.apiVersionMajor;
    this.log.info(`Freebox discovered: ${info.device_name ?? this.options.host} api v${this.apiVersionMajor} base ${this.apiBaseUrl}`);
  }

  /**
   * Request a new application token. Requires the user to physically validate
   * the registration on the Freebox front panel.
   *
   * @returns {Promise<{ appToken: string; trackId: number }>} The pending token and tracking id.
   */
  async requestAuthorization(): Promise<{ appToken: string; trackId: number }> {
    const res = await this.request<{ app_token: string; track_id: number }>('POST', `${this.base()}/login/authorize/`, {
      app_id: this.options.appId,
      app_name: this.options.appName,
      app_version: this.options.appVersion,
      device_name: this.options.deviceName,
    });
    if (!res.success || !res.result) throw new Error(`Authorization request failed: ${res.error_code ?? res.msg}`);
    this.appToken = res.result.app_token;
    return { appToken: res.result.app_token, trackId: res.result.track_id };
  }

  /**
   * Poll the authorization tracking status.
   *
   * @param {number} trackId - Tracking id from {@link requestAuthorization}.
   * @returns {Promise<string>} One of `pending`, `granted`, `denied`, `timeout`, `unknown`.
   */
  async getAuthorizationStatus(trackId: number): Promise<string> {
    const res = await this.request<{ status: string }>('GET', `${this.base()}/login/authorize/${trackId}`);
    return res.result?.status ?? 'unknown';
  }

  /**
   * Open a session using the persisted application token.
   *
   * @returns {Promise<void>} Resolves once a session token has been obtained.
   */
  async login(): Promise<void> {
    if (!this.appToken) throw new FreeboxAuthError('No app token available');
    const challengeRes = await this.request<{ challenge: string }>('GET', `${this.base()}/login/`);
    const challenge = challengeRes.result?.challenge;
    if (!challenge) throw new FreeboxAuthError('No challenge returned');
    const password = createHmac('sha1', this.appToken).update(challenge).digest('hex');
    const sessionRes = await this.request<{ session_token: string }>('POST', `${this.base()}/login/session/`, {
      app_id: this.options.appId,
      password,
    });
    if (!sessionRes.success || !sessionRes.result) {
      throw new FreeboxAuthError(`Login failed: ${sessionRes.error_code ?? sessionRes.msg}`);
    }
    this.sessionToken = sessionRes.result.session_token;
    this.log.debug('Freebox session opened');
  }

  /**
   * Perform an authenticated call, transparently re-logging in once on
   * `auth_required`.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - Path relative to the API version base.
   * @param {unknown} [body] - Optional JSON body.
   * @returns {Promise<FreeboxResponse<T>>} Parsed response.
   */
  async call<T>(method: string, path: string, body?: unknown): Promise<FreeboxResponse<T>> {
    if (!this.sessionToken) await this.login();
    let res = await this.request<T>(method, `${this.base()}${path}`, body);
    if (!res.success && res.error_code === 'auth_required') {
      this.sessionToken = undefined;
      await this.login();
      res = await this.request<T>(method, `${this.base()}${path}`, body);
    }
    return res;
  }

  /**
   * List the Freebox Players.
   *
   * @returns {Promise<FreeboxPlayer[]>} Array of players (empty on failure).
   */
  async getPlayers(): Promise<FreeboxPlayer[]> {
    const res = await this.call<FreeboxPlayer[]>('GET', '/player');
    return res.result ?? [];
  }

  /**
   * Build the per-player control path prefix.
   *
   * @param {FreeboxPlayer} player - Target player.
   * @returns {string} Path prefix like `/player/1/api/v6`.
   */
  private playerApi(player: FreeboxPlayer): string {
    const ver = player.api_version ? parseInt(player.api_version, 10) : 6;
    return `/player/${player.id}/api/v${ver}`;
  }

  /**
   * Read a player status.
   *
   * @param {FreeboxPlayer} player - Target player.
   * @returns {Promise<FreeboxPlayerStatus | undefined>} Status or undefined when not implemented.
   */
  async getPlayerStatus(player: FreeboxPlayer): Promise<FreeboxPlayerStatus | undefined> {
    const res = await this.call<FreeboxPlayerStatus>('GET', `${this.playerApi(player)}/status`);
    if (!res.success && res.error_code === 'not_implemented') return undefined;
    return res.result;
  }

  /**
   * Set the player volume.
   *
   * @param {FreeboxPlayer} player - Target player.
   * @param {number} volume - Volume 0..100.
   * @returns {Promise<void>} Resolves when the command was sent.
   */
  async setVolume(player: FreeboxPlayer, volume: number): Promise<void> {
    await this.call('PUT', `${this.playerApi(player)}/control/volume/`, { volume: Math.max(0, Math.min(100, Math.round(volume))) });
  }

  /**
   * Send a media control command.
   *
   * @param {FreeboxPlayer} player - Target player.
   * @param {string} command - One of `play`, `pause`, `stop`, `next`, `prev`.
   * @returns {Promise<void>} Resolves when the command was sent.
   */
  async mediaControl(player: FreeboxPlayer, command: string): Promise<void> {
    await this.call('POST', `${this.playerApi(player)}/control/mediactrl`, { command });
  }

  /**
   * Open a URL on the player (used for TV channel change `tv:?channel=N`).
   *
   * @param {FreeboxPlayer} player - Target player.
   * @param {string} url - URL to open.
   * @returns {Promise<void>} Resolves when the command was sent.
   */
  async open(player: FreeboxPlayer, url: string): Promise<void> {
    await this.call('POST', `${this.playerApi(player)}/control/open`, { url });
  }

  /**
   * Press a virtual remote key.
   *
   * @param {FreeboxPlayer} player - Target player.
   * @param {string} key - Remote key (e.g. `up`, `ok`, `home`, `power`).
   * @returns {Promise<void>} Resolves when the command was sent.
   */
  async remoteKey(player: FreeboxPlayer, key: string): Promise<void> {
    await this.call('POST', `${this.playerApi(player)}/control/remote`, { key });
  }

  /**
   * Probe an AirPlay (or alternative) TCP port to detect power state.
   *
   * @param {string} host - Player host/IP.
   * @param {number} port - TCP port to probe.
   * @param {number} [timeout] - Connection timeout in ms.
   * @returns {Promise<boolean>} True when the port is open (powered on).
   */
  static probePower(host: string, port: number, timeout = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result: boolean): void => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeout);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  /**
   * Read Freebox Server system information (CPU temperature, etc.).
   *
   * @returns {Promise<{ tempCpu?: number } | undefined>} System info subset.
   */
  async getSystem(): Promise<{ tempCpu?: number } | undefined> {
    const res = await this.call<{ temp_cpub?: number; temp_cpum?: number; sensors?: { id: string; value: number }[] }>('GET', '/system/');
    if (!res.result) return undefined;
    const sensors = res.result.sensors ?? [];
    const cpu = sensors.find((s) => /cpu/i.test(s.id));
    return { tempCpu: res.result.temp_cpub ?? res.result.temp_cpum ?? cpu?.value };
  }

  /**
   * Read the WAN connection state.
   *
   * @returns {Promise<boolean | undefined>} True when connection state is `up`.
   */
  async getConnectionUp(): Promise<boolean | undefined> {
    const res = await this.call<{ state?: string }>('GET', '/connection/');
    if (!res.result?.state) return undefined;
    return res.result.state === 'up';
  }

  /**
   * Reboot the Freebox Server. Dangerous: gated by plugin configuration.
   *
   * @returns {Promise<void>} Resolves once the reboot command was accepted.
   */
  async reboot(): Promise<void> {
    await this.call('POST', '/system/reboot/');
  }
}
