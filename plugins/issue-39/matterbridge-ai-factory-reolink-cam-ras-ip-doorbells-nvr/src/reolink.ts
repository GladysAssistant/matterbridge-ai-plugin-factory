/**
 * Minimal Reolink HTTP CGI client (no external deps).
 *
 * Implements the subset of the Reolink CGI API needed by the plugin:
 * login/token, channel discovery, motion + AI detection states,
 * IR LED / spotlight / siren control, battery and Wi-Fi signal.
 *
 * @file reolink.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';

/** A single Reolink CGI command. */
export interface ReolinkCommand {
  cmd: string;
  action?: number;
  param?: Record<string, unknown>;
}

/** A Reolink CGI response entry. */
export interface ReolinkResponse {
  cmd: string;
  code: number;
  value?: Record<string, unknown>;
  error?: { detail?: string; rspCode?: number };
}

/** Per-channel runtime state. */
export interface ChannelState {
  channel: number;
  name: string;
  online: boolean;
  motion: boolean;
  person: boolean;
  vehicle: boolean;
  animal: boolean;
  irLed: boolean;
  spotlight: boolean;
  siren: boolean;
  battery?: number;
  wifiSignal?: number;
}

/** Options to construct a {@link ReolinkHost}. */
export interface ReolinkHostOptions {
  host: string;
  username: string;
  password: string;
  useHttps?: boolean;
  port?: number;
}

/**
 * Reolink camera / NVR host using the HTTP CGI protocol.
 */
export class ReolinkHost {
  private readonly host: string;
  private readonly username: string;
  private readonly password: string;
  private readonly baseUrl: string;
  private token = '';
  private tokenExpire = 0;

  /**
   * @param {ReolinkHostOptions} options - Connection options.
   * @param {AnsiLogger} log - Logger instance.
   */
  constructor(
    options: ReolinkHostOptions,
    private readonly log: AnsiLogger,
  ) {
    this.host = options.host;
    this.username = options.username;
    this.password = options.password;
    const scheme = options.useHttps ? 'https' : 'http';
    const port = options.port ?? (options.useHttps ? 443 : 80);
    this.baseUrl = `${scheme}://${this.host}:${port}/cgi-bin/api.cgi`;
  }

  /**
   * Send a batch of CGI commands.
   *
   * @param {ReolinkCommand[]} commands - Commands to send.
   * @param {boolean} withToken - Whether to authenticate the request.
   * @returns {Promise<ReolinkResponse[]>} The parsed responses.
   */
  async cmd(commands: ReolinkCommand[], withToken = true): Promise<ReolinkResponse[]> {
    const url = withToken ? `${this.baseUrl}?token=${encodeURIComponent(this.token)}` : this.baseUrl;
    // Reolink uses a self-signed certificate over HTTPS; tolerate it.
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ReolinkResponse[];
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }

