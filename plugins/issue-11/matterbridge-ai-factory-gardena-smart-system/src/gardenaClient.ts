/**
 * Gardena Smart System API client.
 *
 * Handles OAuth2 client-credentials authentication against the Husqvarna
 * Authentication API and exposes the Smart System v2 REST + WebSocket APIs.
 *
 * Docs:
 *   https://developer.husqvarnagroup.cloud/apis/authentication-api
 *   https://developer.husqvarnagroup.cloud/apis/gardena-smart-system-api
 */

import { EventEmitter } from 'node:events';

import WebSocket from 'ws';
import type { AnsiLogger } from 'matterbridge/logger';

const AUTH_URL = 'https://api.authentication.husqvarnagroup.dev/v1/oauth2/token';
const API_BASE = 'https://api.smart.gardena.dev/v2';

export interface GardenaResource {
  id: string;
  type: string;
  relationships?: Record<string, { data: { id: string; type: string } | { id: string; type: string }[] }>;
  attributes?: Record<string, { value: unknown; timestamp?: string } | unknown>;
}

export interface GardenaLocation {
  id: string;
  name: string;
  devices: Map<string, GardenaDevice>;
}

export interface GardenaDevice {
  id: string;
  name: string;
  modelType?: string;
  serial?: string;
  services: Map<string, GardenaResource>; // service id -> resource
  serviceTypes: Set<string>;
}

export type GardenaEvents = {
  ready: [GardenaLocation];
  resource: [GardenaResource];
  error: [Error];
  close: [];
};

