/**
 * Minimal WLED JSON API client.
 *
 * @file wledClient.ts
 * @license Apache-2.0
 */

/** WLED segment object (subset). */
export interface WledSegment {
  id: number;
  col: number[][];
  cct?: number;
  fx?: number;
  on?: boolean;
  bri?: number;
}

/** WLED state object (subset). */
export interface WledState {
  on: boolean;
  bri: number;
  seg: WledSegment[];
}

/** WLED info object (subset). */
export interface WledInfo {
  ver: string;
  uptime: number;
  name?: string;
  mac?: string;
  wifi?: { rssi?: number; signal?: number };
  leds?: { count?: number };
}

/** Full WLED JSON response. */
export interface WledJson {
  state: WledState;
  info: WledInfo;
  effects?: string[];
}

/**
 * Client for a single WLED controller over its local HTTP JSON API.
 */
export class WledClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  /**
   * @param {string} host - Hostname or IP of the WLED controller (with optional http:// and port).
   * @param {number} [timeoutMs] - Request timeout in milliseconds.
   */
  constructor(host: string, timeoutMs = 5000) {
    let h = host.trim();
    if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
    this.baseUrl = h.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  /**
   * Performs an HTTP request against the WLED API.
   *
   * @param {string} path - API path starting with '/'.
   * @param {object} [body] - Optional JSON body. When present the request uses POST.
   * @returns {Promise<unknown>} The parsed JSON response.
   */
  private async request(path: string, body?: object): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`WLED HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads the full WLED JSON document (state + info + effects).
   *
   * @returns {Promise<WledJson>} The full WLED JSON.
   */
  async getJson(): Promise<WledJson> {
    return (await this.request('/json')) as WledJson;
  }

  /**
   * Reads the current WLED state.
   *
   * @returns {Promise<WledState>} The WLED state.
   */
  async getState(): Promise<WledState> {
    return (await this.request('/json/state')) as WledState;
  }

  /**
   * Reads the WLED device info.
   *
   * @returns {Promise<WledInfo>} The WLED info.
   */
  async getInfo(): Promise<WledInfo> {
    return (await this.request('/json/info')) as WledInfo;
  }

  /**
   * Sends a partial state update to the WLED controller.
   *
   * @param {Partial<WledState>} partial - Partial state to apply.
   * @returns {Promise<void>} Resolves when the request completes.
   */
  async setState(partial: Partial<WledState>): Promise<void> {
    await this.request('/json/state', partial);
  }
}
