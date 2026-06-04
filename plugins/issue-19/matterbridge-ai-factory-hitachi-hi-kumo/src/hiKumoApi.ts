/**
 * Minimal Hitachi Hi-Kumo (Overkiz cloud) API client.
 *
 * @file hiKumoApi.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';

/** Overkiz server endpoints used by Hi-Kumo accounts. */
export const HI_KUMO_SERVERS: Record<string, string> = {
  europe: 'https://ha110-1.overkiz.com/enduser-mobile-web/enduserAPI',
  oceania: 'https://ha201-1.overkiz.com/enduser-mobile-web/enduserAPI',
  asia: 'https://ha117-1.overkiz.com/enduser-mobile-web/enduserAPI',
};

/** Overkiz operating mode strings for Hitachi air-to-air heat pumps. */
export const OVERKIZ_MODE = {
  auto: 'auto',
  cooling: 'cooling',
  heating: 'heating',
  dehumidify: 'dehumidify',
  frostprotection: 'frostprotection',
} as const;

export type OverkizMode = (typeof OVERKIZ_MODE)[keyof typeof OVERKIZ_MODE];

/** A single state entry returned by the Overkiz API. */
export interface OverkizState {
  name: string;
  value: string | number | boolean;
}

/** A device returned by the Overkiz setup endpoint. */
export interface OverkizDevice {
  deviceURL: string;
  label: string;
  controllableName?: string;
  definition?: { commands?: { commandName: string }[] };
  states?: OverkizState[];
}

/**
 * Lightweight client that authenticates against the Overkiz cloud and exposes
 * the commands required to control a Hitachi Hi-Kumo climate unit.
 */
export class HiKumoApi {
  private readonly base: string;
  private cookie = '';

  /**
   * @param {string} username - Hi-Kumo account user id (email).
   * @param {string} password - Hi-Kumo account password.
   * @param {string} server - Server region key (europe, oceania, asia).
   * @param {AnsiLogger} log - Logger instance.
   */
  constructor(
    private readonly username: string,
    private readonly password: string,
    server: string,
    private readonly log: AnsiLogger,
  ) {
    this.base = HI_KUMO_SERVERS[server] ?? HI_KUMO_SERVERS.europe;
  }

  /** Authenticate and store the session cookie. */
  async login(): Promise<void> {
    const body = new URLSearchParams({ userId: this.username, userPassword: this.password });
    const res = await fetch(`${this.base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Hi-Kumo login failed: ${res.status} ${res.statusText}`);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    this.log.debug('Hi-Kumo login successful');
  }

  /** Fetch all setup devices and keep only the controllable climate units. */
  async getClimateDevices(): Promise<OverkizDevice[]> {
    const res = await fetch(`${this.base}/setup/devices`, { headers: { Cookie: this.cookie } });
    if (!res.ok) throw new Error(`Hi-Kumo getDevices failed: ${res.status} ${res.statusText}`);
    const devices = (await res.json()) as OverkizDevice[];
    return devices.filter(
      (d) => /HitachiAirToAir|AirToAirHeatPump|HeatingSystem/i.test(d.controllableName ?? '') || /climat|clim|hi.?kumo/i.test(d.label),
    );
  }

  /**
   * Execute a single command on a device.
   *
   * @param {string} deviceURL - Target device URL.
   * @param {string} name - Overkiz command name.
   * @param {(string | number)[]} parameters - Command parameters.
   */
  async exec(deviceURL: string, name: string, parameters: (string | number)[] = []): Promise<void> {
    const payload = { label: `matterbridge ${name}`, actions: [{ deviceURL, commands: [{ name, parameters }] }] };
    const res = await fetch(`${this.base}/exec/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Hi-Kumo exec ${name} failed: ${res.status} ${res.statusText}`);
    this.log.debug(`Hi-Kumo exec ${name}(${parameters.join(',')}) on ${deviceURL}`);
  }

  /** Turn the unit on or off. */
  async setOnOff(deviceURL: string, on: boolean): Promise<void> {
    await this.exec(deviceURL, 'setMainOperation', [on ? 'on' : 'off']);
  }

  /** Set the target temperature in Celsius. */
  async setTargetTemperature(deviceURL: string, celsius: number): Promise<void> {
    await this.exec(deviceURL, 'setTargetTemperature', [celsius]);
  }

  /** Set the operating mode. */
  async setMode(deviceURL: string, mode: OverkizMode): Promise<void> {
    if (mode === OVERKIZ_MODE.frostprotection) {
      await this.exec(deviceURL, 'setAutoManuMode', ['auto']);
      return;
    }
    await this.exec(deviceURL, 'setOperatingMode', [mode]);
  }
}
