/**
 * Minimal client for the Overkiz / Somfy TaHoma local Developer Mode API.
 *
 * It talks to the gateway over HTTPS (default port 8443) using a Bearer token
 * generated from the "Developer Mode" menu of the TaHoma by Somfy app.
 *
 * Reference: https://github.com/Somfy-Developer/Somfy-TaHoma-Developer-Mode
 *
 * @file overkizClient.ts
 * @license Apache-2.0
 */

import https from 'node:https';
import { EventEmitter } from 'node:events';

import { AnsiLogger } from 'matterbridge/logger';

/** Local API base path exposed by the gateway in Developer Mode. */
const API_BASE = '/enduser-mobile-web/1/enduserAPI';

/** A single Overkiz device state (name/value pair). */
export interface OverkizState {
  name: string;
  value: string | number | boolean | null;
  type?: number;
}

/** A command definition advertised by a device. */
export interface OverkizCommandDef {
  commandName?: string;
  name?: string;
  nparams?: number;
}

/** A device as returned by GET /setup/devices. */
export interface OverkizDevice {
  deviceURL: string;
  label: string;
  controllableName?: string;
  available?: boolean;
  enabled?: boolean;
  states?: OverkizState[];
  definition?: {
    uiClass?: string;
    widgetName?: string;
    commands?: OverkizCommandDef[];
    states?: { name: string }[];
  };
}

/** A single action targeting one device with a list of commands. */
export interface OverkizAction {
  deviceURL: string;
  commands: { name: string; parameters?: (string | number)[] }[];
}

/** Options to construct an {@link OverkizLocalClient}. */
export interface OverkizClientOptions {
  host: string;
  port: number;
  token: string;
  verifySsl: boolean;
  ca?: string;
  log: AnsiLogger;
}

/**
 * Client for the Overkiz local Developer Mode API.
 *
 * Emits `stateChanged` events with `{ deviceURL, states }` payloads when the
 * event listener detects device state changes.
 */
export class OverkizLocalClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly token: string;
  private readonly agent: https.Agent;
  private readonly log: AnsiLogger;

  private listenerId: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(options: OverkizClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port;
    this.token = options.token;
    this.log = options.log;
    this.agent = new https.Agent({
      rejectUnauthorized: options.verifySsl,
      ca: options.ca,
      keepAlive: true,
    });
  }

  /**
   * Perform a JSON HTTPS request against the local API.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - API path relative to the enduserAPI base.
   * @param {unknown} [body] - Optional JSON body.
   * @returns {Promise<T>} Parsed JSON response (or undefined on empty body).
   */
  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const options: https.RequestOptions = {
      host: this.host,
      port: this.port,
      path: API_BASE + path,
      method,
      agent: this.agent,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    return new Promise<T>((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            try {
              resolve((text ? JSON.parse(text) : undefined) as T);
            } catch {
              resolve(undefined as T);
            }
          } else {
            reject(new Error(`${method} ${path} failed: HTTP ${status} ${text}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error(`${method} ${path} timed out`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Fetch the gateway setup information.
   *
   * @returns {Promise<unknown>} Raw setup payload.
   */
  async getSetup(): Promise<unknown> {
    return this.request('GET', '/setup');
  }

  /**
   * Fetch all devices known to the gateway.
   *
   * @returns {Promise<OverkizDevice[]>} List of devices.
   */
  async getDevices(): Promise<OverkizDevice[]> {
    return (await this.request<OverkizDevice[]>('GET', '/setup/devices')) ?? [];
  }

  /**
   * Fetch the current states of a single device.
   *
   * @param {string} deviceURL - The device URL.
   * @returns {Promise<OverkizState[]>} List of states.
   */
  async getDeviceStates(deviceURL: string): Promise<OverkizState[]> {
    return (await this.request<OverkizState[]>('GET', `/setup/devices/${encodeURIComponent(deviceURL)}/states`)) ?? [];
  }

  /**
   * Execute a group of actions on the gateway.
   *
   * @param {string} label - Human readable label for the execution.
   * @param {OverkizAction[]} actions - Actions to execute.
   * @returns {Promise<unknown>} Execution result (contains execId).
   */
  async applyActions(label: string, actions: OverkizAction[]): Promise<unknown> {
    return this.request('POST', '/exec/apply', { label, actions });
  }

  /**
   * Convenience helper to send a single command to one device.
   *
   * @param {string} deviceURL - Target device.
   * @param {string} name - Command name.
   * @param {(string | number)[]} [parameters] - Optional command parameters.
   * @returns {Promise<unknown>} Execution result.
   */
  async sendCommand(deviceURL: string, name: string, parameters: (string | number)[] = []): Promise<unknown> {
    return this.applyActions(`mb-${name}`, [{ deviceURL, commands: [{ name, parameters }] }]);
  }

  /**
   * Register an event listener and start polling for device state changes.
   *
   * @param {number} intervalMs - Polling interval in milliseconds.
   * @returns {Promise<void>} Resolves once the listener is registered.
   */
  async startEvents(intervalMs: number): Promise<void> {
    try {
      const res = await this.request<{ id: string }>('POST', '/events/register');
      this.listenerId = res?.id ?? null;
      this.log.info(`Overkiz event listener registered: ${this.listenerId}`);
    } catch (error) {
      this.log.error(`Failed to register Overkiz event listener: ${(error as Error).message}`);
    }
    const tick = (): void => {
      this.pollTimer = setTimeout(() => {
        void this.poll().finally(tick);
      }, intervalMs);
    };
    tick();
  }

  /**
   * Fetch pending events once and emit `stateChanged` for each device update.
   *
   * @returns {Promise<void>} Resolves when the fetch completes.
   */
  private async poll(): Promise<void> {
    if (this.polling || !this.listenerId) return;
    this.polling = true;
    try {
      const events = await this.request<Record<string, unknown>[]>('POST', `/events/${this.listenerId}/fetch`);
      for (const event of events ?? []) {
        if (event.name === 'DeviceStateChangedEvent' && typeof event.deviceURL === 'string') {
          this.emit('stateChanged', event.deviceURL, (event.deviceStates as OverkizState[]) ?? []);
        }
      }
    } catch (error) {
      this.log.debug(`Event fetch failed: ${(error as Error).message}`);
      // Listener may have expired; try to re-register on next opportunity.
      try {
        const res = await this.request<{ id: string }>('POST', '/events/register');
        this.listenerId = res?.id ?? this.listenerId;
      } catch {
        /* ignore */
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Stop polling and unregister the event listener.
   *
   * @returns {Promise<void>} Resolves once cleanup completes.
   */
  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.listenerId) {
      try {
        await this.request('POST', `/events/${this.listenerId}/unregister`);
      } catch {
        /* ignore */
      }
      this.listenerId = null;
    }
    this.agent.destroy();
    this.removeAllListeners();
  }
}
