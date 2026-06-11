/**
 * Minimal client for the Google Smart Device Management (SDM) API.
 *
 * @file nestClient.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SDM_BASE_URL = 'https://smartdevicemanagement.googleapis.com/v1';
const SDM_SCOPE = 'https://www.googleapis.com/auth/sdm.service';

/** A device returned by the SDM `devices.list` endpoint. */
export interface NestDevice {
  name: string; // enterprises/{project}/devices/{id}
  type: string; // sdm.devices.types.THERMOSTAT | CAMERA | DOORBELL | DISPLAY | ...
  traits: Record<string, unknown>;
  parentRelations?: { parent: string; displayName?: string }[];
}

/** Credentials and connection settings for the SDM API. */
export interface NestClientOptions {
  projectId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Thin wrapper around the Google SDM REST API handling OAuth2 token refresh,
 * device listing and command execution.
 */
export class NestClient {
  private accessToken = '';
  private tokenExpiry = 0;

  constructor(
    private readonly options: NestClientOptions,
    private readonly log: AnsiLogger,
  ) {}

  /** Whether the minimum credentials are present. */
  get configured(): boolean {
    const { projectId, clientId, clientSecret, refreshToken } = this.options;
    return Boolean(projectId && clientId && clientSecret && refreshToken);
  }

  /**
   * Exchange the refresh token for a short lived access token, caching it until
   * shortly before it expires.
   *
   * @returns {Promise<string>} A valid OAuth2 access token.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) return this.accessToken;

    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      refresh_token: this.options.refreshToken,
      grant_type: 'refresh_token',
      scope: SDM_SCOPE,
    });

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`OAuth token refresh failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = json.access_token;
    // Refresh 60s before the real expiry.
    this.tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
    this.log.debug('Refreshed SDM access token');
    return this.accessToken;
  }

  /**
   * Authenticated SDM request helper.
   *
   * @param {string} path - Path relative to the SDM base url.
   * @param {RequestInit} [init] - Fetch init options.
   * @returns {Promise<unknown>} Parsed JSON response.
   */
  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.getAccessToken();
    const res = await fetch(`${SDM_BASE_URL}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`SDM request ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  /**
   * List all devices for the configured Device Access project.
   *
   * @returns {Promise<NestDevice[]>} The devices owned by the project.
   */
  async listDevices(): Promise<NestDevice[]> {
    const json = (await this.request(`/enterprises/${this.options.projectId}/devices`)) as { devices?: NestDevice[] };
    return json.devices ?? [];
  }

  /**
   * Fetch a single device with its current traits.
   *
   * @param {string} name - Full device resource name.
   * @returns {Promise<NestDevice>} The device.
   */
  async getDevice(name: string): Promise<NestDevice> {
    return (await this.request(`/${name}`)) as NestDevice;
  }

  /**
   * Execute an SDM command against a device.
   *
   * @param {string} name - Full device resource name.
   * @param {string} command - The SDM command id.
   * @param {Record<string, unknown>} params - Command parameters.
   * @returns {Promise<void>} Resolves when the command completes.
   */
  async executeCommand(name: string, command: string, params: Record<string, unknown>): Promise<void> {
    await this.request(`/${name}:executeCommand`, { method: 'POST', body: JSON.stringify({ command, params }) });
  }
}
