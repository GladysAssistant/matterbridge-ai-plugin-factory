/**
 * Matterbridge plugin for the iopool EcO connected pool water quality monitor.
 *
 * Cloud-only, read-only integration against the iopool public REST API
 * (https://api.iopool.com/v1). One Matter device is created per pool returned
 * by the `/pools` endpoint.
 *
 * @file module.ts
 * @license Apache-2.0
 */

import { contactSensor, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformConfig, PlatformMatterbridge, temperatureSensor } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): IopoolPlatform {
  return new IopoolPlatform(matterbridge, log, config);
}

const IOPOOL_API_BASE = 'https://api.iopool.com/v1';

/** Measurement mode of the EcO probe. */
type IopoolMeasureMode = 'standard' | 'live' | 'maintenance' | 'manual' | 'backup' | 'gateway';
/** Pool-level operating mode. */
type IopoolPoolMode = 'STANDARD' | 'OPENING' | 'ACTIVE_WINTER' | 'WINTER' | 'INITIALIZATION';

/** Latest measure from `latestMeasure` (may be missing on a freshly-initialised pool). */
interface IopoolLatestMeasure {
  temperature: number; // °C
  ph: number; // pH (typ. 6.5 - 8.0)
  orp: number; // ORP / Redox in mV (typ. 500 - 900)
  mode: IopoolMeasureMode;
  isValid: boolean;
  ecoId: string;
  measuredAt: string; // ISO 8601
}

/** A single pool object from `/pools`. */
interface IopoolPool {
  id: string;
  title: string;
  mode: IopoolPoolMode;
  hasAnActionRequired: boolean;
  latestMeasure?: IopoolLatestMeasure | null;
  advice?: { filtrationDuration?: number | null } | null;
}

/** Per-pool runtime tracking. */
interface PoolEntry {
  device: MatterbridgeEndpoint;
  /** Last known measure, kept so we can survive transient API errors. */
  lastMeasure?: IopoolLatestMeasure;
}

export class IopoolPlatform extends MatterbridgeDynamicPlatform {
  private readonly apiKey: string;
  private readonly pollingIntervalMs: number;
  private readonly poolIdAllowList: string[];
  private readonly pools = new Map<string, PoolEntry>();
  private pollTimer?: NodeJS.Timeout;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.4.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.4.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    const interval = typeof config.pollingIntervalSeconds === 'number' && config.pollingIntervalSeconds > 0 ? config.pollingIntervalSeconds : 300;
    this.pollingIntervalMs = interval * 1000;
    this.poolIdAllowList = Array.isArray(config.poolIds) ? (config.poolIds as string[]).filter((id) => typeof id === 'string' && id.length > 0) : [];

