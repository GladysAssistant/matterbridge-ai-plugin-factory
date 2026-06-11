/**
 * Ecobee cloud API client (OAuth2 ecobee PIN flow + refresh token).
 *
 * @file ecobee.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';

const API_BASE = 'https://api.ecobee.com';

/** Persisted OAuth tokens. */
export interface EcobeeTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

/** Result of an ecobee PIN authorization request. */
export interface EcobeePin {
  pin: string;
  code: string;
  interval: number;
  expiresIn: number;
}

/** A remote room sensor capability reading. */
export interface EcobeeSensorCapability {
  id: string;
  type: string;
  value: string;
}

/** A remote room sensor. */
export interface EcobeeRemoteSensor {
  id: string;
  name: string;
  type: string;
  capability: EcobeeSensorCapability[];
}

/** Thermostat runtime values. */
export interface EcobeeRuntime {
  actualTemperature: number;
  actualHumidity: number;
  desiredHeat: number;
  desiredCool: number;
}

/** Thermostat settings. */
export interface EcobeeSettings {
  hvacMode: string;
  fanMinOnTime: number;
}

/** A thermostat. */
export interface EcobeeThermostat {
  identifier: string;
  name: string;
  brand: string;
  modelNumber: string;
  runtime: EcobeeRuntime;
  settings: EcobeeSettings;
  remoteSensors: EcobeeRemoteSensor[];
}

/** Ecobee HVAC modes. */
export type EcobeeHvacMode = 'heat' | 'cool' | 'auto' | 'off' | 'auxHeatOnly';

/** Ecobee fan modes. */
export type EcobeeFanMode = 'auto' | 'on';

/** Convert Ecobee temperature (Fahrenheit x 10) to Celsius. */
export function fahrenheitTenthsToCelsius(value: number): number {
  return ((value / 10 - 32) * 5) / 9;
}

/** Convert Celsius to Ecobee temperature (Fahrenheit x 10). */
export function celsiusToFahrenheitTenths(celsius: number): number {
  return Math.round((celsius * 9) / 5 + 32) * 10;
}

/**
 * Minimal Ecobee cloud API client.
 */
export class EcobeeClient {
  private readonly apiKey: string;
  private readonly log: AnsiLogger;
  private tokens?: EcobeeTokens;

  /**
   * @param {string} apiKey - The Ecobee application API Key (client_id).
   * @param {AnsiLogger} log - The logger.
   * @param {EcobeeTokens} [tokens] - Previously persisted tokens, if any.
   */
  constructor(apiKey: string, log: AnsiLogger, tokens?: EcobeeTokens) {
    this.apiKey = apiKey;
    this.log = log;
    this.tokens = tokens;
  }

  /**
   * @returns {EcobeeTokens | undefined} The current tokens, if authorized.
   */
  getTokens(): EcobeeTokens | undefined {
    return this.tokens;
  }

  /**
   * @returns {boolean} True if the client has tokens.
   */
  isAuthorized(): boolean {
    return this.tokens !== undefined;
  }

  /**
   * Request a new PIN to authorize the application (ecobee PIN flow step 1).
   *
   * @returns {Promise<EcobeePin>} The PIN the user must enter and the auth code.
   */
  async requestPin(): Promise<EcobeePin> {
    const url = `${API_BASE}/authorize?response_type=ecobeePin&client_id=${encodeURIComponent(this.apiKey)}&scope=smartWrite`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) throw new Error(`requestPin failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { ecobeePin: string; code: string; interval: number; expires_in: number };
    return { pin: data.ecobeePin, code: data.code, interval: data.interval, expiresIn: data.expires_in };
  }

  /**
   * Exchange the auth code for tokens (ecobee PIN flow step 5). Poll until the user enters the PIN.
   *
   * @param {string} code - The auth code from requestPin.
   * @returns {Promise<EcobeeTokens>} The obtained tokens.
   */
  async exchangePin(code: string): Promise<EcobeeTokens> {
    const url = `${API_BASE}/token?grant_type=ecobeePin&code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error(`exchangePin failed: ${res.status} ${await res.text()}`);
    return this.storeTokenResponse(await res.json());
  }

