/**
 * Smappee Developer API v3 client.
 *
 * Docs: https://smappee.atlassian.net/wiki/spaces/DEVAPI/overview
 *
 * @file smappee.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';

const BASE = 'https://app1pub.smappee.net/dev/v3';

export interface SmappeeConfig {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

export interface SmappeeServiceLocation {
  serviceLocationId: number;
  name: string;
}

export interface SmappeeActuator {
  id: number;
  name: string;
  serialNumber?: string;
  type?: string;
}

export interface SmappeeMeasurement {
  id: number;
  name: string;
  type?: string;
}

export interface SmappeeSensor {
  id: number;
  name: string;
}

export interface SmappeeMeteringConfiguration {
  serviceLocationId: number;
  name: string;
  actuators: SmappeeActuator[];
  measurements: SmappeeMeasurement[];
  sensors: SmappeeSensor[];
}

export interface SmappeeConsumptionRecord {
  timestamp: number;
  consumption?: number;
  solar?: number;
  alwaysOn?: number;
  active?: number;
}

/** Minimal Smappee OAuth2 + REST client. */
export class SmappeeApi {
  private accessToken = '';
  private refreshToken = '';
  private expiresAt = 0;

  constructor(
    private readonly config: SmappeeConfig,
    private readonly log: AnsiLogger,
  ) {}

  /**
   * Authenticate against the Smappee OAuth2 endpoint using the password grant.
   *
   * @returns {Promise<void>} Resolves once a valid access token is stored.
   */
  async authenticate(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      username: this.config.username,
      password: this.config.password,
    });
    const json = await this.tokenRequest(body);
    this.storeToken(json);
    this.log.info('Smappee authentication successful');
  }

  private async tokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Smappee token request failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as Record<string, unknown>;
  }

  private storeToken(json: Record<string, unknown>): void {
    this.accessToken = String(json.access_token ?? '');
    this.refreshToken = String(json.refresh_token ?? '');
    const expiresIn = Number(json.expires_in ?? 3600);
    this.expiresAt = Date.now() + expiresIn * 1000;
  }

  private async ensureToken(): Promise<void> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return;
    if (this.refreshToken) {
      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        });
        this.storeToken(await this.tokenRequest(body));
        return;
      } catch {
        this.log.warn('Smappee token refresh failed, re-authenticating');
      }
    }
    await this.authenticate();
  }

  private async get<T>(path: string): Promise<T> {
    await this.ensureToken();
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (!res.ok) throw new Error(`Smappee GET ${path} failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  private async post(path: string, body: unknown): Promise<void> {
    await this.ensureToken();
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Smappee POST ${path} failed: ${res.status} ${res.statusText}`);
  }

  /**
   * List the service locations available to the authenticated user.
   *
   * @returns {Promise<SmappeeServiceLocation[]>} The service locations.
   */
  async getServiceLocations(): Promise<SmappeeServiceLocation[]> {
    const json = await this.get<{ serviceLocations?: SmappeeServiceLocation[] }>('/servicelocation');
    return json.serviceLocations ?? [];
  }

  /**
   * Get the metering configuration (actuators, measurements, sensors) of a service location.
   *
   * @param {number} serviceLocationId - The service location id.
   * @returns {Promise<SmappeeMeteringConfiguration>} The metering configuration.
   */
  async getMeteringConfiguration(serviceLocationId: number): Promise<SmappeeMeteringConfiguration> {
    const json = await this.get<Partial<SmappeeMeteringConfiguration>>(`/servicelocation/${serviceLocationId}/meteringconfiguration`);
    return {
      serviceLocationId,
      name: json.name ?? `Service Location ${serviceLocationId}`,
      actuators: json.actuators ?? [],
      measurements: json.measurements ?? [],
      sensors: json.sensors ?? [],
    };
  }

  /**
   * Get the electricity consumption for a service location.
   *
   * @param {number} serviceLocationId - The service location id.
   * @param {number} from - Start time in epoch milliseconds.
   * @param {number} to - End time in epoch milliseconds.
   * @param {number} aggregation - Aggregation level (1=5min, 2=hourly, 3=daily, 4=monthly, 5=quarterly).
   * @returns {Promise<SmappeeConsumptionRecord[]>} The consumption records.
   */
  async getElectricityConsumption(serviceLocationId: number, from: number, to: number, aggregation = 1): Promise<SmappeeConsumptionRecord[]> {
    const json = await this.get<{ consumptions?: SmappeeConsumptionRecord[] }>(
      `/servicelocation/${serviceLocationId}/consumption?aggregation=${aggregation}&from=${from}&to=${to}`,
    );
    return json.consumptions ?? [];
  }

  /**
   * Get the consumption recorded by a Smappee switch (Comfort Plug / Output module).
   *
   * @param {number} serviceLocationId - The service location id.
   * @param {number} switchId - The switch (actuator) id.
   * @param {number} from - Start time in epoch milliseconds.
   * @param {number} to - End time in epoch milliseconds.
   * @param {number} aggregation - Aggregation level.
   * @returns {Promise<SmappeeConsumptionRecord[]>} The consumption records.
   */
  async getSwitchConsumption(serviceLocationId: number, switchId: number, from: number, to: number, aggregation = 1): Promise<SmappeeConsumptionRecord[]> {
    const json = await this.get<{ records?: SmappeeConsumptionRecord[] }>(
      `/servicelocation/${serviceLocationId}/switch/${switchId}/consumption?aggregation=${aggregation}&from=${from}&to=${to}`,
    );
    return json.records ?? [];
  }

  /**
   * Get the consumption recorded by a Smappee sensor (gas / water / external).
   *
   * @param {number} serviceLocationId - The service location id.
   * @param {number} sensorId - The sensor id.
   * @param {number} from - Start time in epoch milliseconds.
   * @param {number} to - End time in epoch milliseconds.
   * @param {number} aggregation - Aggregation level.
   * @returns {Promise<SmappeeConsumptionRecord[]>} The consumption records.
   */
  async getSensorConsumption(serviceLocationId: number, sensorId: number, from: number, to: number, aggregation = 1): Promise<SmappeeConsumptionRecord[]> {
    const json = await this.get<{ records?: SmappeeConsumptionRecord[] }>(
      `/servicelocation/${serviceLocationId}/sensor/${sensorId}/consumption?aggregation=${aggregation}&from=${from}&to=${to}`,
    );
    return json.records ?? [];
  }

  /**
   * Turn a Smappee actuator on or off.
   *
   * @param {number} serviceLocationId - The service location id.
   * @param {number} actuatorId - The actuator id.
   * @param {boolean} on - True to turn on, false to turn off.
   * @param {number} [duration] - Optional duration in minutes (300=5min, 900=15min, 3600=1h). Omit for indefinite.
   * @returns {Promise<void>} Resolves once the command has been accepted.
   */
  async setActuator(serviceLocationId: number, actuatorId: number, on: boolean, duration?: number): Promise<void> {
    await this.post(`/servicelocation/${serviceLocationId}/actuator/${actuatorId}/${on ? 'on' : 'off'}`, duration ? { duration } : {});
  }
}
