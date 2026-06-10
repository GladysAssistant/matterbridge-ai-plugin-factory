/**
 * Philips Hue Bridge v2 — CLIP v2 API client.
 *
 * Talks to a local Hue Bridge over HTTPS using the `hue-application-key` header.
 * Supports resource discovery, light control and the SSE event stream.
 *
 * @file hue.ts
 * @license Apache-2.0
 */

import { EventEmitter } from 'node:events';
import https from 'node:https';

import { AnsiLogger } from 'matterbridge/logger';

/** A generic CLIP v2 resource as returned by the bridge. */
export interface HueResource {
  id: string;
  id_v1?: string;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** Body accepted by `PUT /clip/v2/resource/light/{id}`. */
export interface HueLightUpdate {
  on?: { on: boolean };
  dimming?: { brightness: number };
  color_temperature?: { mirek: number };
  color?: { xy: { x: number; y: number } };
}

/**
 * Minimal Hue CLIP v2 client.
 *
 * Emits `update` with the raw event `data` array entries coming from the
 * bridge SSE event stream (`/eventstream/clip/v2`).
 */
export class HueClient extends EventEmitter {
  private readonly agent: https.Agent;
  private streamReq?: import('node:http').ClientRequest;
  private reconnectTimer?: NodeJS.Timeout;
  private closed = false;

  /**
   * @param {string} host - Bridge IP or hostname.
   * @param {string} appKey - The Hue application key (username).
   * @param {AnsiLogger} log - Logger instance.
   */
  constructor(
    private readonly host: string,
    private readonly appKey: string,
    private readonly log: AnsiLogger,
  ) {
    super();
    // The bridge uses a self-signed certificate (CN = bridge id), so we cannot
    // verify it against a public CA. Pin would require fetching the bridge id.
    this.agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
  }

  /**
   * Perform a raw HTTPS request against the bridge.
   *
   * @param {string} method - HTTP method.
   * @param {string} path - Request path.
   * @param {object} [body] - Optional JSON body.
   * @returns {Promise<any>} Parsed JSON response.
   */
  private request(method: string, path: string, body?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = https.request(
        {
          host: this.host,
          port: 443,
          path,
          method,
          agent: this.agent,
          headers: {
            'hue-application-key': this.appKey,
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              resolve(text ? JSON.parse(text) : {});
            } catch {
              resolve({ raw: text });
            }
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Pair with the bridge (link button must be pressed first) to obtain an
   * application key. Uses the v1 endpoint which returns the username.
   *
   * @param {string} host - Bridge IP.
   * @param {string} appName - Application identifier.
   * @returns {Promise<string>} The newly created application key.
   */
  static async pair(host: string, appName = 'matterbridge#hue'): Promise<string> {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const body = JSON.stringify({ devicetype: appName, generateclientkey: true });
    const res: any[] = await new Promise((resolve, reject) => {
      const req = https.request(
        { host, port: 443, path: '/api', method: 'POST', agent, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    const first = res[0];
    if (first?.error) throw new Error(first.error.description ?? 'pairing failed (press the link button)');
    if (!first?.success?.username) throw new Error('pairing failed: no username returned');
    return first.success.username;
  }

  /**
   * List all resources of a given CLIP v2 type (light, device, motion, ...).
   *
   * @param {string} type - Resource type.
   * @returns {Promise<HueResource[]>} The resources.
   */
  async getResources(type: string): Promise<HueResource[]> {
    const res = await this.request('GET', `/clip/v2/resource/${type}`);
    if (res?.errors?.length) this.log.warn(`Hue getResources(${type}) errors: ${JSON.stringify(res.errors)}`);
    return res?.data ?? [];
  }

  /**
   * Update a light resource.
   *
   * @param {string} id - Light resource id.
   * @param {HueLightUpdate} update - Partial update body.
   * @returns {Promise<void>}
   */
  async updateLight(id: string, update: HueLightUpdate): Promise<void> {
    const res = await this.request('PUT', `/clip/v2/resource/light/${id}`, update);
    if (res?.errors?.length) this.log.warn(`Hue updateLight(${id}) errors: ${JSON.stringify(res.errors)}`);
  }

  /**
   * Update an on/off capable resource (e.g. smart plug light service).
   *
   * @param {string} id - Light resource id.
   * @param {boolean} on - Desired state.
   * @returns {Promise<void>}
   */
  async setOn(id: string, on: boolean): Promise<void> {
    await this.updateLight(id, { on: { on } });
  }

  /**
   * Connect to the bridge SSE event stream and emit `update` events with each
   * resource-update entry. Automatically reconnects on disconnect.
   */
  connectEventStream(): void {
    if (this.closed) return;
    const req = https.request(
      {
        host: this.host,
        port: 443,
        path: '/eventstream/clip/v2',
        method: 'GET',
        agent: this.agent,
        headers: { 'hue-application-key': this.appKey, Accept: 'text/event-stream' },
      },
      (res) => {
        this.log.info('Hue event stream connected');
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const json = line.slice(5).trim();
              if (!json) continue;
              try {
                const events = JSON.parse(json);
                for (const ev of events) {
                  for (const item of ev.data ?? []) this.emit('update', item);
                }
              } catch (e) {
                this.log.debug(`Hue event parse error: ${(e as Error).message}`);
              }
            }
          }
        });
        res.on('end', () => this.scheduleReconnect());
      },
    );
    req.on('error', (e) => {
      this.log.debug(`Hue event stream error: ${e.message}`);
      this.scheduleReconnect();
    });
    req.end();
    this.streamReq = req;
  }

  /** Schedule an event stream reconnection in 5s. */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectEventStream();
    }, 5000);
  }

  /** Close the client and stop the event stream. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.streamReq?.destroy();
    this.agent.destroy();
  }
}