  /**
   * Refresh the access token using the refresh token.
   *
   * @returns {Promise<EcobeeTokens>} The refreshed tokens.
   */
  async refresh(): Promise<EcobeeTokens> {
    if (!this.tokens) throw new Error('Cannot refresh: not authorized');
    const url = `${API_BASE}/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(this.tokens.refreshToken)}&client_id=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error(`refresh failed: ${res.status} ${await res.text()}`);
    return this.storeTokenResponse(await res.json());
  }

  /**
   * Ensure the access token is valid, refreshing it if needed.
   *
   * @returns {Promise<string>} A valid access token.
   */
  async ensureToken(): Promise<string> {
    if (!this.tokens) throw new Error('Not authorized');
    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      this.log.debug('Ecobee access token expired, refreshing...');
      await this.refresh();
    }
    return this.tokens.accessToken;
  }

  /**
   * Fetch all registered thermostats with runtime, settings and remote sensors.
   *
   * @returns {Promise<EcobeeThermostat[]>} The list of thermostats.
   */
  async getThermostats(): Promise<EcobeeThermostat[]> {
    const token = await this.ensureToken();
    const selection = {
      selection: {
        selectionType: 'registered',
        selectionMatch: '',
        includeRuntime: true,
        includeSettings: true,
        includeSensors: true,
      },
    };
    const url = `${API_BASE}/1/thermostat?json=${encodeURIComponent(JSON.stringify(selection))}`;
    const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`getThermostats failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { thermostatList?: EcobeeThermostat[] };
    return data.thermostatList ?? [];
  }

  /**
   * Update thermostat settings (e.g. hvacMode, fanMinOnTime).
   *
   * @param {string} thermostatId - The thermostat identifier.
   * @param {Record<string, unknown>} settings - The settings object to merge.
   * @returns {Promise<void>}
   */
  async updateSettings(thermostatId: string, settings: Record<string, unknown>): Promise<void> {
    await this.post(thermostatId, { thermostat: { settings } });
  }

  /**
   * Set the hold heat/cool setpoints (Fahrenheit x 10).
   *
   * @param {string} thermostatId - The thermostat identifier.
   * @param {number} heatHoldTemp - Heat setpoint in Fahrenheit x 10.
   * @param {number} coolHoldTemp - Cool setpoint in Fahrenheit x 10.
   * @returns {Promise<void>}
   */
  async setHold(thermostatId: string, heatHoldTemp: number, coolHoldTemp: number): Promise<void> {
    await this.post(thermostatId, {
      functions: [
        {
          type: 'setHold',
          params: { holdType: 'nextTransition', heatHoldTemp, coolHoldTemp },
        },
      ],
    });
  }

  /**
   * Set the comfort setting (Home / Away / Sleep climate hold).
   *
   * @param {string} thermostatId - The thermostat identifier.
   * @param {string} climateRef - The climate ref: 'home', 'away' or 'sleep'.
   * @returns {Promise<void>}
   */
  async setClimateHold(thermostatId: string, climateRef: string): Promise<void> {
    await this.post(thermostatId, {
      functions: [
        {
          type: 'setHold',
          params: { holdType: 'nextTransition', holdClimateRef: climateRef },
        },
      ],
    });
  }

  /**
   * Post an update to a single thermostat.
   *
   * @param {string} thermostatId - The thermostat identifier.
   * @param {Record<string, unknown>} body - The request body fragment.
   * @returns {Promise<void>}
   */
  private async post(thermostatId: string, body: Record<string, unknown>): Promise<void> {
    const token = await this.ensureToken();
    const payload = {
      selection: { selectionType: 'thermostats', selectionMatch: thermostatId },
      ...body,
    };
    const res = await fetch(`${API_BASE}/1/thermostat?format=json`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`thermostat update failed: ${res.status} ${await res.text()}`);
  }

  /**
   * Store a token response and compute the expiry.
   *
   * @param {unknown} json - The raw token JSON response.
   * @returns {EcobeeTokens} The stored tokens.
   */
  private storeTokenResponse(json: unknown): EcobeeTokens {
    const data = json as { access_token: string; refresh_token: string; expires_in: number };
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return this.tokens;
  }
}
