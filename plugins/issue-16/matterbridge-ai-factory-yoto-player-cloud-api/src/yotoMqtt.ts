/**
 * Real-time Yoto Player updates over MQTT.
 *
 * Uses the access token returned by the OAuth device flow as the broker
 * password. Subscribes to per-device status/events topics so the platform
 * can update Matter attributes the moment the player reports a change.
 */

import { AnsiLogger } from 'matterbridge/logger';
import mqtt, { MqttClient } from 'mqtt';

import { YotoApi, YotoDeviceStatus } from './yotoApi.js';

const MQTT_URL = 'wss://aqrphjqbp3u2z-ats.iot.eu-west-2.amazonaws.com/mqtt';

export type MqttStatusListener = (deviceId: string, status: YotoDeviceStatus) => void;

export class YotoMqtt {
  private readonly log: AnsiLogger;
  private readonly api: YotoApi;
  private client: MqttClient | null = null;
  private deviceIds: string[] = [];
  private listener: MqttStatusListener | null = null;
  private connectedOnce = false;

  constructor(log: AnsiLogger, api: YotoApi) {
    this.log = log;
    this.api = api;
  }

  isConnected(): boolean {
    return this.client?.connected === true;
  }

  /**
   * Connect to the MQTT broker and subscribe to status/events topics for
   * the given device ids. Returns true if the initial connection succeeds.
   */
  async connect(deviceIds: string[], listener: MqttStatusListener): Promise<boolean> {
    this.deviceIds = deviceIds;
    this.listener = listener;
    const tokens = this.api.getTokens();
    if (!tokens) return false;
    try {
      const client = mqtt.connect(MQTT_URL, {
        clientId: `MatterbridgeYoto_${Math.random().toString(16).slice(2, 10)}`,
        username: '?x-amz-customauthorizer-name=YotoCustomAuthorizer',
        password: tokens.accessToken,
        protocolVersion: 4,
        keepalive: 30,
        reconnectPeriod: 30_000,
        connectTimeout: 15_000,
      });
      this.client = client;
      await new Promise<void>((resolve, reject) => {
        const onErr = (err: Error): void => {
          client.off('connect', onCon);
          reject(err);
        };
        const onCon = (): void => {
          client.off('error', onErr);
          resolve();
        };
        client.once('error', onErr);
        client.once('connect', onCon);
        setTimeout(() => reject(new Error('MQTT connect timeout')), 15_000);
      });
      this.connectedOnce = true;
      this.log.info('Connected to Yoto MQTT broker.');
      this.subscribeAll();
      client.on('message', (topic, payload) => this.onMessage(topic, payload));
      client.on('reconnect', () => this.log.debug('MQTT reconnecting…'));
      client.on('error', (err) => this.log.warn(`MQTT error: ${err.message}`));
      return true;
    } catch (err) {
      this.log.warn(`MQTT connection failed: ${(err as Error).message}`);
      this.client?.end(true);
      this.client = null;
      return false;
    }
  }

  private subscribeAll(): void {
    if (!this.client) return;
    for (const id of this.deviceIds) {
      this.client.subscribe(`device/${id}/data/status`, { qos: 0 });
      this.client.subscribe(`device/${id}/data/events`, { qos: 0 });
    }
  }

  private onMessage(topic: string, payload: Buffer): void {
    if (!this.listener) return;
    const match = topic.match(/^device\/([^/]+)\/data\/(status|events)$/);
    if (!match) return;
    const deviceId = match[1];
    try {
      const data = JSON.parse(payload.toString('utf8')) as YotoDeviceStatus;
      this.listener(deviceId, data);
    } catch (err) {
      this.log.debug(`MQTT message parse error on ${topic}: ${(err as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    await new Promise<void>((resolve) => this.client!.end(false, {}, () => resolve()));
    this.client = null;
    this.log.debug('MQTT disconnected.');
  }

  hasEverConnected(): boolean {
    return this.connectedOnce;
  }
}
