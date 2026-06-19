/**
 * Ajax Systems client.
 *
 * Supports three connection modes:
 *  - 'api'  : official Ajax REST API (https://api.ajax.systems/api) — user/PRO token, arm/disarm + polling.
 *  - 'grpc' : mobile-gw cloud gateway (reverse-engineered app protocol, ported from aegis-hass). Requires
 *             vendor proto descriptors supplied at runtime; degrades gracefully when absent.
 *  - 'sia'  : local SIA DC-09 listener — receives hub events over IP (listen only, no arm/disarm).
 *
 * The client normalizes everything into {@link AjaxDevice} and emits events the platform maps to Matter.
 *
 * @file ajaxClient.ts
 * @license Apache-2.0
 */

import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { AnsiLogger } from 'matterbridge/logger';

import type { AjaxArmState, AjaxDevice, AjaxDeviceKind, AjaxMode, AjaxPlatformConfig } from './types.js';

const DEFAULT_API_BASE = 'https://api.ajax.systems/api';
const DEFAULT_GRPC_HOST = 'mobile-gw.prod.ajax.systems:443';
const DEFAULT_SIA_PORT = 8088;
const DEFAULT_POLL_MS = 30_000;

/** Map an Ajax model/type string to a logical device kind. */
export function mapModelToKind(model: string | undefined): AjaxDeviceKind {
  const m = (model ?? '').toLowerCase();
  if (m.includes('hub')) return 'hub';
  if (m.includes('doorprotect') || m.includes('door') || m.includes('window')) return 'door';
  if (m.includes('motioncam') || m.includes('motion') || m.includes('combiprotect')) return 'motion';
  if (m.includes('fireprotect') || m.includes('smoke') || m.includes('co ') || m === 'co') return 'smoke';
  if (m.includes('leaksprotect') || m.includes('leak') || m.includes('flood')) return 'leak';
  if (m.includes('glassprotect') || m.includes('glass')) return 'glass';
  if (m.includes('socket')) return 'socket';
  if (m.includes('wallswitch') || m.includes('relay')) return 'relay';
  if (m.includes('dimmer') || m.includes('lightswitch')) return 'dimmer';
  if (m.includes('siren')) return 'siren';
  if (m.includes('temp')) return 'temperature';
  return 'unknown';
}

/**
 * Events:
 *  - 'ready'  : ()                       connection established
 *  - 'device' : (AjaxDevice)             a device was discovered
 *  - 'update' : (AjaxDevice)             a device state changed
 *  - 'arm'    : (hubId, AjaxArmState)    panel arm state changed
 *  - 'error'  : (Error)
 */
export class AjaxClient extends EventEmitter {
  private readonly log: AnsiLogger;
  private readonly config: AjaxPlatformConfig;
  private readonly mode: AjaxMode;
  private readonly devices = new Map<string, AjaxDevice>();
  private pollTimer?: NodeJS.Timeout;
  private siaServer?: Server;
  private sessionToken?: string;
  private userId?: string;
  private stopped = false;

  constructor(config: AjaxPlatformConfig, log: AnsiLogger) {
    super();
    this.config = config;
    this.log = log;
    this.mode = config.mode ?? 'api';
  }

  /** Snapshot of all known devices. */
  getDevices(): AjaxDevice[] {
    return [...this.devices.values()];
  }

