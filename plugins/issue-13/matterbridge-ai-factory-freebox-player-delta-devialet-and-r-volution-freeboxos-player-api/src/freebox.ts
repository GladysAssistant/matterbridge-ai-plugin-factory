/**
 * Lightweight Freebox OS client (login, session renewal, Player API calls).
 *
 * Reference: https://dev.freebox.fr/sdk/os/
 *
 * @file freebox.ts
 * @license Apache-2.0
 */

import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Socket } from 'node:net';
import { URL } from 'node:url';

import { AnsiLogger } from 'matterbridge/logger';

export interface FreeboxApiVersion {
  api_version: string;
  api_base_url: string;
  device_type?: string;
  device_name?: string;
  uid?: string;
  https_available?: boolean;
  https_port?: number;
  api_domain?: string;
}

export interface FreeboxPlayer {
  id: number;
  device_model?: string;
  device_name?: string;
  api_version?: string;
  api_available?: boolean;
  reachable?: boolean;
  lan_host?: { l3connectivities?: Array<{ addr?: string }>; primary_name?: string };
}

export interface FreeboxPlayerStatus {
  power_state?: 'standby' | 'running';
  player_state?: string;
  foreground_app?: { package?: string; curr_url?: string };
  audio_ctrl?: { volume?: number; muted?: boolean };
  channel?: { channel_uuid?: string; channel_number?: number; channel_name?: string };
}

interface FreeboxApiResponse<T> {
  success: boolean;
  result?: T;
  error_code?: string;
  msg?: string;
  missing_right?: string;
}

interface AuthorizeResult {
  app_token: string;
  track_id: number;
}

interface TrackResult {
  status: 'unknown' | 'pending' | 'timeout' | 'granted' | 'denied';
  challenge: string;
}

interface SessionResult {
  session_token: string;
  challenge: string;
  permissions?: Record<string, boolean>;
}

export interface FreeboxClientOptions {
  host: string;
  appId: string;
  appName: string;
  appVersion: string;
  deviceName: string;
  appToken?: string;
}

/** Strip API base URL to a major version segment, e.g. "/api/" + majorVersion. */
function apiBase(majorVersion: number, apiBaseUrl: string): string {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : apiBaseUrl + '/';
  return `${base}v${majorVersion}`;
}

