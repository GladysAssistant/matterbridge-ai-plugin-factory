/**
 * WiZ Connected local UDP client (port 38899). No cloud.
 *
 * @file wizClient.ts
 * @license Apache-2.0
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

export interface WizPilotParams {
  state?: boolean;
  dimming?: number; // 10..100
  temp?: number; // Kelvin
  r?: number;
  g?: number;
  b?: number;
  sceneId?: number;
  speed?: number;
}

export interface WizPilotResult {
  mac?: string;
  state?: boolean;
  dimming?: number;
  temp?: number;
  r?: number;
  g?: number;
  b?: number;
  sceneId?: number;
  // Smart plug sensors (when supported by firmware)
  power?: number; // mW
  temperature?: number;
}

export interface WizDiscoveredDevice {
  ip: string;
  mac: string;
}

const WIZ_PORT = 38899;
const TIMEOUT_MS = 2000;

/**
 * Send a single JSON command to a WiZ device and await the reply.
 *
 * @param {string} ip - Target device IP.
 * @param {object} payload - JSON-RPC payload (method + params).
 * @returns {Promise<any>} Parsed JSON response.
 */
function sendCommand(ip: string, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const message = Buffer.from(JSON.stringify(payload));
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WiZ timeout for ${ip}`));
    }, TIMEOUT_MS);

    socket.on('message', (msg) => {
      try {
        const json = JSON.parse(msg.toString());
        cleanup();
        resolve(json);
      } catch (error) {
        cleanup();
        reject(error as Error);
      }
    });

    socket.on('error', (error) => {
      cleanup();
      reject(error);
    });

    socket.send(message, 0, message.length, WIZ_PORT, ip, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}

/**
 * Controls a single WiZ light/plug over the local UDP API.
 */
export class WizDevice {
  constructor(public readonly ip: string) {}

  /**
   * Send a setPilot command.
   *
   * @param {WizPilotParams} params - Pilot params.
   * @returns {Promise<boolean>} True on success.
   */
  async setPilot(params: WizPilotParams): Promise<boolean> {
    const res = await sendCommand(this.ip, { method: 'setPilot', params });
    return res?.result?.success === true;
  }

  /**
   * Read the current device state.
   *
   * @returns {Promise<WizPilotResult>} Current pilot state.
   */
  async getPilot(): Promise<WizPilotResult> {
    const res = await sendCommand(this.ip, { method: 'getPilot', params: {} });
    return (res?.result ?? {}) as WizPilotResult;
  }
}

/**
 * Discover WiZ devices via UDP broadcast on the LAN.
 *
 * @param {EventEmitter} [emitter] - Optional emitter for incremental 'device' events.
 * @param {number} [timeoutMs] - How long to listen.
 * @returns {Promise<WizDiscoveredDevice[]>} Discovered devices.
 */
export function discover(emitter?: EventEmitter, timeoutMs = 4000): Promise<WizDiscoveredDevice[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map<string, WizDiscoveredDevice>();
    const payload = Buffer.from(JSON.stringify({ method: 'getPilot', params: {} }));

    socket.on('message', (msg, rinfo) => {
      try {
        const json = JSON.parse(msg.toString());
        const mac = json?.result?.mac;
        if (mac && !found.has(rinfo.address)) {
          const dev = { ip: rinfo.address, mac };
          found.set(rinfo.address, dev);
          emitter?.emit('device', dev);
        }
      } catch {
        /* ignore malformed */
      }
    });

    socket.on('error', () => {
      /* ignore, resolve on timeout */
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(payload, 0, payload.length, WIZ_PORT, '255.255.255.255');
    });

    setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}
