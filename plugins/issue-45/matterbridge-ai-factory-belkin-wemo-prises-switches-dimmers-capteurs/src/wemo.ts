/**
 * Belkin Wemo local UPnP/SOAP client and SSDP discovery.
 *
 * Pure Node.js (dgram + http), no external dependencies.
 * Local control only (no cloud): SSDP discovery + SOAP on /upnp/control/*.
 *
 * @file wemo.ts
 * @license Apache-2.0
 */

import dgram from 'node:dgram';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_ST = 'urn:Belkin:device:**';

/** Logical Wemo device categories mapped from the UPnP deviceType. */
export type WemoKind = 'switch' | 'insight' | 'dimmer' | 'light' | 'motion' | 'maker' | 'unknown';

export interface WemoInfo {
  ip: string;
  port: number;
  baseUrl: string; // http://ip:port
  deviceType: string;
  friendlyName: string;
  udn: string;
  serialNumber: string;
  macAddress: string;
  modelName: string;
  kind: WemoKind;
}

/** Insight plug live parameters (parsed from GetInsightParams). */
export interface InsightParams {
  state: number; // 0 off, 1 on, 8 standby
  currentPowerMw: number; // instantaneous power in milliwatts
  todayEnergyMwMin: number; // today on energy in mW*minutes
  totalEnergyMwMin: number; // cumulative on energy in mW*minutes
}

function deviceTypeToKind(deviceType: string): WemoKind {
  const t = deviceType.toLowerCase();
  if (t.includes('insight')) return 'insight';
  if (t.includes('dimmer')) return 'dimmer';
  if (t.includes('sensor')) return 'motion';
  if (t.includes('maker')) return 'maker';
  if (t.includes('lightswitch') || t.includes('lightbulb')) return 'light';
  if (t.includes('controllee') || t.includes('socket')) return 'switch';
  return 'unknown';
}

function xmlTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

/** Simple HTTP GET returning the body as string. */
function httpGet(url: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Fetch and parse a Wemo setup.xml description into a WemoInfo. */
export async function fetchDescription(location: string): Promise<WemoInfo> {
  const u = new URL(location);
  const xml = await httpGet(location);
  const deviceType = xmlTag(xml, 'deviceType');
  return {
    ip: u.hostname,
    port: Number(u.port) || 49153,
    baseUrl: `http://${u.hostname}:${u.port || 49153}`,
    deviceType,
    friendlyName: xmlTag(xml, 'friendlyName') || 'Wemo Device',
    udn: xmlTag(xml, 'UDN'),
    serialNumber: xmlTag(xml, 'serialNumber') || xmlTag(xml, 'UDN').replace(/^uuid:/, ''),
    macAddress: xmlTag(xml, 'macAddress'),
    modelName: xmlTag(xml, 'modelName') || 'Wemo',
    kind: deviceTypeToKind(deviceType),
  };
}

/** SSDP multicast discovery of Belkin Wemo devices. */
export function discover(timeoutMs = 5000): Promise<WemoInfo[]> {
  return new Promise((resolve) => {
    const found = new Map<string, WemoInfo>();
    const pending: Promise<void>[] = [];
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const message = Buffer.from(
      ['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 3', `ST: ${SSDP_ST}`, '', ''].join('\r\n'),
    );

    socket.on('message', (msg) => {
      const text = msg.toString();
      const loc = /LOCATION:\s*(.*)/i.exec(text);
      if (!loc) return;
      const location = loc[1].trim();
      if (found.has(location)) return;
      found.set(location, {} as WemoInfo);
      pending.push(
        fetchDescription(location)
          .then((info) => {
            found.set(location, info);
          })
          .catch(() => {
            found.delete(location);
          }),
      );
    });

    socket.on('error', () => {
      /* ignore */
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
        socket.send(message, 0, message.length, SSDP_PORT, SSDP_ADDR);
      } catch {
        /* ignore */
      }
    });

    setTimeout(async () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      await Promise.allSettled(pending);
      resolve([...found.values()].filter((i) => i.udn));
    }, timeoutMs);
  });
}

/** Controls a single Wemo device over local SOAP. Emits 'binaryState' and 'insight'. */
export class WemoDevice extends EventEmitter {
  constructor(public info: WemoInfo) {
    super();
  }

  private soap(service: string, controlPath: string, action: string, args: Record<string, string | number> = {}): Promise<string> {
    const argXml = Object.entries(args)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('');
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body><u:${action} xmlns:u="${service}">${argXml}</u:${action}></s:Body></s:Envelope>`;

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.info.ip,
          port: this.info.port,
          path: controlPath,
          method: 'POST',
          timeout: 4000,
          headers: {
            'Content-Type': 'text/xml; charset="utf-8"',
            SOAPACTION: `"${service}#${action}"`,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private basicevent(action: string, args?: Record<string, string | number>): Promise<string> {
    return this.soap('urn:Belkin:service:basicevent:1', '/upnp/control/basicevent1', action, args);
  }

  private insight(action: string, args?: Record<string, string | number>): Promise<string> {
    return this.soap('urn:Belkin:service:insight:1', '/upnp/control/insight1', action, args);
  }

  /** Read on/off state. Returns true if on (BinaryState !== 0). */
  async getBinaryState(): Promise<boolean> {
    const res = await this.basicevent('GetBinaryState');
    const v = xmlTag(res, 'BinaryState');
    const on = v !== '' && v.split('|')[0] !== '0';
    this.emit('binaryState', on);
    return on;
  }

  /** Set on/off state. */
  async setBinaryState(on: boolean): Promise<void> {
    await this.basicevent('SetBinaryState', { BinaryState: on ? 1 : 0 });
    this.emit('binaryState', on);
  }

  /** Set dimmer brightness 0..100 (also turns device on/off). */
  async setBrightness(level0to100: number): Promise<void> {
    const b = Math.max(0, Math.min(100, Math.round(level0to100)));
    await this.basicevent('SetBinaryState', { BinaryState: b > 0 ? 1 : 0, brightness: b });
  }

  /** Read dimmer brightness 0..100. */
  async getBrightness(): Promise<number> {
    const res = await this.basicevent('GetBinaryState');
    const b = Number(xmlTag(res, 'brightness'));
    return Number.isFinite(b) ? b : 0;
  }

  /** Read Insight power/energy parameters. */
  async getInsightParams(): Promise<InsightParams> {
    const res = await this.insight('GetInsightParams');
    const raw = xmlTag(res, 'InsightParams');
    const p = raw.split('|');
    const params: InsightParams = {
      state: Number(p[0]) || 0,
      currentPowerMw: Number(p[7]) || 0,
      todayEnergyMwMin: Number(p[8]) || 0,
      totalEnergyMwMin: Number(p[9]) || 0,
    };
    this.emit('insight', params);
    this.emit('binaryState', params.state === 1);
    return params;
  }
}
