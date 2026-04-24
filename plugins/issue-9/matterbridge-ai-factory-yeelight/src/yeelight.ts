/**
 * Yeelight LAN control client.
 *
 * Implements a minimal subset of the Yeelight Inter-Operation Spec needed to
 * drive the lights from Matter:
 * - set_power on|off
 * - set_bright 1..100
 * - set_ct_abx 1700..6500 (kelvin)
 * - set_rgb  0..0xFFFFFF
 * - set_hsv  hue 0..359, sat 0..100
 *
 * Connects over TCP port 55443, each JSON-RPC message is terminated with \r\n.
 */

import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';

/** Yeelight device state snapshot. */
export interface YeelightState {
  power: boolean;
  bright: number; // 1..100
  ct: number; // 1700..6500 kelvin
  rgb: number; // 0..0xFFFFFF
  hue: number; // 0..359
  sat: number; // 0..100
  colorMode: 1 | 2 | 3; // 1=rgb, 2=ct, 3=hsv
}

/** Event map emitted by {@link YeelightClient}. */
export interface YeelightClientEvents {
  connect: [];
  disconnect: [];
  error: [Error];
  update: [Partial<YeelightState>];
}

/**
 * TCP client that speaks the Yeelight LAN JSON-RPC protocol.
 * Automatically reconnects on socket errors.
 */
export class YeelightClient extends EventEmitter<YeelightClientEvents> {
  private socket?: Socket;
  private buffer = '';
  private messageId = 1;
  private reconnectTimer?: NodeJS.Timeout;
  private closed = false;
  private connected = false;

  /**
   * @param host Device IP/hostname.
   * @param port TCP port, default 55443.
   */
  constructor(
    public readonly host: string,
    public readonly port: number = 55443,
  ) {
    super();
  }

  /** Open the TCP connection. */
  connect(): void {
    if (this.socket || this.closed) return;
    const s = createConnection({ host: this.host, port: this.port });
    this.socket = s;

    s.on('connect', () => {
      this.connected = true;
      this.emit('connect');
      // Ask for current state after connection.
      void this.send('get_prop', ['power', 'bright', 'ct', 'rgb', 'hue', 'sat', 'color_mode']).catch(() => {});
    });

    s.on('data', (chunk) => this.onData(chunk));

    s.on('error', (err) => {
      this.emit('error', err);
    });

    s.on('close', () => {
      this.connected = false;
      this.socket = undefined;
      this.emit('disconnect');
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 5000);
  }

  /** Close socket and stop reconnecting. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.destroy();
    this.socket = undefined;
  }

  /** Whether the TCP socket is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 2);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // ignore malformed frames
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Notifications from the device: { method: "props", params: {...} }
    if (msg.method === 'props' && msg.params && typeof msg.params === 'object') {
      const params = msg.params as Record<string, unknown>;
      const update: Partial<YeelightState> = {};
      if ('power' in params) update.power = params.power === 'on';
      if ('bright' in params) update.bright = Number(params.bright);
      if ('ct' in params) update.ct = Number(params.ct);
      if ('rgb' in params) update.rgb = Number(params.rgb);
      if ('hue' in params) update.hue = Number(params.hue);
      if ('sat' in params) update.sat = Number(params.sat);
      if ('color_mode' in params) update.colorMode = Number(params.color_mode) as 1 | 2 | 3;
      this.emit('update', update);
      return;
    }
    // Responses to get_prop: { id, result: [...] }
    if (typeof msg.id === 'number' && Array.isArray(msg.result)) {
      const r = msg.result as string[];
      // We issue the same fixed property list on connect.
      const update: Partial<YeelightState> = {
        power: r[0] === 'on',
        bright: Number(r[1]),
        ct: Number(r[2]),
        rgb: Number(r[3]),
        hue: Number(r[4]),
        sat: Number(r[5]),
        colorMode: Number(r[6]) as 1 | 2 | 3,
      };
      this.emit('update', update);
    }
  }

  /** Send a raw JSON-RPC command to the device. */
  send(method: string, params: Array<string | number>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('not connected'));
        return;
      }
      const payload = JSON.stringify({ id: this.messageId++, method, params }) + '\r\n';
      this.socket.write(payload, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Turn the light on or off with a smooth transition. */
  setPower(on: boolean, durationMs = 300): Promise<void> {
    return this.send('set_power', [on ? 'on' : 'off', 'smooth', durationMs]);
  }

  /** Set brightness (1..100). */
  setBrightness(value: number, durationMs = 300): Promise<void> {
    const v = Math.max(1, Math.min(100, Math.round(value)));
    return this.send('set_bright', [v, 'smooth', durationMs]);
  }

  /** Set color temperature in Kelvin (1700..6500). */
  setColorTemperature(kelvin: number, durationMs = 300): Promise<void> {
    const v = Math.max(1700, Math.min(6500, Math.round(kelvin)));
    return this.send('set_ct_abx', [v, 'smooth', durationMs]);
  }

  /** Set RGB color (0..0xFFFFFF). */
  setRgb(rgb: number, durationMs = 300): Promise<void> {
    const v = Math.max(1, Math.min(0xffffff, Math.round(rgb)));
    return this.send('set_rgb', [v, 'smooth', durationMs]);
  }

  /** Set HSV color. hue 0..359, sat 0..100. */
  setHsv(hue: number, sat: number, durationMs = 300): Promise<void> {
    const h = Math.max(0, Math.min(359, Math.round(hue)));
    const s = Math.max(0, Math.min(100, Math.round(sat)));
    return this.send('set_hsv', [h, s, 'smooth', durationMs]);
  }
}

/** Pack separate R, G, B bytes into a single Yeelight RGB integer. */
export function rgbToInt(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}
