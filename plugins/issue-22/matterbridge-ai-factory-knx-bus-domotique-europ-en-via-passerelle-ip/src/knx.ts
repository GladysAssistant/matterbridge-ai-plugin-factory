/**
 * Thin wrapper around knxultimate providing connect / read / write / decode and
 * a normalized indication callback keyed by group address.
 *
 * @file knx.ts
 * @license Apache-2.0
 */

import { KNXClient, dptlib } from 'knxultimate';
import { AnsiLogger } from 'matterbridge/logger';

export interface KnxConnectionConfig {
  type: 'tunneling' | 'routing';
  host: string;
  port: number;
  local_ip?: string;
  tunneling_secure?: boolean;
  device_password?: string;
}

export type KnxIndicationHandler = (groupAddress: string, raw: Buffer) => void;

/** Minimal structural view of the knxultimate KNXClient we rely on. */
interface KnxClientLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  Connect(): void;
  Disconnect(): Promise<void>;
  write(ga: string, value: unknown, dpt: string): void;
  read(ga: string): void;
}

/** Decode a raw KNX payload buffer using the given DPT id (e.g. "5.001"). */
export function decodeDpt(raw: Buffer, dpt: string): unknown {
  const cfg = dptlib.resolve(dpt);
  return dptlib.fromBuffer(raw, cfg);
}

export class KnxClientWrapper {
  private client?: KnxClientLike;
  private connected = false;
  private indicationHandler?: KnxIndicationHandler;

  constructor(
    private readonly config: KnxConnectionConfig,
    private readonly log: AnsiLogger,
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  onIndication(handler: KnxIndicationHandler): void {
    this.indicationHandler = handler;
  }

  /** Open the connection to the KNX/IP gateway. Resolves on 'connected'. */
  async connect(): Promise<void> {
    const secure = this.config.type === 'tunneling' && !!this.config.tunneling_secure;
    const hostProtocol = this.config.type === 'routing' ? 'Multicast' : secure ? 'TunnelTCP' : 'TunnelUDP';

    const options: Record<string, unknown> = {
      hostProtocol,
      ipAddr: this.config.host || (this.config.type === 'routing' ? '224.0.23.12' : '127.0.0.1'),
      ipPort: this.config.port || 3671,
      loglevel: 'error',
      suppress_ack_ldatareq: false,
    };
    if (this.config.local_ip) options.localIPAddress = this.config.local_ip;
    if (secure && this.config.device_password) {
      options.isSecureKNXEnabled = true;
      options.secureTunnelConfig = { knxkeys_file_path: '', tunnelInterfaceIndividualAddress: '', tunnelUserPassword: this.config.device_password };
    }

    this.log.info(`Connecting to KNX gateway ${options.ipAddr}:${options.ipPort} (${hostProtocol})`);
    const client = new (KNXClient as unknown as new (o: unknown) => KnxClientLike)(options);
    this.client = client;

    client.on('error', (e: unknown) => this.log.error(`KNX error: ${(e as Error)?.message ?? String(e)}`));
    client.on('disconnected', (reason: unknown) => {
      this.connected = false;
      this.log.warn(`KNX disconnected: ${String(reason)}`);
    });
    client.on('indication', (packet: unknown) => this.handleIndication(packet));

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.log.warn('KNX connect timeout (continuing, will reconnect on demand)');
        resolve();
      }, 10000);
      client.on('connected', () => {
        clearTimeout(timer);
        this.connected = true;
        this.log.info('KNX gateway connected');
        resolve();
      });
      try {
        client.Connect();
      } catch (e) {
        clearTimeout(timer);
        this.log.error(`KNX Connect() failed: ${(e as Error).message}`);
        resolve();
      }
    });
  }

  private handleIndication(packet: unknown): void {
    try {
      const cemi = (packet as { cEMIMessage?: { npdu?: { isGroupWrite?: boolean; isGroupResponse?: boolean; dataValue?: Buffer }; dstAddress?: { toString?: () => string } } })?.cEMIMessage;
      if (!cemi?.npdu) return;
      if (!cemi.npdu.isGroupWrite && !cemi.npdu.isGroupResponse) return;
      const dst = cemi.dstAddress?.toString?.();
      const raw = cemi.npdu.dataValue;
      if (!dst || !raw) return;
      this.indicationHandler?.(dst, raw);
    } catch (e) {
      this.log.debug(`Failed to handle indication: ${(e as Error).message}`);
    }
  }

  /** Send a GroupValue_Write telegram. */
  write(groupAddress: string, value: unknown, dpt: string): void {
    if (!this.client) return;
    try {
      this.client.write(groupAddress, value, dpt);
      this.log.debug(`KNX write ${groupAddress} = ${JSON.stringify(value)} (DPT ${dpt})`);
    } catch (e) {
      this.log.error(`KNX write ${groupAddress} failed: ${(e as Error).message}`);
    }
  }

  /** Send a GroupValue_Read telegram; the response arrives via indication. */
  read(groupAddress: string): void {
    if (!this.client) return;
    try {
      this.client.read(groupAddress);
    } catch (e) {
      this.log.debug(`KNX read ${groupAddress} failed: ${(e as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.Disconnect();
    } catch {
      /* ignore */
    }
    this.connected = false;
    this.client = undefined;
  }
}