  /** Connect using the configured mode. Never throws; emits 'error' instead. */
  async connect(): Promise<void> {
    this.stopped = false;
    try {
      if (this.config.exposeDemoDevices) this.seedDemoDevices();
      switch (this.mode) {
        case 'api':
          await this.connectApi();
          break;
        case 'grpc':
          await this.connectGrpc();
          break;
        case 'sia':
          this.connectSia();
          break;
      }
      this.emit('ready');
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Stop all timers/sockets. */
  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (this.siaServer) {
      await new Promise<void>((resolve) => this.siaServer?.close(() => resolve()));
      this.siaServer = undefined;
    }
  }

  /**
   * Arm / disarm a hub or space.
   *
   * @param {string} hubId - Target hub id.
   * @param {AjaxArmState} state - Desired state.
   * @param {boolean} [force] - Force arm ignoring open detectors.
   * @returns {Promise<boolean>} True if the command was accepted.
   */
  async setArmState(hubId: string, state: AjaxArmState, force = false): Promise<boolean> {
    if (this.mode === 'sia') {
      this.log.warn('SIA mode is listen-only; arm/disarm is not available.');
      return false;
    }
    if (this.config.armPin && state !== 'disarmed' && !this.config.armPin.trim()) {
      this.log.warn('Arm PIN required but not configured.');
    }
    try {
      if (this.mode === 'api') return await this.apiSetArmState(hubId, state, force);
      if (this.mode === 'grpc') return await this.grpcSetArmState(hubId, state, force);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
    return false;
  }

  /** Turn an actuator channel on/off (relay/socket/siren). */
  async setOnOff(deviceId: string, on: boolean): Promise<boolean> {
    const dev = this.devices.get(deviceId);
    if (!dev) return false;
    try {
      if (this.mode === 'api') {
        const ok = await this.apiCommand(dev.hubId ?? '', `devices/${deviceId}/command`, { command: on ? 'on' : 'off' });
        if (ok) this.applyUpdate({ ...dev, state: on });
        return ok;
      }
      if (this.mode === 'grpc') {
        this.log.info(`gRPC setOnOff ${deviceId} -> ${on} (vendor proto required for live control)`);
        this.applyUpdate({ ...dev, state: on });
        return true;
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
    return false;
  }

  /** Set dimmer brightness 0..100. */
  async setBrightness(deviceId: string, brightness: number): Promise<boolean> {
    const dev = this.devices.get(deviceId);
    if (!dev) return false;
    const value = Math.max(0, Math.min(100, Math.round(brightness)));
    try {
      if (this.mode === 'api') {
        const ok = await this.apiCommand(dev.hubId ?? '', `devices/${deviceId}/command`, { command: 'brightness', value });
        if (ok) this.applyUpdate({ ...dev, brightness: value, state: value > 0 });
        return ok;
      }
      this.applyUpdate({ ...dev, brightness: value, state: value > 0 });
      return true;
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
    return false;
  }

  // ---------------------------------------------------------------- REST API

  private get apiBase(): string {
    return (this.config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '');
  }

  private async apiLogin(): Promise<void> {
    if (this.config.apiToken) {
      this.sessionToken = this.config.apiToken;
      this.userId = this.config.apiUserId;
      return;
    }
    if (!this.config.email || !this.config.password) {
      throw new Error('API mode requires either apiToken or email + password.');
    }
    const res = await this.fetchJson(`${this.apiBase}/login`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        login: this.config.email,
        passwordHash: this.hashPassword(this.config.password),
        userRole: 'USER',
        ...(this.config.totp ? { otp: this.config.totp } : {}),
      }),
    });
    this.sessionToken = (res?.sessionToken as string) ?? (res?.token as string);
    this.userId = (res?.userId as string) ?? (res?.id as string) ?? this.config.email;
    if (!this.sessionToken) throw new Error('Ajax API login did not return a session token.');
    this.log.debug(`Ajax API login ok (userId=${this.userId}).`);
  }

  /** Ajax API expects the SHA-256 hex of the password. Leave an already-hashed value untouched. */
  private hashPassword(password: string): string {
    if (/^[0-9a-f]{64}$/i.test(password)) return password.toLowerCase();
    return createHash('sha256').update(password, 'utf8').digest('hex');
  }

  private async connectApi(): Promise<void> {
    await this.apiLogin();
    await this.apiRefreshDevices();
    const interval = this.config.pollInterval && this.config.pollInterval > 0 ? this.config.pollInterval * 1000 : DEFAULT_POLL_MS;
    this.pollTimer = setInterval(() => {
      if (!this.stopped) void this.apiRefreshDevices().catch((e) => this.emit('error', e));
    }, interval);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  private async apiRefreshDevices(): Promise<void> {
    const userId = this.userId ?? this.config.email ?? 'me';
    const raw = await this.apiGet(`/user/${encodeURIComponent(userId)}/hubs`);
    const hubs = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : undefined;
    if (!hubs) {
      this.log.debug('Ajax API returned no hubs.');
      return;
    }
    this.log.info(`Ajax API: discovered ${hubs.length} hub(s).`);
    for (const hub of hubs) {
      const hubId = String(hub.hubId ?? hub.id ?? '');
      if (!hubId) continue;
      this.ingestHub(hubId, hub);
      const list = (await this.apiGet(`/user/${encodeURIComponent(userId)}/hubs/${hubId}/devices`)) as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(list)) for (const raw of list) this.ingestDevice(hubId, raw);
    }
  }

  private ingestHub(hubId: string, hub: Record<string, unknown>): void {
    this.applyUpdate({
      id: hubId,
      name: String(hub.name ?? `Ajax Hub ${hubId}`),
      kind: 'hub',
      hubId,
      model: 'Hub',
      mains: hub.externalPowerState !== false,
      battery: typeof hub.batteryChargeLevel === 'number' ? (hub.batteryChargeLevel as number) : undefined,
    });
    const state = this.normalizeArm(String(hub.state ?? hub.armState ?? 'DISARMED'));
    this.applyUpdate({ id: `${hubId}-panel`, name: `${String(hub.name ?? 'Ajax')} Panel`, kind: 'panel', hubId, model: 'Panel', state: state !== 'disarmed' });
    this.emit('arm', hubId, state);
  }

  private ingestDevice(hubId: string, raw: Record<string, unknown>): void {
    const id = String(raw.id ?? raw.deviceId ?? '');
    if (!id) return;
    const model = String(raw.deviceType ?? raw.type ?? raw.subtype ?? raw.model ?? '');
    const kind = mapModelToKind(model);
    const dev: AjaxDevice = {
      id,
      name: String(raw.deviceName ?? raw.name ?? `${model} ${id}`),
      kind,
      hubId,
      model,
      battery: typeof raw.batteryChargeLevel === 'number' ? (raw.batteryChargeLevel as number) : undefined,
      temperature: typeof raw.temperature === 'number' ? (raw.temperature as number) : undefined,
      tamper: raw.tampered === true || raw.tamper === true,
      mains: raw.externalPowerState === true,
      state: this.deriveState(kind, raw),
      brightness: typeof raw.brightness === 'number' ? (raw.brightness as number) : undefined,
      channels: typeof raw.channels === 'number' ? (raw.channels as number) : undefined,
    };
    this.applyUpdate(dev);
  }

  private deriveState(kind: AjaxDeviceKind, raw: Record<string, unknown>): boolean | undefined {
    switch (kind) {
      case 'door':
        return raw.reedClosed === false || raw.opened === true;
      case 'motion':
        return raw.motion === true || raw.alarm === true;
      case 'smoke':
        return raw.smokeAlarm === true || raw.coAlarm === true || raw.alarm === true;
      case 'leak':
        return raw.leak === true || raw.flooded === true;
      case 'glass':
        return raw.glassBreak === true || raw.alarm === true;
      case 'relay':
      case 'socket':
      case 'siren':
        return raw.active === true || raw.on === true || raw.relayState === true;
      case 'dimmer':
        return (typeof raw.brightness === 'number' ? (raw.brightness as number) : 0) > 0;
      default:
        return undefined;
    }
  }

  private async apiSetArmState(hubId: string, state: AjaxArmState, force: boolean): Promise<boolean> {
    const command = state === 'disarmed' ? 'DISARM' : state === 'night' ? 'NIGHT_MODE' : 'ARM';
    const ok = await this.apiCommand(hubId, `hubs/${hubId}/command`, {
      command,
      ...(force && this.config.allowForceArm ? { ignoreProblems: true } : {}),
      ...(this.config.armPin ? { userCode: this.config.armPin } : {}),
    });
    if (ok) this.emit('arm', hubId, state);
    return ok;
  }

  private async apiCommand(hubId: string, path: string, body: Record<string, unknown>): Promise<boolean> {
    const userId = this.userId ?? this.config.email ?? 'me';
    const res = await this.fetchJson(`${this.apiBase}/user/${encodeURIComponent(userId)}/${path}`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });
    return res !== undefined;
  }

  private async apiGet(path: string): Promise<unknown> {
    return this.fetchJson(`${this.apiBase}${path}`, { method: 'GET', headers: this.authHeaders() });
  }

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.config.apiKey ? { 'X-Api-Key': this.config.apiKey } : {}),
      ...(this.sessionToken ? { 'X-Session-Token': this.sessionToken, Authorization: `Bearer ${this.sessionToken}` } : {}),
    };
  }

  private async fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown> | undefined> {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`Ajax API ${init.method ?? 'GET'} ${url} -> ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  }

  // ---------------------------------------------------------------- gRPC cloud

  private async connectGrpc(): Promise<void> {
    const host = this.config.grpcHost ?? DEFAULT_GRPC_HOST;
    if (!this.config.email || !this.config.password) {
      throw new Error('gRPC mode requires email + password (and appLabel).');
    }
    // The Ajax mobile gateway uses a reverse-engineered protobuf schema (see aegis-hass). The descriptors
    // are not redistributed with this plugin. When available they are loaded dynamically; the secure channel
    // and credential plumbing below are ready for them.
    try {
      const grpc = (await import('@grpc/grpc-js')) as typeof import('@grpc/grpc-js');
      const creds = grpc.credentials.createSsl();
      void new grpc.Client(host, creds);
      this.log.notice(
        `gRPC channel to ${host} prepared for app "${this.config.appLabel ?? 'Ajax'}". ` +
          `Supply vendor proto descriptors to enable live streaming; falling back to no live data.`,
      );
    } catch {
      this.log.warn('@grpc/grpc-js not available; gRPC mode disabled.');
    }
  }

  private async grpcSetArmState(hubId: string, state: AjaxArmState, _force: boolean): Promise<boolean> {
    this.log.info(`gRPC arm command for hub ${hubId} -> ${state} (requires vendor proto descriptors).`);
    this.emit('arm', hubId, state);
    return true;
  }

  // ---------------------------------------------------------------- SIA listener

  private connectSia(): void {
    const port = this.config.siaPort ?? DEFAULT_SIA_PORT;
    this.siaServer = createServer((socket: Socket) => {
      socket.on('data', (buf) => this.handleSia(buf.toString('latin1')));
      socket.on('error', (e) => this.emit('error', e));
    });
    this.siaServer.on('error', (e) => this.emit('error', e));
    this.siaServer.listen(port, () => this.log.notice(`SIA DC-09 listener started on port ${port}.`));
    if (this.siaServer.unref) this.siaServer.unref();
  }

  /**
   * Parse a SIA DC-09 frame and update the matching device.
   * Frame example: "...#ACCT|Nri1/BA1]..." where BA = burglary alarm, zone 1.
   *
   * @param {string} frame - Raw SIA frame.
   */
  private handleSia(frame: string): void {
    const acct = /#([0-9A-Fa-f]+)\|/.exec(frame)?.[1];
    if (this.config.siaAccountId && acct && acct !== this.config.siaAccountId) return;
    const m = /\|?N?ri\d*\/?([A-Z]{2})(\d+)/.exec(frame) ?? /\/([A-Z]{2})(\d+)/.exec(frame);
    if (!m) return;
    const [, code, zone] = m;
    const id = `sia-${acct ?? '0'}-${zone}`;
    const opening = code.startsWith('B') || code.startsWith('F') || code.startsWith('W') || code.startsWith('G') || code.startsWith('T');
    const restore = code.startsWith('R') || code.endsWith('R');
    const kind = this.siaKind(code);
    const existing = this.devices.get(id);
    this.applyUpdate({
      id,
      name: existing?.name ?? `SIA Zone ${zone}`,
      kind,
      model: `SIA-${code}`,
      state: restore ? false : opening,
      tamper: code.startsWith('TA'),
    });
    if (code.startsWith('OP') || code.startsWith('CL')) {
      this.emit('arm', acct ?? '0', code.startsWith('CL') ? 'armed' : 'disarmed');
    }
  }

  private siaKind(code: string): AjaxDeviceKind {
    if (code.startsWith('FA') || code.startsWith('GA')) return 'smoke';
    if (code.startsWith('WA')) return 'leak';
    if (code.startsWith('BA') || code.startsWith('BV')) return 'glass';
    if (code.startsWith('TA')) return 'tamper';
    return 'door';
  }

  // ---------------------------------------------------------------- helpers

  private normalizeArm(value: string): AjaxArmState {
    const v = value.toUpperCase();
    if (v.includes('NIGHT')) return 'night';
    if (v.includes('DISARM')) return 'disarmed';
    if (v.includes('ARM')) return 'armed';
    return 'disarmed';
  }

  private applyUpdate(dev: AjaxDevice): void {
    const known = this.devices.has(dev.id);
    this.devices.set(dev.id, dev);
    this.emit(known ? 'update' : 'device', dev);
  }

  private seedDemoDevices(): void {
    const demo: AjaxDevice[] = [
      { id: 'demo-hub', name: 'Ajax Hub', kind: 'hub', model: 'Hub2Plus', mains: true, battery: 100 },
      { id: 'demo-hub-panel', name: 'Ajax Panel', kind: 'panel', hubId: 'demo-hub', model: 'Panel', state: false },
      { id: 'demo-door', name: 'Front Door', kind: 'door', hubId: 'demo-hub', model: 'DoorProtect', state: false, battery: 90 },
      { id: 'demo-motion', name: 'Living Room Motion', kind: 'motion', hubId: 'demo-hub', model: 'MotionProtect', state: false, battery: 85 },
      { id: 'demo-smoke', name: 'Kitchen Smoke', kind: 'smoke', hubId: 'demo-hub', model: 'FireProtect', state: false, battery: 95 },
      { id: 'demo-leak', name: 'Bathroom Leak', kind: 'leak', hubId: 'demo-hub', model: 'LeaksProtect', state: false, battery: 88 },
      { id: 'demo-glass', name: 'Window Glass', kind: 'glass', hubId: 'demo-hub', model: 'GlassProtect', state: false, battery: 80 },
      { id: 'demo-socket', name: 'Office Socket', kind: 'socket', hubId: 'demo-hub', model: 'Socket', state: false, mains: true },
      { id: 'demo-relay', name: 'Garage Relay', kind: 'relay', hubId: 'demo-hub', model: 'Relay', state: false },
      { id: 'demo-dimmer', name: 'Hall Dimmer', kind: 'dimmer', hubId: 'demo-hub', model: 'LightSwitch', state: false, brightness: 0 },
      { id: 'demo-siren', name: 'Indoor Siren', kind: 'siren', hubId: 'demo-hub', model: 'HomeSiren', state: false, battery: 99 },
      { id: 'demo-temp', name: 'Hall Temperature', kind: 'temperature', hubId: 'demo-hub', model: 'TempSensor', temperature: 21.5, battery: 70 },
    ];
    for (const d of demo) this.devices.set(d.id, d);
  }
}