export class GardenaClient extends EventEmitter {
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private ws?: WebSocket;
  private wsKeepAlive?: NodeJS.Timeout;
  private wsReconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  public location?: GardenaLocation;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly log: AnsiLogger,
    private readonly preferredLocationId?: string,
  ) {
    super();
  }

  /** Authenticate via OAuth2 client-credentials. */
  async authenticate(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch(AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Husqvarna auth failed: ${res.status} ${res.statusText} ${text}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = json.access_token;
    this.tokenExpiresAt = Date.now() + (json.expires_in - 60) * 1000;
    this.log.debug(`Gardena: token acquired (expires in ${json.expires_in}s)`);
  }

  private async ensureToken(): Promise<string> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this.authenticate();
    }
    return this.accessToken as string;
  }

  private async apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.ensureToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Authorization-Provider': 'husqvarna',
      'X-Api-Key': this.clientId,
      'Content-Type': 'application/vnd.api+json',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    return fetch(`${API_BASE}${path}`, { ...init, headers });
  }

  /** List locations and pick one. */
  async loadLocation(): Promise<GardenaLocation> {
    const res = await this.apiFetch('/locations');
    if (!res.ok) throw new Error(`Gardena /locations: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { data: Array<{ id: string; type: string; attributes: { name: string } }> };
    if (!json.data?.length) throw new Error('Gardena: no locations on this account');
    const picked = this.preferredLocationId
      ? json.data.find((l) => l.id === this.preferredLocationId)
      : json.data[0];
    if (!picked) throw new Error(`Gardena: location ${this.preferredLocationId} not found`);

    // Now get full location detail (with included services).
    const detail = await this.apiFetch(`/locations/${picked.id}`);
    if (!detail.ok) throw new Error(`Gardena /locations/${picked.id}: ${detail.status}`);
    const locJson = (await detail.json()) as {
      data: { id: string; attributes: { name: string } };
      included: GardenaResource[];
    };

    const location: GardenaLocation = {
      id: locJson.data.id,
      name: locJson.data.attributes.name,
      devices: new Map(),
    };

    // First pass: build DEVICE shells
    for (const r of locJson.included ?? []) {
      if (r.type === 'DEVICE') {
        location.devices.set(r.id, { id: r.id, name: r.id, services: new Map(), serviceTypes: new Set() });
      }
    }
    // Second pass: services -> attach to parent device + extract identity from COMMON
    for (const r of locJson.included ?? []) {
      if (r.type === 'DEVICE') continue;
      const parentId = this.findParentDeviceId(r, locJson.included ?? []);
      if (!parentId) continue;
      const dev = location.devices.get(parentId);
      if (!dev) continue;
      dev.services.set(r.id, r);
      dev.serviceTypes.add(r.type);
      if (r.type === 'COMMON') {
        const attrs = (r.attributes ?? {}) as Record<string, { value: unknown }>;
        const name = (attrs.name?.value as string) ?? dev.name;
        const serial = attrs.serial?.value as string | undefined;
        const modelType = attrs.modelType?.value as string | undefined;
        dev.name = name;
        dev.serial = serial;
        dev.modelType = modelType;
      }
    }

    this.location = location;
    return location;
  }

  /** Walk DEVICE relationships to find the device that owns this service. */
  private findParentDeviceId(service: GardenaResource, included: GardenaResource[]): string | undefined {
    for (const r of included) {
      if (r.type !== 'DEVICE') continue;
      const services = r.relationships?.services?.data;
      if (Array.isArray(services) && services.some((s) => s.id === service.id)) return r.id;
    }
    return undefined;
  }

  /** Open a websocket for live updates on the current location. */
  async startWebsocket(): Promise<void> {
    if (!this.location) throw new Error('Call loadLocation() first');
    this.stopped = false;
    await this.openWebsocketOnce();
  }

  private async openWebsocketOnce(): Promise<void> {
    if (this.stopped || !this.location) return;
    const body = JSON.stringify({
      data: {
        type: 'WEBSOCKET',
        attributes: { locationId: this.location.id },
        id: 'does-not-matter',
      },
    });
    const res = await this.apiFetch('/websocket', { method: 'POST', body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gardena /websocket: ${res.status} ${text}`);
    }
    const json = (await res.json()) as { data: { attributes: { url: string; validity: number } } };
    const url = json.data.attributes.url;
    this.log.info(`Gardena: connecting websocket`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.log.info('Gardena: websocket open');
      this.emit('ready', this.location as GardenaLocation);
      // Send a ping every 150s to keep alive (Gardena recommendation).
      this.wsKeepAlive = setInterval(() => {
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }, 150_000);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as GardenaResource;
        if (msg && typeof msg === 'object' && msg.id && msg.type) {
          this.applyResourceUpdate(msg);
          this.emit('resource', msg);
        }
      } catch (e) {
        this.log.debug(`Gardena: bad ws message ${(e as Error).message}`);
      }
    });

    ws.on('error', (err) => {
      this.log.warn(`Gardena: websocket error ${err.message}`);
      this.emit('error', err);
    });

    ws.on('close', (code, reason) => {
      this.log.warn(`Gardena: websocket closed ${code} ${reason.toString()}`);
      if (this.wsKeepAlive) clearInterval(this.wsKeepAlive);
      this.wsKeepAlive = undefined;
      this.emit('close');
      if (!this.stopped) {
        this.wsReconnectTimer = setTimeout(() => {
          this.openWebsocketOnce().catch((e) => this.log.error(`Gardena: reconnect failed ${(e as Error).message}`));
        }, 5_000);
      }
    });
  }

  private applyResourceUpdate(resource: GardenaResource): void {
    if (!this.location) return;
    for (const dev of this.location.devices.values()) {
      if (dev.services.has(resource.id)) {
        const existing = dev.services.get(resource.id) as GardenaResource;
        // Merge attributes
        const merged: GardenaResource = {
          ...existing,
          attributes: { ...(existing.attributes ?? {}), ...(resource.attributes ?? {}) },
        };
        dev.services.set(resource.id, merged);
        return;
      }
    }
  }

  /** Send a control command to a service. */
  async sendCommand(serviceType: string, serviceId: string, command: string, attributes: Record<string, unknown> = {}): Promise<void> {
    const body = JSON.stringify({
      data: {
        type: serviceType,
        id: 'cmd',
        attributes: { command, ...attributes },
      },
    });
    const res = await this.apiFetch(`/command/${serviceId}`, { method: 'PUT', body });
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gardena command ${command} on ${serviceId} failed: ${res.status} ${text}`);
    }
  }

  /** Convenience: turn a POWER_SOCKET on (override start) or off (stop). */
  async setPowerSocket(serviceId: string, on: boolean): Promise<void> {
    if (on) {
      // START_OVERRIDE accepts a duration in seconds. Default 1 hour.
      await this.sendCommand('POWER_SOCKET_CONTROL', serviceId, 'START_OVERRIDE', { seconds: 3600 });
    } else {
      await this.sendCommand('POWER_SOCKET_CONTROL', serviceId, 'STOP_UNTIL_NEXT_TASK');
    }
  }

  shutdown(): void {
    this.stopped = true;
    if (this.wsKeepAlive) clearInterval(this.wsKeepAlive);
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}