/** Minimal HTTP(S) JSON request helper used by the client. */
function jsonRequest<T>(
  urlString: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; insecure?: boolean } = {},
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(err as Error);
      return;
    }
    const isHttps = url.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }
    const req = reqFn(
      {
        method: options.method ?? 'GET',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers,
        // Freebox uses a self-signed cert on the LAN. Allow it.
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = undefined;
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T });
        });
      },
    );
    req.on('error', (err) => reject(err));
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new Error(`HTTP timeout after ${options.timeoutMs}ms: ${urlString}`));
      });
    }
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Probe a TCP port to detect player power state (AirPlay default 7000). */
export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new Socket();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try {
      sock.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/** Client encapsulating Freebox OS auth and Player API calls. */
export class FreeboxClient {
  public host: string;
  public apiBaseUrl = '/api/';
  public apiMajor = 6;
  public httpsPort = 0;
  public apiDomain = '';
  public deviceName = '';
  public uid = '';
  public appToken = '';
  private sessionToken = '';
  private sessionExpiresAt = 0;
  private readonly opts: FreeboxClientOptions;
  private readonly log: AnsiLogger;

  constructor(opts: FreeboxClientOptions, log: AnsiLogger) {
    this.opts = opts;
    this.host = opts.host;
    this.appToken = opts.appToken ?? '';
    this.log = log;
  }

  /** Build a base URL for API calls (prefer HTTPS+api_domain when known). */
  private buildBase(): string {
    if (this.apiDomain && this.httpsPort) return `https://${this.apiDomain}:${this.httpsPort}`;
    return `http://${this.host}`;
  }

  /** Fetch the public api_version discovery endpoint. */
  async discoverApiVersion(): Promise<FreeboxApiVersion> {
    const { status, body } = await jsonRequest<FreeboxApiVersion>(`http://${this.host}/api_version`, { timeoutMs: 5000 });
    if (status !== 200 || !body || typeof body !== 'object') {
      throw new Error(`api_version discovery failed (status ${status})`);
    }
    this.apiBaseUrl = body.api_base_url ?? '/api/';
    const major = parseInt((body.api_version ?? '6.0').split('.')[0] ?? '6', 10);
    this.apiMajor = Number.isFinite(major) ? major : 6;
    this.httpsPort = body.https_port ?? 0;
    this.apiDomain = body.api_domain ?? '';
    this.deviceName = body.device_name ?? '';
    this.uid = body.uid ?? '';
    return body;
  }

  /** Authorize a new app — user must validate on the front panel. */
  async authorize(): Promise<AuthorizeResult> {
    const url = `${this.buildBase()}${apiBase(this.apiMajor, this.apiBaseUrl)}/login/authorize/`;
    const { body } = await jsonRequest<FreeboxApiResponse<AuthorizeResult>>(url, {
      method: 'POST',
      body: {
        app_id: this.opts.appId,
        app_name: this.opts.appName,
        app_version: this.opts.appVersion,
        device_name: this.opts.deviceName,
      },
      timeoutMs: 5000,
    });
    if (!body || !body.success || !body.result) {
      throw new Error(`authorize failed: ${body?.msg ?? 'unknown error'}`);
    }
    this.appToken = body.result.app_token;
    return body.result;
  }

  /** Poll the authorize track id until granted/denied/timeout. */
  async pollAuthorize(trackId: number): Promise<TrackResult> {
    const url = `${this.buildBase()}${apiBase(this.apiMajor, this.apiBaseUrl)}/login/authorize/${trackId}`;
    const { body } = await jsonRequest<FreeboxApiResponse<TrackResult>>(url, { timeoutMs: 5000 });
    if (!body || !body.success || !body.result) throw new Error(`pollAuthorize failed: ${body?.msg ?? 'unknown'}`);
    return body.result;
  }

  /** Get login challenge. */
  private async getChallenge(): Promise<string> {
    const url = `${this.buildBase()}${apiBase(this.apiMajor, this.apiBaseUrl)}/login/`;
    const { body } = await jsonRequest<FreeboxApiResponse<{ challenge: string }>>(url, { timeoutMs: 5000 });
    if (!body || !body.success || !body.result) throw new Error(`getChallenge failed: ${body?.msg ?? 'unknown'}`);
    return body.result.challenge;
  }

  /** Open a session: HMAC-SHA1(challenge, app_token). */
  async openSession(): Promise<void> {
    if (!this.appToken) throw new Error('No app_token: register the app first');
    const challenge = await this.getChallenge();
    const password = createHmac('sha1', this.appToken).update(challenge).digest('hex');
    const url = `${this.buildBase()}${apiBase(this.apiMajor, this.apiBaseUrl)}/login/session/`;
    const { body } = await jsonRequest<FreeboxApiResponse<SessionResult>>(url, {
      method: 'POST',
      body: { app_id: this.opts.appId, password },
      timeoutMs: 5000,
    });
    if (!body || !body.success || !body.result) {
      throw new Error(`openSession failed: ${body?.msg ?? body?.error_code ?? 'unknown'}`);
    }
    this.sessionToken = body.result.session_token;
    // Sessions are valid 30 minutes by default; refresh proactively at 20 min.
    this.sessionExpiresAt = Date.now() + 20 * 60 * 1000;
  }

  /** Ensure a session token is present and reasonably fresh. */
  async ensureSession(): Promise<void> {
    if (!this.sessionToken || Date.now() >= this.sessionExpiresAt) {
      await this.openSession();
    }
  }

  /** Authenticated request helper with auto re-login on 401/auth_required. */
  async authedRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureSession();
    const doCall = async (): Promise<{ status: number; body: FreeboxApiResponse<T> }> => {
      return jsonRequest<FreeboxApiResponse<T>>(`${this.buildBase()}${path}`, {
        method,
        headers: { 'X-Fbx-App-Auth': this.sessionToken },
        body,
        timeoutMs: 5000,
      });
    };
    let res = await doCall();
    if (res.status === 403 || res.body?.error_code === 'auth_required') {
      await this.openSession();
      res = await doCall();
    }
    if (!res.body) throw new Error(`empty response from ${path}`);
    if (!res.body.success) {
      const code = res.body.error_code ?? `http_${res.status}`;
      throw new Error(`${code}: ${res.body.msg ?? path}`);
    }
    return res.body.result as T;
  }

  /** GET /api/vX/player → list of known players. */
  async listPlayers(): Promise<FreeboxPlayer[]> {
    const path = `${apiBase(this.apiMajor, this.apiBaseUrl)}/player`;
    return this.authedRequest<FreeboxPlayer[]>('GET', path);
  }

  /** GET player status. */
  async getPlayerStatus(playerId: number, playerApiVersion: string): Promise<FreeboxPlayerStatus> {
    const v = playerApiVersion.split('.')[0];
    const path = `${apiBase(this.apiMajor, this.apiBaseUrl)}/player/${playerId}/api/v${v}/status`;
    return this.authedRequest<FreeboxPlayerStatus>('GET', path);
  }

  /** Set volume (0-100) or mute via the player /control/volume endpoint. */
  async setVolume(playerId: number, playerApiVersion: string, payload: { volume?: number; mute?: boolean }): Promise<void> {
    const v = playerApiVersion.split('.')[0];
    const path = `${apiBase(this.apiMajor, this.apiBaseUrl)}/player/${playerId}/api/v${v}/control/volume/`;
    await this.authedRequest<unknown>('PUT', path, payload);
  }

  /** Media control: play/pause/stop/next/prev. */
  async mediaControl(playerId: number, playerApiVersion: string, command: 'play' | 'pause' | 'stop' | 'next' | 'prev'): Promise<void> {
    const v = playerApiVersion.split('.')[0];
    const path = `${apiBase(this.apiMajor, this.apiBaseUrl)}/player/${playerId}/api/v${v}/control/mediactrl`;
    await this.authedRequest<unknown>('POST', path, { command });
  }

  /** Open URL on the player (tv:?channel=N, etc.). */
  async openUrl(playerId: number, playerApiVersion: string, url: string): Promise<void> {
    const v = playerApiVersion.split('.')[0];
    const path = `${apiBase(this.apiMajor, this.apiBaseUrl)}/player/${playerId}/api/v${v}/control/open`;
    await this.authedRequest<unknown>('POST', path, { url });
  }

  /** Send a virtual remote key (ok, back, home, up, down, left, right, etc.). */
  async remoteKey(playerId: number, playerApiVersion: string, key: string): Promise<void> {
    const v = playerApiVersion.split('.')[0];
    const path = `${apiBase(this.apiMajor, this.apiBaseUrl)}/player/${playerId}/api/v${v}/control/remote`;
    await this.authedRequest<unknown>('POST', path, { key });
  }
}
