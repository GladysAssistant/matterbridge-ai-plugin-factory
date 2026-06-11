/**
 * Minimal AVM FRITZ!Box AHA-HTTP interface client.
 *
 * Implements session login (PBKDF2 / legacy MD5 challenge-response) and the
 * homeautoswitch.lua smart-home commands used by the plugin.
 *
 * @file fritz.ts
 * @license Apache-2.0
 */

import { createHash, pbkdf2Sync } from 'node:crypto';

import { AnsiLogger } from 'matterbridge/logger';
import { XMLParser } from 'fast-xml-parser';

/** Parsed FRITZ!DECT device from getdevicelistinfos. */
export interface FritzDevice {
  ain: string;
  name: string;
  productname: string;
  present: boolean;
  /** On/off switch state. */
  switchOn?: boolean;
  /** Power in mW, energy in Wh, voltage in mV. */
  power?: number;
  energy?: number;
  voltage?: number;
  /** Temperature in 0.1 °C. */
  temperature?: number;
  /** Relative humidity in %. */
  humidity?: number;
  /** Thermostat (hkr): values in 0.5 °C units, valve 0..255. */
  hkr?: { tist: number; tsoll: number; komfort: number; absenk: number; battery?: number; windowOpen: boolean; boost: boolean };
  /** Contact / alert sensor state (true = open / alerted). */
  alert?: boolean;
  /** Dimmable light level 0..255. */
  level?: number;
  /** Color temperature in Kelvin. */
  colorTemperature?: number;
  hasLight?: boolean;
  /** Roller shutter level percentage 0 (open) .. 100 (closed). */
  blind?: number;
}

/** Client for the FRITZ!Box AHA-HTTP smart-home interface. */
export class FritzClient {
  private sid = '0000000000000000';
  private readonly base: string;
  private readonly parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseAttributeValue: false });

  constructor(
    host: string,
    private readonly username: string,
    private readonly password: string,
    private readonly log: AnsiLogger,
  ) {
    const h = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.base = `http://${h}`;
  }

  /** Perform challenge-response login and store the session id. */
  async login(): Promise<void> {
    const info = await this.request(`/login_sid.lua?version=2`);
    const session = this.parser.parse(info).SessionInfo;
    const challenge: string = String(session.Challenge);
    let response: string;
    if (challenge.startsWith('2$')) {
      const [, iter1, salt1, iter2, salt2] = challenge.split('$');
      const hash1 = pbkdf2Sync(this.password, Buffer.from(salt1, 'hex'), Number(iter1), 32, 'sha256');
      const hash2 = pbkdf2Sync(hash1, Buffer.from(salt2, 'hex'), Number(iter2), 32, 'sha256');
      response = `${salt2}$${hash2.toString('hex')}`;
    } else {
      const md5 = createHash('md5')
        .update(Buffer.from(`${challenge}-${this.password}`, 'utf16le'))
        .digest('hex');
      response = `${challenge}-${md5}`;
    }
    const url = `/login_sid.lua?version=2&username=${encodeURIComponent(this.username)}&response=${response}`;
    const auth = this.parser.parse(await this.request(url)).SessionInfo;
    this.sid = String(auth.SID);
    if (this.sid === '0000000000000000') {
      throw new Error('FRITZ!Box authentication failed: check host, username and password.');
    }
    this.log.info(`FRITZ!Box login successful (sid acquired).`);
  }

  /** Fetch and parse the full smart-home device list. */
  async getDeviceList(): Promise<FritzDevice[]> {
    const xml = await this.switchCmd('getdevicelistinfos');
    const root = this.parser.parse(xml);
    const list = root.devicelist?.device;
    if (!list) return [];
    const devices = Array.isArray(list) ? list : [list];
    return devices.map((d) => this.mapDevice(d));
  }

  /** Turn a switch/light on or off. */
  async setSwitch(ain: string, on: boolean): Promise<void> {
    await this.switchCmd(on ? 'setswitchon' : 'setswitchoff', { ain });
  }

  /** Set dimmable light level (0..255). */
  async setLevel(ain: string, level: number): Promise<void> {
    await this.switchCmd('setlevel', { ain, level: String(Math.max(0, Math.min(255, Math.round(level)))) });
  }

  /** Set light color temperature in Kelvin (2700..6500). */
  async setColorTemperature(ain: string, kelvin: number): Promise<void> {
    await this.switchCmd('setcolortemperature', { ain, temperature: String(Math.round(kelvin)), duration: '0' });
  }

  /** Set thermostat target temperature in °C (or 'off'/'on'). */
  async setThermostat(ain: string, celsius: number | 'off' | 'on'): Promise<void> {
    let param: number;
    if (celsius === 'off') param = 253;
    else if (celsius === 'on') param = 254;
    else param = Math.max(16, Math.min(112, Math.round(celsius * 2))); // 0.5 °C units, 8..56 °C
    await this.switchCmd('sethkrtsoll', { ain, param: String(param) });
  }

  /** Set roller shutter level percentage (0 = open .. 100 = closed). */
  async setBlind(ain: string, percentClosed: number): Promise<void> {
    await this.switchCmd('setlevelpercentage', { ain, level: String(Math.max(0, Math.min(100, Math.round(percentClosed)))) });
  }

  private async switchCmd(cmd: string, params: Record<string, string> = {}): Promise<string> {
    const qs = new URLSearchParams({ sid: this.sid, switchcmd: cmd, ...params });
    return this.request(`/webservices/homeautoswitch.lua?${qs.toString()}`);
  }

  private async request(path: string): Promise<string> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw new Error(`FRITZ!Box request failed (${res.status}) for ${path.split('?')[0]}`);
    return res.text();
  }

  private num(v: unknown): number | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }

  private mapDevice(d: Record<string, any>): FritzDevice {
    const dev: FritzDevice = {
      ain: String(d['@_identifier'] ?? '').trim(),
      name: String(d.name ?? 'FRITZ!DECT'),
      productname: String(d['@_productname'] ?? 'FRITZ!DECT'),
      present: String(d['@_present'] ?? d.present) === '1',
    };
    if (d.switch) dev.switchOn = String(d.switch.state) === '1';
    if (d.powermeter) {
      dev.power = this.num(d.powermeter.power); // mW
      dev.energy = this.num(d.powermeter.energy); // Wh
      dev.voltage = this.num(d.powermeter.voltage); // mV
    }
    if (d.temperature) {
      const offset = this.num(d.temperature.offset) ?? 0;
      const c = this.num(d.temperature.celsius);
      if (c !== undefined) dev.temperature = c + offset; // 0.1 °C
    }
    if (d.humidity) dev.humidity = this.num(d.humidity.rel_humidity);
    if (d.alert) dev.alert = String(d.alert.state) === '1';
    if (d.hkr) {
      dev.hkr = {
        tist: this.num(d.hkr.tist) ?? 0,
        tsoll: this.num(d.hkr.tsoll) ?? 0,
        komfort: this.num(d.hkr.komfort) ?? 0,
        absenk: this.num(d.hkr.absenk) ?? 0,
        battery: this.num(d.hkr.battery),
        windowOpen: String(d.hkr.windowopenactiv) === '1',
        boost: String(d.hkr.boostactive) === '1',
      };
    }
    if (d.levelcontrol || d.simpleonoff) {
      dev.hasLight = true;
      dev.level = this.num(d.levelcontrol?.level);
    }
    if (d.colorcontrol) {
      dev.hasLight = true;
      dev.colorTemperature = this.num(d.colorcontrol.temperature);
    }
    if (d.blind) dev.blind = this.num(d.blind.levelpercentage);
    return dev;
  }
}
