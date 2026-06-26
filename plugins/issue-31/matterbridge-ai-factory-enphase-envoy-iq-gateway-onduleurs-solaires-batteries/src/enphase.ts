/**
 * Enphase Envoy / IQ Gateway local API client.
 *
 * Handles Enlighten cloud token authentication (firmware >= 7.0) and read-only
 * polling of the local Envoy endpoints over HTTPS (self-signed certificate).
 *
 * @file enphase.ts
 * @license Apache-2.0
 */

import { Agent, request } from 'node:https';
import { AnsiLogger } from 'matterbridge/logger';

/** Parsed snapshot of the values exposed by the Envoy local API. */
export interface EnvoyData {
  /** Instantaneous production power in watts. */
  productionPowerW: number;
  /** Energy produced today in watt-hours. */
  productionTodayWh: number;
  /** Lifetime energy produced in watt-hours. */
  productionLifetimeWh: number;
  /** Per micro-inverter production power in watts (empty if not exposed). */
  inverters: { serial: string; powerW: number }[];
  /** Net grid power in watts (positive = import, negative = export). */
  consumptionNetPowerW: number;
  /** Total consumption power in watts. */
  consumptionTotalPowerW: number;
  /** Net energy in watt-hours. */
  consumptionNetWh: number;
  /** Battery state of charge in percent, or null when no battery. */
  batterySoc: number | null;
  /** Battery power in watts (positive = charging, negative = discharging). */
  batteryPowerW: number | null;
  /** Gateway temperature in celsius, or null when unavailable. */
  gatewayTempC: number | null;
  /** Network/grid connectivity status. */
  networkUp: boolean;
}

/** Configuration required to talk to the Envoy and the Enlighten cloud. */
export interface EnphaseClientOptions {
  envoyIp: string;
  serialNumber: string;
  enlightenEmail?: string;
  enlightenPassword?: string;
  token?: string;
  installerUser?: boolean;
}

interface HttpResult {
  status: number;
  body: string;
}

const httpsAgent = new Agent({ rejectUnauthorized: false, keepAlive: true });

/** Minimal promise-based HTTPS request that tolerates self-signed certificates. */
function httpsRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? 'GET', headers: options.headers, agent: httpsAgent, timeout: 15000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Read-only client for a single Envoy / IQ Gateway. */
export class EnphaseClient {
  private token: string | undefined;

  constructor(
    private readonly options: EnphaseClientOptions,
    private readonly log: AnsiLogger,
  ) {
    this.token = options.token;
  }

  /**
   * Obtain a JWT token from the Enlighten cloud (firmware >= 7.0).
   *
   * @returns {Promise<string>} The bearer token used for local API calls.
   */
  async authenticate(): Promise<string> {
    if (this.options.installerUser) return '';
    if (this.token) return this.token;
    const { enlightenEmail, enlightenPassword } = this.options;
    if (!enlightenEmail || !enlightenPassword) throw new Error('Enlighten email/password or a token is required for firmware >= 7.0');

    // The Enlighten token must be scoped to the gateway's real serial number, otherwise
    // every local API call returns 401. Discover it from the unauthenticated /info.xml when
    // the user did not configure one (the "envoy" placeholder produces an invalid token).
    const serialNumber = await this.resolveSerialNumber();

    // Step 1: login to Enlighten to retrieve a session id.
    const loginBody = `user[email]=${encodeURIComponent(enlightenEmail)}&user[password]=${encodeURIComponent(enlightenPassword)}`;
    const login = await httpsRequest('https://enlighten.enphaseenergy.com/login/login.json?', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: loginBody,
    });
    const sessionId = (JSON.parse(login.body) as { session_id?: string }).session_id;
    if (!sessionId) throw new Error('Enlighten login failed: no session_id returned');

