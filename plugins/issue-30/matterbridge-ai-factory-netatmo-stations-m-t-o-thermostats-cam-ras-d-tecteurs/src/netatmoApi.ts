/**
 * Netatmo cloud API client with OAuth2 refresh-token rotation.
 *
 * @file netatmoApi.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';

const API = 'https://api.netatmo.com';

/** OAuth2 token set returned by the Netatmo token endpoint. */
export interface NetatmoTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

/** A weather station measurement module (indoor, outdoor, rain, wind, ...). */
export interface NetatmoModule {
  id: string;
  type: string;
  name: string;
  battery?: number;
  data: Record<string, number>;
}

/** A weather station with its modules. */
export interface NetatmoStation {
  id: string;
  name: string;
  modules: NetatmoModule[];
}

/** A heating room with its current state. */
export interface NetatmoRoom {
  id: string;
  homeId: string;
  name: string;
  temperature?: number;
  setpoint?: number;
  mode?: string; // manual | home | off | hg | max
  battery?: number;
}

/** A camera event subject (person / animal / movement). */
export interface NetatmoEvent {
  cameraId: string;
  name: string;
  type: string; // human | animal | movement | ...
  time: number;
}

/**
 * Thin Netatmo REST client. Handles token refresh with rotation and exposes
 * the read/write endpoints required by the plugin.
 */
export class NetatmoApi {
  private tokens: NetatmoTokens;