  /**
   * Authenticate and cache a token.
   *
   * @returns {Promise<void>} Resolves when logged in.
   */
  async login(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpire) return;
    const res = await this.cmd([{ cmd: 'Login', param: { User: { userName: this.username, password: this.password } } }], false);
    const value = res[0]?.value as { Token?: { name: string; leaseTime: number } } | undefined;
    if (res[0]?.code !== 0 || !value?.Token) throw new Error(`Login failed: ${JSON.stringify(res[0]?.error ?? res[0])}`);
    this.token = value.Token.name;
    this.tokenExpire = Date.now() + (value.Token.leaseTime - 60) * 1000;
    this.log.debug(`Reolink login ok, token leaseTime=${value.Token.leaseTime}s`);
  }

  /**
   * Discover channels of a single camera or NVR.
   *
   * @returns {Promise<{ channel: number; name: string }[]>} Channel list.
   */
  async getChannels(): Promise<{ channel: number; name: string }[]> {
    await this.login();
    const res = await this.cmd([
      { cmd: 'GetChannelstatus' },
      { cmd: 'GetDevInfo', action: 0, param: {} },
    ]);
    const status = res.find((r) => r.cmd === 'GetChannelstatus')?.value as { count?: number; status?: { channel: number; name: string; online: number }[] } | undefined;
    if (status?.status?.length) {
      return status.status.map((s) => ({ channel: s.channel, name: s.name || `Channel ${s.channel}` }));
    }
    const info = res.find((r) => r.cmd === 'GetDevInfo')?.value as { DevInfo?: { channelNum?: number; name?: string } } | undefined;
    const count = info?.DevInfo?.channelNum ?? 1;
    return Array.from({ length: Math.max(1, count) }, (_, i) => ({ channel: i, name: info?.DevInfo?.name || `Channel ${i}` }));
  }

  /**
   * Read the full runtime state of a channel.
   *
   * @param {number} channel - Channel index.
   * @returns {Promise<ChannelState>} The channel state.
   */
  async getState(channel: number): Promise<ChannelState> {
    await this.login();
    const res = await this.cmd([
      { cmd: 'GetMdState', action: 0, param: { channel } },
      { cmd: 'GetAiState', action: 0, param: { channel } },
      { cmd: 'GetIrLights', action: 0, param: { channel } },
      { cmd: 'GetWhiteLed', action: 0, param: { channel } },
      { cmd: 'GetBatteryInfo', action: 0, param: { channel } },
      { cmd: 'GetChannelstatus' },
    ]);
    const find = (cmd: string) => res.find((r) => r.cmd === cmd)?.value as Record<string, unknown> | undefined;

    const md = find('GetMdState');
    const ai = find('GetAiState') as { person?: { alarm_state?: number }; vehicle?: { alarm_state?: number }; dog_cat?: { alarm_state?: number } } | undefined;
    const ir = find('GetIrLights') as { IrLights?: { state?: string } } | undefined;
    const white = find('GetWhiteLed') as { WhiteLed?: { state?: number } } | undefined;
    const bat = find('GetBatteryInfo') as { Battery?: { batteryPercent?: number } } | undefined;
    const chStatus = (find('GetChannelstatus') as { status?: { channel: number; online: number; name: string }[] } | undefined)?.status?.find((s) => s.channel === channel);

    return {
      channel,
      name: chStatus?.name || `Channel ${channel}`,
      online: chStatus ? chStatus.online === 1 : true,
      motion: (md?.state as number) === 1,
      person: ai?.person?.alarm_state === 1,
      vehicle: ai?.vehicle?.alarm_state === 1,
      animal: ai?.dog_cat?.alarm_state === 1,
      irLed: ir?.IrLights?.state === 'Auto' || ir?.IrLights?.state === 'On',
      spotlight: (white?.WhiteLed?.state ?? 0) === 1,
      siren: false,
      battery: bat?.Battery?.batteryPercent,
    };
  }

  /**
   * Toggle the IR LED of a channel.
   *
   * @param {number} channel - Channel index.
   * @param {boolean} on - Desired state (On/Auto vs Off).
   * @returns {Promise<void>} Resolves when applied.
   */
  async setIrLed(channel: number, on: boolean): Promise<void> {
    await this.login();
    await this.cmd([{ cmd: 'SetIrLights', param: { IrLights: { channel, state: on ? 'Auto' : 'Off' } } }]);
  }

  /**
   * Toggle the spotlight (white LED) of a channel.
   *
   * @param {number} channel - Channel index.
   * @param {boolean} on - Desired state.
   * @returns {Promise<void>} Resolves when applied.
   */
  async setSpotlight(channel: number, on: boolean): Promise<void> {
    await this.login();
    await this.cmd([{ cmd: 'SetWhiteLed', param: { WhiteLed: { channel, state: on ? 1 : 0, mode: on ? 1 : 0 } } }]);
  }

  /**
   * Trigger or stop the siren of a channel.
   *
   * @param {number} channel - Channel index.
   * @param {boolean} on - Desired state.
   * @returns {Promise<void>} Resolves when applied.
   */
  async setSiren(channel: number, on: boolean): Promise<void> {
    await this.login();
    await this.cmd([{ cmd: 'AudioAlarmPlay', param: { alarm_mode: 'manul', manual_switch: on ? 1 : 0, times: on ? 1 : 0, channel } }]);
  }
}