    this.log.info('Initializing iopool EcO pool water quality monitor platform...');
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);
    await this.ready;
    await this.clearSelect();

    if (!this.apiKey) {
      this.log.error('No iopool API key configured. Set "apiKey" in the plugin config (found in the iopool mobile app).');
      return;
    }

    const pools = await this.fetchPools();
    if (pools === undefined) {
      this.log.warn('Could not fetch pools from the iopool API at startup. The plugin will retry on the next polling cycle.');
      return;
    }
    for (const pool of pools) {
      await this.createPoolDevice(pool);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    // Push the values fetched at startup to the persisted attributes.
    for (const [, entry] of this.pools) {
      if (entry.lastMeasure) await this.applyMeasure(entry, entry.lastMeasure);
    }

    // Start the polling loop. Pool data changes slowly (probe measures ~hourly).
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollingIntervalMs);
    this.log.info(`Polling the iopool API every ${this.pollingIntervalMs / 1000}s.`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.pools.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /** Fetch all pools from the iopool cloud API. Returns undefined on a network/auth error. */
  private async fetchPools(): Promise<IopoolPool[] | undefined> {
    try {
      const res = await fetch(`${IOPOOL_API_BASE}/pools`, {
        method: 'GET',
        headers: { 'x-api-key': this.apiKey, Accept: 'application/json' },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          this.log.error(`iopool API rejected the API key (HTTP ${res.status}). Check that "apiKey" is valid.`);
        } else {
          this.log.error(`iopool API returned HTTP ${res.status} ${res.statusText}.`);
        }
        return undefined;
      }
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) {
        this.log.error('iopool API /pools did not return an array.');
        return undefined;
      }
      let pools = data as IopoolPool[];
      if (this.poolIdAllowList.length > 0) {
        pools = pools.filter((p) => this.poolIdAllowList.includes(p.id));
      }
      return pools;
    } catch (err) {
      this.log.error(`Network error contacting the iopool API: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Build one Matter device per pool: temperature sensor + pH / ORP / action-required children. */
  private async createPoolDevice(pool: IopoolPool): Promise<void> {
    const serial = `iopool-${pool.id}`;
    const name = pool.title && pool.title.length > 0 ? pool.title : `iopool ${pool.id}`;

    // Main endpoint: a clean, standard Matter Temperature Sensor for the water temperature.
    const device = new MatterbridgeEndpoint(temperatureSensor, { id: serial })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, serial, this.matterbridge.aggregatorVendorId, 'iopool', 'iopool EcO', 1, '1.0.0')
      .createDefaultIdentifyClusterServer()
      .createDefaultTemperatureMeasurementClusterServer()
      .addRequiredClusterServers();

    // Child endpoint: pH. No standard Matter cluster exists for pH, so we expose it
    // as a Temperature Measurement (measuredValue = pH * 100, i.e. centi-units).
    device.addChildDeviceType('ph', temperatureSensor).createDefaultTemperatureMeasurementClusterServer().addRequiredClusterServers();

    // Child endpoint: ORP / Redox (mV). Also no standard Matter cluster; exposed as a
    // Temperature Measurement. ORP in mV can exceed the int16 centi-unit range, so the
    // raw mV value is stored directly as measuredValue (consumers read it as-is, not /100).
    device.addChildDeviceType('orp', temperatureSensor).createDefaultTemperatureMeasurementClusterServer().addRequiredClusterServers();

    // Child endpoint: "action required" flag exposed as a contact/boolean sensor.
    device.addChildDeviceType('action-required', contactSensor).createDefaultBooleanStateClusterServer(true).addRequiredClusterServers();

    this.setSelectDevice(serial, name);
    if (!this.validateDevice([name, serial])) {
      this.log.info(`Pool "${name}" (${pool.id}) filtered out by white/black list.`);
      return;
    }

    await this.registerDevice(device);
    const entry: PoolEntry = { device };
    if (pool.latestMeasure) entry.lastMeasure = pool.latestMeasure;
    this.pools.set(pool.id, entry);
    this.log.info(`Registered pool "${name}" (${pool.id}) mode=${pool.mode} actionRequired=${pool.hasAnActionRequired}.`);
  }

  /** Poll the API and update every known pool device. */
  private async poll(): Promise<void> {
    const pools = await this.fetchPools();
    if (pools === undefined) {
      this.log.warn('Polling failed; keeping the last known values for all pools.');
      return;
    }
    for (const pool of pools) {
      const entry = this.pools.get(pool.id);
      if (!entry) {
        // A pool added after startup; create it on the fly.
        await this.createPoolDevice(pool);
        const created = this.pools.get(pool.id);
        if (created?.lastMeasure) await this.applyMeasure(created, created.lastMeasure);
        continue;
      }
      await this.updateActionRequired(entry, pool.hasAnActionRequired);
      if (pool.latestMeasure) {
        entry.lastMeasure = pool.latestMeasure;
        await this.applyMeasure(entry, pool.latestMeasure);
        const filtration = pool.advice?.filtrationDuration;
        this.log.debug(
          `Pool ${pool.id}: ${pool.latestMeasure.temperature}°C pH=${pool.latestMeasure.ph} ORP=${pool.latestMeasure.orp}mV ` +
            `valid=${pool.latestMeasure.isValid} measureMode=${pool.latestMeasure.mode} poolMode=${pool.mode} ` +
            `filtrationAdvice=${filtration ?? 'n/a'}h`,
        );
      } else {
        this.log.info(`Pool ${pool.id} has no latestMeasure yet (freshly initialised); keeping last known values.`);
      }
    }
  }

  /** Write a measure onto the Matter clusters of a pool device. */
  private async applyMeasure(entry: PoolEntry, measure: IopoolLatestMeasure): Promise<void> {
    const { device } = entry;

    // Water temperature — standard Matter Temperature Measurement (0.01 °C units).
    if (Number.isFinite(measure.temperature)) {
      await device.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(measure.temperature * 100), this.log);
    }

    // pH — proxied as a Temperature Measurement (pH * 100).
    const phChild = device.getChildEndpointByName('ph');
    if (phChild && Number.isFinite(measure.ph)) {
      await phChild.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(measure.ph * 100), this.log);
    }

    // ORP — proxied as a Temperature Measurement, raw mV stored directly.
    const orpChild = device.getChildEndpointByName('orp');
    if (orpChild && Number.isFinite(measure.orp)) {
      await orpChild.setAttribute('TemperatureMeasurement', 'measuredValue', Math.round(measure.orp), this.log);
    }
  }

  /** Update the "action required" boolean sensor for a pool. */
  private async updateActionRequired(entry: PoolEntry, actionRequired: boolean): Promise<void> {
    const child = entry.device.getChildEndpointByName('action-required');
    if (child) await child.setAttribute('BooleanState', 'stateValue', !actionRequired, this.log);
  }
}
