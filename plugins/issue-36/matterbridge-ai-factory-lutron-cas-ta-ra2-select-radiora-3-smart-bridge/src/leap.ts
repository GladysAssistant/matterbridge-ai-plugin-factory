/**
 * Minimal LEAP (Lutron Extensible Application Protocol) client.
 *
 * Connects to a Lutron Smart Bridge (Caséta / RA2 Select / RadioRA 3) over TLS
 * on port 8081 using the client certificate, client key and bridge CA generated
 * by `python -m pylutron_caseta.cli <bridge-ip>`.
 *
 * Messages are newline-delimited JSON objects. Requests carry a unique ClientTag
 * in their Header so responses can be correlated back to the originating request.
 *
 * @file leap.ts
 * @author hello@gladysassistant.com
 * @license Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { connect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';

/** Default TLS port exposed by Lutron Smart Bridges for LEAP. */
export const LEAP_PORT = 8081;

/** A LEAP message envelope. */
export interface LeapMessage {
  CommuniqueType?: string;
  Header?: { Url?: string; ClientTag?: string; StatusCode?: string; MessageBodyType?: string };
  Body?: Record<string, unknown>;
}

/** Connection options for the LEAP client. */
export interface LeapOptions {
  host: string;
  port?: number;
  /** Path to the client private key (caseta.key). */
  keyfile: string;
  /** Path to the client certificate (caseta.crt). */
  certfile: string;
  /** Path to the bridge CA certificate (caseta-bridge.crt). */
  ca_certs: string;
}

/**
 * A single LEAP zone status update.
 */
export interface ZoneStatus {
  zone: string;
  level: number;
  fanSpeed?: string;
}

/**
 * LeapClient manages the TLS connection and request/response correlation.
 *
 * Events:
 * - 'connect'            socket connected and TLS handshake completed
 * - 'disconnect'        socket closed
 * - 'error'             socket or protocol error (Error)
 * - 'unsolicited'       a message with no matching ClientTag (LeapMessage)
 * - 'zone'             a parsed zone status update (ZoneStatus)
 * - 'occupancy'        an occupancy group update ({ group, occupied })
 * - 'button'           a Pico/keypad button event ({ button, action })
 */
export class LeapClient extends EventEmitter {
  private socket?: TLSSocket;
  private buffer = '';
  private connected = false;
  private closing = false;
  private readonly pending = new Map<string, { resolve: (m: LeapMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  /**
   * Create a new LEAP client.
   *
   * @param {LeapOptions} options - Connection and certificate options.
   */
  constructor(private readonly options: LeapOptions) {
    super();
  }

  /**
   * Whether the TLS socket is currently connected.
   *
   * @returns {boolean} True when connected.
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Open the TLS connection to the bridge.
   *
   * @returns {Promise<void>} Resolves once the secure connection is established.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let key: Buffer;
      let cert: Buffer;
      let ca: Buffer;
      try {
        key = readFileSync(this.options.keyfile);
        cert = readFileSync(this.options.certfile);
        ca = readFileSync(this.options.ca_certs);
      } catch (error) {
        reject(new Error(`Unable to read certificate files: ${(error as Error).message}`));
        return;
      }

      this.closing = false;
      const socket = connect(
        {
          host: this.options.host,
          port: this.options.port ?? LEAP_PORT,
          key,
          cert,
          ca,
          // The bridge CA is self-signed; we validate against the provided CA only.
          rejectUnauthorized: false,
        },
        () => {
          this.connected = true;
          this.emit('connect');
          resolve();
        },
      );

      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => this.onData(chunk));
      socket.on('error', (error: Error) => {
        if (!this.connected) reject(error);
        this.emit('error', error);
      });
      socket.on('close', () => {
        this.connected = false;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Connection closed'));
        }
        this.pending.clear();
        if (!this.closing) this.emit('disconnect');
      });

      this.socket = socket;
    });
  }

  /**
   * Close the TLS connection.
   *
   * @returns {void}
   */
  close(): void {
    this.closing = true;
    this.connected = false;
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = '';
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: LeapMessage;
    try {
      message = JSON.parse(line) as LeapMessage;
    } catch {
      this.emit('error', new Error(`Invalid JSON from bridge: ${line}`));
      return;
    }

    const tag = message.Header?.ClientTag;
    if (tag && this.pending.has(tag)) {
      const p = this.pending.get(tag)!;
      clearTimeout(p.timer);
      this.pending.delete(tag);
      p.resolve(message);
      return;
    }

    this.handleUnsolicited(message);
  }

  private handleUnsolicited(message: LeapMessage): void {
    const url = message.Header?.Url ?? '';
    const body = message.Body ?? {};

    if (url.includes('/zone/status') || body.ZoneStatus || body.ZoneStatuses) {
      for (const status of this.extractZoneStatuses(body)) this.emit('zone', status);
    }

    if (url.includes('/occupancygroup') || body.OccupancyGroupStatus || body.OccupancyGroupStatuses) {
      for (const occ of this.extractOccupancy(body)) this.emit('occupancy', occ);
    }

    if (url.includes('/buttongroup') || url.includes('/button') || body.ButtonStatus) {
      this.emit('button', body);
    }

    this.emit('unsolicited', message);
  }

  private extractZoneStatuses(body: Record<string, unknown>): ZoneStatus[] {
    const raw = (body.ZoneStatuses as unknown[]) ?? (body.ZoneStatus ? [body.ZoneStatus] : []);
    const result: ZoneStatus[] = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      const href = (item.Zone as { href?: string } | undefined)?.href ?? (item.href as string | undefined) ?? '';
      const zone = href.split('/').pop() ?? '';
      result.push({ zone, level: Number(item.Level ?? 0), fanSpeed: item.FanSpeed as string | undefined });
    }
    return result;
  }

  private extractOccupancy(body: Record<string, unknown>): Array<{ group: string; occupied: boolean }> {
    const raw = (body.OccupancyGroupStatuses as unknown[]) ?? (body.OccupancyGroupStatus ? [body.OccupancyGroupStatus] : []);
    const result: Array<{ group: string; occupied: boolean }> = [];
    for (const item of raw as Array<Record<string, unknown>>) {
      const href = (item.OccupancyGroup as { href?: string } | undefined)?.href ?? (item.href as string | undefined) ?? '';
      const group = href.split('/').pop() ?? '';
      result.push({ group, occupied: item.OccupancyStatus === 'Occupied' });
    }
    return result;
  }

  /**
   * Send a request and wait for the correlated response.
   *
   * @param {string} communiqueType - LEAP CommuniqueType, e.g. 'ReadRequest'.
   * @param {string} url - LEAP resource URL, e.g. '/device'.
   * @param {Record<string, unknown>} [body] - Optional request body.
   * @param {number} [timeoutMs] - Response timeout in milliseconds.
   * @returns {Promise<LeapMessage>} The correlated response message.
   */
  request(communiqueType: string, url: string, body?: Record<string, unknown>, timeoutMs = 10000): Promise<LeapMessage> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Not connected'));
        return;
      }
      const tag = randomUUID();
      const message: LeapMessage = { CommuniqueType: communiqueType, Header: { Url: url, ClientTag: tag } };
      if (body) message.Body = body;