  /**
   * Creates a Netatmo API client.
   *
   * @param {string} clientId - OAuth2 client id from dev.netatmo.com.
   * @param {string} clientSecret - OAuth2 client secret.
   * @param {NetatmoTokens} tokens - Initial tokens (at least refreshToken).
   * @param {AnsiLogger} log - Logger instance.
   * @param {(t: NetatmoTokens) => void} onTokens - Called whenever tokens rotate so they can be persisted immediately.
   */
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    tokens: NetatmoTokens,
    private readonly log: AnsiLogger,
    private readonly onTokens: (t: NetatmoTokens) => void,
  ) {
    this.tokens = tokens;
  }

  /**
   * Refreshes the access token. Netatmo rotates BOTH access and refresh tokens
   * on every call (since May 2024), so the new refresh token is persisted
   * immediately via the onTokens callback.
   *
   * @returns {Promise<void>} Resolves once tokens are refreshed and persisted.
   */
  async refresh(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    this.tokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    // CRITICAL: persist the rotated refresh token right away.
    this.onTokens(this.tokens);
    this.log.debug('Netatmo tokens refreshed and persisted');
  }

  /**
   * Returns a valid access token, refreshing first if it is missing or near expiry.
   *
   * @returns {Promise<string>} A valid bearer access token.
   */
  private async accessToken(): Promise<string> {
    if (!this.tokens.accessToken || Date.now() > this.tokens.expiresAt - 60_000) {
      await this.refresh();
    }
    return this.tokens.accessToken;
  }

  /**
   * Performs an authenticated GET request to the Netatmo API, retrying once after
   * a token refresh on 401/403.
   *
   * @param {string} path - API path beginning with '/'.
   * @param {Record<string, string>} [params] - Optional query parameters.
   * @returns {Promise<any>} The parsed `body` of the response.
   */
  private async get(path: string, params: Record<string, string> = {}): Promise<any> {
    const url = `${API}${path}?${new URLSearchParams(params).toString()}`;
    let token = await this.accessToken();
    let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) {
      await this.refresh();
      token = this.tokens.accessToken;
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { body: any }).body;
  }

  /**
   * Performs an authenticated POST (form-encoded) request to the Netatmo API.
   *
   * @param {string} path - API path beginning with '/'.
   * @param {Record<string, string>} params - Form body parameters.
   * @returns {Promise<any>} The parsed `body` of the response.
   */
  private async post(path: string, params: Record<string, string>): Promise<any> {
    let token = await this.accessToken();
    const body = new URLSearchParams(params);
    let res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (res.status === 401 || res.status === 403) {
      await this.refresh();
      token = this.tokens.accessToken;
      res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    }
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { body: any }).body;
  }

  /**
   * Fetches all weather stations and their modules with current measurements.
   *
   * @returns {Promise<NetatmoStation[]>} The list of weather stations.
   */
  async getStations(): Promise<NetatmoStation[]> {
    const body = await this.get('/api/getstationsdata', { get_favorites: 'false' });
    const devices: any[] = body?.devices ?? [];
    return devices.map((d) => ({
      id: d._id,
      name: d.station_name ?? d.module_name ?? 'Netatmo Station',
      modules: [
        { id: d._id, type: d.type, name: d.module_name ?? 'Indoor', battery: undefined, data: d.dashboard_data ?? {} },
        ...(d.modules ?? []).map((m: any) => ({
          id: m._id,
          type: m.type,
          name: m.module_name ?? m.type,
          battery: m.battery_percent,
          data: m.dashboard_data ?? {},
        })),
      ],
    }));
  }

  /**
   * Fetches all heating rooms (thermostats / valves) across all homes with their
   * current temperature, setpoint, mode and (where available) valve battery level.
   *
   * @returns {Promise<NetatmoRoom[]>} The list of heating rooms.
   */
  async getRooms(): Promise<NetatmoRoom[]> {
    const homesData = await this.get('/api/homesdata');
    const rooms: NetatmoRoom[] = [];
    for (const home of homesData?.homes ?? []) {
      const roomNames = new Map<string, string>((home.rooms ?? []).map((r: any) => [r.id, r.name]));
      let status: any;
      try {
        status = await this.get('/api/homestatus', { home_id: home.id });
      } catch (e) {
        this.log.debug(`homestatus failed for ${home.id}: ${String(e)}`);
        continue;
      }
      const moduleBattery = new Map<string, number>();
      for (const m of status?.home?.modules ?? []) {
        if (typeof m.battery_level === 'number') moduleBattery.set(m.id, m.battery_level);
      }
      for (const r of status?.home?.rooms ?? []) {
        if (r.therm_setpoint_temperature === undefined && r.therm_measured_temperature === undefined) continue;
        rooms.push({
          id: r.id,
          homeId: home.id,
          name: roomNames.get(r.id) ?? `Room ${r.id}`,
          temperature: r.therm_measured_temperature,
          setpoint: r.therm_setpoint_temperature,
          mode: r.therm_setpoint_mode,
          battery: this.percentFromMv([...moduleBattery.values()][0]),
        });
      }
    }
    return rooms;
  }

  /**
   * Converts a Netatmo valve battery millivolt-ish level into an approximate percent.
   *
   * @param {number | undefined} level - Raw battery_level value, if any.
   * @returns {number | undefined} Approximate battery percentage 0-100, or undefined.
   */
  private percentFromMv(level?: number): number | undefined {
    if (level === undefined) return undefined;
    // Netatmo valve full ~3300mV, low ~2200mV.
    const pct = Math.round(((level - 2200) / (3300 - 2200)) * 100);
    return Math.max(0, Math.min(100, pct));
  }

  /**
   * Sets the heating setpoint for a room.
   *
   * @param {string} homeId - The home id owning the room.
   * @param {string} roomId - The room id to control.
   * @param {string} mode - Netatmo mode: manual | max | off | home.
   * @param {number} [temp] - Target temperature in °C (required for manual).
   * @returns {Promise<void>} Resolves once the setpoint is applied.
   */
  async setRoomSetpoint(homeId: string, roomId: string, mode: string, temp?: number): Promise<void> {
    const params: Record<string, string> = { home_id: homeId, room_id: roomId, mode };
    if (temp !== undefined && mode === 'manual') params.temp = temp.toFixed(1);
    await this.post('/api/setroomthermpoint', params);
  }

  /**
   * Fetches recent camera/home security events (person, animal, movement, ...).
   *
   * @returns {Promise<NetatmoEvent[]>} The list of recent events.
   */
  async getEvents(): Promise<NetatmoEvent[]> {
    const events: NetatmoEvent[] = [];
    try {
      const homesData = await this.get('/api/homesdata');
      for (const home of homesData?.homes ?? []) {
        const status = await this.get('/api/gethomedata', { home_id: home.id }).catch(() => null);
        for (const cam of status?.devices ?? []) {
          for (const ev of cam?.events ?? []) {
            events.push({ cameraId: cam.id ?? home.id, name: cam.name ?? 'Camera', type: ev.type, time: ev.time });
          }
        }
      }
    } catch (e) {
      this.log.debug(`getEvents failed: ${String(e)}`);
    }
    return events;
  }
}
