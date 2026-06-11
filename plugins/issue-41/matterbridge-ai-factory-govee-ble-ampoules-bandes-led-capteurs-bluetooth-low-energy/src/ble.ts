/**
 * Thin BLE manager around @abandonware/noble. noble is loaded lazily so the
 * plugin still builds and loads on hosts without a Bluetooth adapter (or where
 * the native module failed to compile). All BLE work is best-effort and never
 * throws into the platform.
 *
 * @file ble.ts
 * @license Apache-2.0
 */

import { AnsiLogger } from 'matterbridge/logger';

import { GOVEE_CONTROL_SERVICE, GOVEE_WRITE_CHAR } from './govee.js';

/** Normalise a MAC/address to lower-case without separators for comparison. */
export function normAddr(addr: string): string {
  return addr.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

export interface BleAdvertisement {
  address: string;
  localName?: string;
  manufacturerData?: Buffer;
  rssi?: number;
}

export type AdvertisementListener = (adv: BleAdvertisement) => void;

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Manages scanning + GATT writes via noble, with graceful absence handling. */
export class BleManager {
  private noble: any;
  private available = false;
  private scanning = false;
  private readonly listeners = new Set<AdvertisementListener>();
  private readonly peripherals = new Map<string, any>();

  constructor(private readonly log: AnsiLogger) {}

  /** Whether a usable noble/BLE stack was loaded. */
  get isAvailable(): boolean {
    return this.available;
  }

  /** Lazily import noble. Returns false if unavailable. */
  async init(): Promise<boolean> {
    if (this.noble) return this.available;
    try {
      // Non-literal specifier: keeps noble an optional runtime-only dependency
      // so TypeScript does not require its types and the build stays clean.
      const specifier = '@abandonware/noble';
      const mod = await import(specifier);
      this.noble = (mod as any).default ?? mod;
      this.available = true;
      this.noble.on('discover', (p: any) => this.onDiscover(p));
      this.log.info('BLE (noble) initialized');
    } catch (err) {
      this.available = false;
      this.log.warn(`BLE unavailable, running without Bluetooth: ${(err as Error).message}`);
    }
    return this.available;
  }

  /** Register an advertisement listener. */
  onAdvertisement(cb: AdvertisementListener): void {
    this.listeners.add(cb);
  }

  private onDiscover(p: any): void {
    const adv: BleAdvertisement = {
      address: normAddr(p.address ?? p.id ?? ''),
      localName: p.advertisement?.localName,
      manufacturerData: p.advertisement?.manufacturerData,
      rssi: p.rssi,
    };
    if (adv.address) this.peripherals.set(adv.address, p);
    for (const cb of this.listeners) {
      try {
        cb(adv);
      } catch (err) {
        this.log.debug(`Advertisement listener error: ${(err as Error).message}`);
      }
    }
  }

  /** Begin (or restart) scanning. Allows duplicates so sensors keep updating. */
  async startScanning(): Promise<void> {
    if (!this.available || this.scanning) return;
    await this.waitPoweredOn();
    try {
      await this.noble.startScanningAsync([], true);
      this.scanning = true;
      this.log.info('BLE scanning started');
    } catch (err) {
      this.log.warn(`Failed to start BLE scanning: ${(err as Error).message}`);
    }
  }

  /** Stop scanning. */
  async stopScanning(): Promise<void> {
    if (!this.available || !this.scanning) return;
    try {
      await this.noble.stopScanningAsync();
    } catch {
      /* ignore */
    }
    this.scanning = false;
  }

  private waitPoweredOn(): Promise<void> {
    return new Promise((resolve) => {
      if (this.noble.state === 'poweredOn') return resolve();
      const onState = (state: string) => {
        if (state === 'poweredOn') {
          this.noble.removeListener('stateChange', onState);
          resolve();
        }
      };
      this.noble.on('stateChange', onState);
      // Safety timeout so we never hang forever.
      setTimeout(() => {
        this.noble.removeListener('stateChange', onState);
        resolve();
      }, 10_000).unref?.();
    });
  }

  /**
   * Connect to a light, write a series of command frames to the Govee control
   * characteristic, then disconnect. Best-effort; logs and swallows failures.
   *
   * @param address - Normalised device address.
   * @param frames - 20-byte command buffers to write in order.
   */
  async writeLight(address: string, frames: Buffer[]): Promise<boolean> {
    if (!this.available) {
      this.log.debug(`Cannot write to ${address}: BLE unavailable`);
      return false;
    }
    const p = this.peripherals.get(normAddr(address));
    if (!p) {
      this.log.warn(`Light ${address} not yet discovered; skipping write`);
      return false;
    }
    try {
      await p.connectAsync();
      const { characteristics } = await p.discoverSomeServicesAndCharacteristicsAsync([GOVEE_CONTROL_SERVICE], [GOVEE_WRITE_CHAR]);
      const ch = characteristics?.[0];
      if (!ch) throw new Error('control characteristic not found');
      for (const f of frames) {
        await ch.writeAsync(f, true);
      }
      await p.disconnectAsync();
      return true;
    } catch (err) {
      this.log.warn(`BLE write to ${address} failed: ${(err as Error).message}`);
      try {
        await p.disconnectAsync();
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  /** Tear everything down. */
  async stop(): Promise<void> {
    await this.stopScanning();
    this.listeners.clear();
    if (this.noble) {
      try {
        this.noble.removeAllListeners('discover');
      } catch {
        /* ignore */
      }
    }
  }
}