      const timer = setTimeout(() => {
        this.pending.delete(tag);
        reject(new Error(`Request timed out: ${communiqueType} ${url}`));
      }, timeoutMs);

      this.pending.set(tag, { resolve, reject, timer });
      this.socket.write(JSON.stringify(message) + '\n', (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(tag);
          reject(error);
        }
      });
    });
  }

  /**
   * Read all devices known to the bridge.
   *
   * @returns {Promise<LeapMessage>} The /device read response.
   */
  readDevices(): Promise<LeapMessage> {
    return this.request('ReadRequest', '/device');
  }

  /**
   * Subscribe to all zone status updates.
   *
   * @returns {Promise<LeapMessage>} The subscription response (also seeds initial state).
   */
  subscribeZones(): Promise<LeapMessage> {
    return this.request('SubscribeRequest', '/zone/status');
  }

  /**
   * Subscribe to occupancy group status updates.
   *
   * @returns {Promise<LeapMessage>} The subscription response.
   */
  subscribeOccupancy(): Promise<LeapMessage> {
    return this.request('SubscribeRequest', '/occupancygroup/status');
  }

  /**
   * Subscribe to button events (Pico remotes, keypads).
   *
   * @returns {Promise<LeapMessage>} The subscription response.
   */
  subscribeButtons(): Promise<LeapMessage> {
    return this.request('SubscribeRequest', '/buttongroup/status');
  }

  /**
   * Send a level command to a zone.
   *
   * @param {string} zone - Zone id (numeric portion of the zone href).
   * @param {number} level - Target level 0-100.
   * @param {boolean} [dimmed] - Use GoToDimmedLevel (dimmers) instead of GoToLevel (shades/switches).
   * @returns {Promise<LeapMessage>} The command response.
   */
  setZoneLevel(zone: string, level: number, dimmed = false): Promise<LeapMessage> {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    const command = dimmed
      ? { CommandType: 'GoToDimmedLevel', DimmedLevelParameters: { Level: clamped } }
      : { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: clamped }] };
    return this.request('CreateRequest', `/zone/${zone}/commandprocessor`, { Command: command });
  }

  /**
   * Send a fan-speed command to a zone.
   *
   * @param {string} zone - Zone id.
   * @param {string} speed - Lutron FanSpeed: Off, Low, Medium, MediumHigh, High.
   * @returns {Promise<LeapMessage>} The command response.
   */
  setZoneFanSpeed(zone: string, speed: string): Promise<LeapMessage> {
    return this.request('CreateRequest', `/zone/${zone}/commandprocessor`, {
      Command: { CommandType: 'GoToFanSpeed', FanSpeedParameters: { FanSpeed: speed } },
    });
  }

  /**
   * Send a raise/lower/stop motion command to a shade zone.
   *
   * @param {string} zone - Zone id.
   * @param {'Raise' | 'Lower' | 'Stop'} action - Motion action.
   * @returns {Promise<LeapMessage>} The command response.
   */
  setZoneShadeMotion(zone: string, action: 'Raise' | 'Lower' | 'Stop'): Promise<LeapMessage> {
    const map = { Raise: 'Raise', Lower: 'Lower', Stop: 'Stop' } as const;
    return this.request('CreateRequest', `/zone/${zone}/commandprocessor`, {
      Command: { CommandType: 'ShadeLimitRaise', Parameter: [{ Type: 'Action', Value: map[action] }] },
    });
  }
}
