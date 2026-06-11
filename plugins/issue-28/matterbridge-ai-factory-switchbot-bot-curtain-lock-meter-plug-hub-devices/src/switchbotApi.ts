/**
 * SwitchBot OpenAPI v1.1 cloud client.
 *
 * @file switchbotApi.ts
 * @license Apache-2.0
 */

import { createHmac, randomUUID } from 'node:crypto';

import { AnsiLogger } from 'matterbridge/logger';

const BASE = 'https://api.switch-bot.com/v1.1';

export interface SwitchBotDevice {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  hubDeviceId?: string;
  enableCloudService?: boolean;
}

export type SwitchBotStatus = Record<string, unknown>;

/** Minimal SwitchBot OpenAPI cloud client. */
export class SwitchBotApi {
  constructor(
    private readonly token: string,
    private readonly secret: string,
    private readonly log: AnsiLogger,
  ) {}

  private headers(): Record<string, string> {
    const t = Date.now().toString();
    const nonce = randomUUID();
    const sign = createHmac('sha256', this.secret)
      .update(Buffer.from(this.token + t + nonce, 'utf-8'))
      .digest('base64');
    return {
      Authorization: this.token,
      sign,
      t,
      nonce,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { statusCode: number; message: string; body: T };
    if (json.statusCode !== 100) {
      throw new Error(`SwitchBot API error ${json.statusCode}: ${json.message}`);
    }
    return json.body;
  }

  /** List all physical devices on the account. */
  async getDevices(): Promise<SwitchBotDevice[]> {
    const body = await this.request<{ deviceList: SwitchBotDevice[] }>('GET', '/devices');
    return body.deviceList ?? [];
  }

  /** Read the current status of a device. */
  async getStatus(deviceId: string): Promise<SwitchBotStatus> {
    return this.request<SwitchBotStatus>('GET', `/devices/${deviceId}/status`);
  }

  /** Send a command to a device. */
  async sendCommand(deviceId: string, command: string, parameter: string | object = 'default', commandType = 'command'): Promise<void> {
    this.log.debug(`SwitchBot command ${command}(${JSON.stringify(parameter)}) -> ${deviceId}`);
    await this.request('POST', `/devices/${deviceId}/commands`, { command, parameter, commandType });
  }
}