    // Step 2: exchange the session for a JWT token scoped to this Envoy serial.
    const tokenRes = await httpsRequest('https://entrez.enphaseenergy.com/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, serial_num: serialNumber, username: enlightenEmail }),
    });
    const token = tokenRes.body.trim();
    if (!token || token.length < 20) throw new Error('Failed to obtain Enlighten token');
    this.token = token;
    this.log.info('Obtained Enlighten JWT token for the Envoy gateway');
    return token;
  }

  /**
   * Resolve the gateway serial number, discovering it from the unauthenticated
   * /info.xml endpoint when it is missing or set to the "envoy" placeholder.
   *
   * @returns {Promise<string>} The serial number to scope the Enlighten token to.
   */
  private async resolveSerialNumber(): Promise<string> {
    const configured = this.options.serialNumber;
    if (configured && configured !== 'envoy') return configured;
    try {
      const res = await httpsRequest(`https://${this.options.envoyIp}/info.xml`);
      const match = /<sn>([^<]+)<\/sn>/i.exec(res.body);
      if (match?.[1]) {
        this.log.info(`Discovered Envoy serial number ${match[1]} from /info.xml`);
        return match[1].trim();
      }
    } catch (error) {
      this.log.debug(`Failed to read /info.xml for serial discovery: ${(error as Error).message}`);
    }
    throw new Error('Envoy serial number is required: set "serialNumber" in the configuration');
  }

  /** Authorization header for local API calls. */
  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /** GET a JSON local endpoint, returning undefined on any failure. */
  private async getJson<T>(path: string): Promise<T | undefined> {
    try {
      const res = await httpsRequest(`https://${this.options.envoyIp}${path}`, { headers: this.authHeaders() });
      if (res.status === 401) {
        this.log.warn(`Local API returned 401 for ${path}; token may be expired`);
        return undefined;
      }
      if (res.status >= 400) {
        this.log.debug(`Local API ${path} returned status ${res.status}`);
        return undefined;
      }
      return JSON.parse(res.body) as T;
    } catch (error) {
      this.log.debug(`Local API ${path} failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * Poll the Envoy and return a normalized snapshot. Missing values default to 0/null.
   *
   * @returns {Promise<EnvoyData>} The latest data read from the gateway.
   */
  async poll(): Promise<EnvoyData> {
    const data: EnvoyData = {
      productionPowerW: 0,
      productionTodayWh: 0,
      productionLifetimeWh: 0,
      inverters: [],
      consumptionNetPowerW: 0,
      consumptionTotalPowerW: 0,
      consumptionNetWh: 0,
      batterySoc: null,
      batteryPowerW: null,
      gatewayTempC: null,
      networkUp: false,
    };

    const production = await this.getJson<EnvoyProductionJson>('/production.json?details=1');
    if (production) {
      const entries = production.production ?? [];
      // The "eim" entry is only populated when a production CT meter is installed (activeCount > 0).
      // Without it, eim reports wNow/whLifetime as 0, so fall back to the "inverters" entry which
      // always carries the real micro-inverter production totals. Picking eim blindly yields 0 kWh.
      const eim = entries.find((p) => p.type === 'eim');
      const inverters = entries.find((p) => p.type === 'inverters');
      const prod = eim && num(eim.activeCount) > 0 ? eim : (inverters ?? eim);
      if (prod) {
        data.productionPowerW = num(prod.wNow);
        data.productionTodayWh = num(prod.whToday);
        data.productionLifetimeWh = num(prod.whLifetime);
      }
      const net = (production.consumption ?? []).find((c) => c.measurementType === 'net-consumption');
      const total = (production.consumption ?? []).find((c) => c.measurementType === 'total-consumption');
      if (net) {
        data.consumptionNetPowerW = num(net.wNow);
        data.consumptionNetWh = num(net.whLifetime);
      }
      if (total) data.consumptionTotalPowerW = num(total.wNow);
      const storage = (production.storage ?? [])[0];
      if (storage) {
        data.batterySoc = num(storage.percentFull);
        data.batteryPowerW = num(storage.wNow);
      }
    }

    // Per micro-inverter production (best effort).
    const inverters = await this.getJson<{ serialNumber: string; lastReportWatts: number }[]>('/api/v1/production/inverters');
    if (Array.isArray(inverters)) {
      data.inverters = inverters.map((i) => ({ serial: String(i.serialNumber), powerW: num(i.lastReportWatts) }));
    }

    // Live data for battery and grid status (best effort).
    const live = await this.getJson<EnvoyLiveData>('/ivp/livedata/status');
    if (live) {
      if (live.meters?.soc !== undefined) data.batterySoc = num(live.meters.soc);
      if (live.meters?.storage?.agg_p_mw !== undefined) data.batteryPowerW = num(live.meters.storage.agg_p_mw) / 1000;
      if (live.connection?.sc_stream === 'enabled' || live.connection?.mqtt_state === 'connected') data.networkUp = true;
    }

    // Home/gateway info for temperature and network status (best effort).
    const home = await this.getJson<EnvoyHomeJson>('/home.json');
    if (home) {
      if (home.network?.web_comm === true || home.network?.ethernet?.carrier === true) data.networkUp = true;
      if (typeof home.network?.interfaces?.[0]?.carrier === 'boolean') data.networkUp = data.networkUp || home.network.interfaces[0].carrier;
      if (typeof home.cpld_temperature === 'number') data.gatewayTempC = home.cpld_temperature;
    }

    return data;
  }
}

/** Coerce an unknown numeric value to a finite number, defaulting to 0. */
function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface EnvoyProductionEntry {
  type?: string;
  measurementType?: string;
  wNow?: number;
  whToday?: number;
  whLifetime?: number;
  activeCount?: number;
  percentFull?: number;
}

interface EnvoyProductionJson {
  production?: EnvoyProductionEntry[];
  consumption?: EnvoyProductionEntry[];
  storage?: EnvoyProductionEntry[];
}

interface EnvoyLiveData {
  connection?: { mqtt_state?: string; sc_stream?: string };
  meters?: { soc?: number; storage?: { agg_p_mw?: number } };
}

interface EnvoyHomeJson {
  cpld_temperature?: number;
  network?: {
    web_comm?: boolean;
    ethernet?: { carrier?: boolean };
    interfaces?: { carrier?: boolean }[];
  };
}
