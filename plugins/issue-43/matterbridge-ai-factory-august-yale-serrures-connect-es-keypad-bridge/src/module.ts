/**
 * Matterbridge plugin for August / Yale connected locks.
 *
 * Exposes each August/Yale lock as a Matter Door Lock with an integrated
 * door-status contact sensor and a battery power source, driven through the
 * August Connect / Yale Wi-Fi cloud bridge (the `august-connect` package).
 *
 * @file module.ts
 * @author https://github.com/gladysassistant
 * @license Apache-2.0
 */

import august, { type AugustConfig, type AugustDetails, type AugustStatus } from 'august-connect';
import { BasePlatformConfig, contactSensor, doorLockDevice, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { BooleanState, DoorLock, PowerSource } from 'matterbridge/matter/clusters';

/** Type checking and autocompletion for the instance config. */
export type AugustPlatformConfig = BasePlatformConfig & {
  apiKey?: string;
  installID?: string;
  augustID?: string;
  IDType?: 'email' | 'phone';
  password?: string;
  validationCode?: string;
  pollInterval?: number;
  whiteList: string[];
  blackList: string[];
};

/** Internal record linking a lockID to its Matter endpoint. */
interface LockEntry {
  lockID: string;
  name: string;
  device: MatterbridgeEndpoint;
}

/**
 * Standard Matterbridge plugin entry point.
 *
 * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
 * @param {AnsiLogger} log - The plugin logger.
 * @param {AugustPlatformConfig} config - The platform configuration.
 * @returns {AugustPlatform} The platform instance.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: AugustPlatformConfig): AugustPlatform {
  return new AugustPlatform(matterbridge, log, config);
}

/** Dynamic platform exposing August / Yale locks to Matter. */
export class AugustPlatform extends MatterbridgeDynamicPlatform {
  private readonly locks = new Map<string, LockEntry>();
  private pollTimer?: NodeJS.Timeout;

  /**
   * @param {PlatformMatterbridge} matterbridge - The Matterbridge instance.
   * @param {AnsiLogger} log - The plugin logger.
   * @param {AugustPlatformConfig} config - The platform configuration.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: AugustPlatformConfig) {
    super(matterbridge, log, config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.8.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.8.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info('Initializing August / Yale lock platform...');
  }

  /** Build the august-connect config object from the plugin config. */
  private get augustConfig(): AugustConfig {
    const cfg = this.config as AugustPlatformConfig;
    return {
      apiKey: cfg.apiKey ?? '',
      installID: cfg.installID ?? '',
      augustID: cfg.augustID ?? '',
      IDType: cfg.IDType === 'phone' ? 'phone' : 'email',
      password: cfg.password ?? '',
    };
  }

  /** True when all mandatory credentials are present. */
  private hasCredentials(): boolean {
    const c = this.augustConfig;
    return Boolean(c.apiKey && c.installID && c.augustID && c.password);
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    await this.ready;
    await this.clearSelect();

    if (!this.hasCredentials()) {
      this.log.error('Missing August credentials. Please set apiKey, installID, augustID and password in the plugin config.');
      return;
    }

    const lockMap = await this.fetchLocks();
    if (!lockMap) return;

    for (const [lockID, info] of Object.entries(lockMap)) {
      if (lockID === 'token') continue;
      const name = this.lockName(info, lockID);

      this.setSelectDevice(lockID, name);
      if (!this.validateDevice([name, lockID])) {
        this.log.debug(`Lock ${name} (${lockID}) filtered out by white/black list.`);
        continue;
      }

      const device = this.createLockDevice(lockID, name);
      await this.registerDevice(device);
      this.locks.set(lockID, { lockID, name, device });
      this.log.info(`Registered August/Yale lock ${name} (${lockID}).`);
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info('onConfigure called');

    await this.refreshAll();

    const interval = Math.max(15, Number((this.config as AugustPlatformConfig).pollInterval ?? 60)) * 1000;
    this.pollTimer = setInterval(() => {
      this.refreshAll().catch((error) => this.log.error(`Poll error: ${error instanceof Error ? error.message : String(error)}`));
    }, interval);
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
    this.locks.clear();

    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Fetch the account locks, handling the August 2FA validation flow.
   *
   * @returns {Promise<Record<string, unknown> | null>} The lock map, or null when authentication is incomplete.
   */
  private async fetchLocks(): Promise<Record<string, unknown> | null> {
    const config = this.augustConfig;
    const code = (this.config as AugustPlatformConfig).validationCode?.toString().trim();

    try {
      if (code) {
        // Validate the pending 2FA session before fetching (idempotent once validated).
        try {
          await august.validate({ config, code });
          this.log.info('August session validated with the provided 2FA code.');
        } catch (error) {
          this.log.debug(`Session validation skipped/failed (may already be valid): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return (await august.locks({ config })) as Record<string, unknown>;
    } catch (error) {
      this.log.warn(`Could not fetch locks (authentication may be required): ${error instanceof Error ? error.message : String(error)}`);
      try {
        await august.authorize({ config });
        this.log.error('Two-factor authentication required. A validation code was sent to your August ID. Enter it in the "validationCode" config field and restart the plugin.');
      } catch (authError) {
        this.log.error(`August authorization failed: ${authError instanceof Error ? authError.message : String(authError)}`);
      }
      return null;
    }
  }

  /**
   * Extract a human-friendly lock name from the API payload.
   *
   * @param {unknown} info - The per-lock info object from the locks map.
   * @param {string} lockID - The lock identifier (fallback name).
   * @returns {string} The lock name.
   */
  private lockName(info: unknown, lockID: string): string {
    if (info && typeof info === 'object') {
      const rec = info as Record<string, unknown>;
      const name = rec.LockName ?? rec.name;
      if (typeof name === 'string' && name.length > 0) return name;
    }
    return `August Lock ${lockID.slice(0, 6)}`;
  }

  /**
   * Create a Door Lock Matter endpoint with a door-status contact sensor and battery.
   *
   * @param {string} lockID - The August lock identifier.
   * @param {string} name - The lock display name.
   * @returns {MatterbridgeEndpoint} The configured endpoint.
   */
  private createLockDevice(lockID: string, name: string): MatterbridgeEndpoint {
    const device = new MatterbridgeEndpoint(doorLockDevice, { id: `lock-${lockID}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, lockID, 0xfff1, 'August/Yale', 'August Smart Lock', 1, '1.0.0')
      .createDefaultDoorLockClusterServer(DoorLock.LockState.Locked, DoorLock.LockType.DeadBolt)
      .createDefaultPowerSourceReplaceableBatteryClusterServer(100, PowerSource.BatChargeLevel.Ok)
      .addRequiredClusterServers()
      .addCommandHandler('lockDoor', () => {
        this.commandLock(lockID, 'lock').catch((error) => this.log.error(`lockDoor failed for ${name}: ${error instanceof Error ? error.message : String(error)}`));
      })
      .addCommandHandler('unlockDoor', () => {
        this.commandLock(lockID, 'unlock').catch((error) => this.log.error(`unlockDoor failed for ${name}: ${error instanceof Error ? error.message : String(error)}`));
      });

    // Integrated door sensor (open / closed / unknown) as a child contact-sensor endpoint.
    device.addChildDeviceType('DoorSensor', contactSensor, { tagList: [] }).createDefaultBooleanStateClusterServer(true).addRequiredClusterServers();

    return device;
  }

  /**
   * Send a lock/unlock command to the August cloud and refresh state.
   *
   * @param {string} lockID - The August lock identifier.
   * @param {'lock' | 'unlock'} action - The action to perform.
   * @returns {Promise<void>} Resolves when the command and refresh complete.
   */
  private async commandLock(lockID: string, action: 'lock' | 'unlock'): Promise<void> {
    const config = this.augustConfig;
    this.log.info(`Sending ${action} command to lock ${lockID}...`);
    if (action === 'lock') await august.lock({ config, lockID });
    else await august.unlock({ config, lockID });
    await this.refreshLock(lockID);
  }

  /** Refresh state for all registered locks. */
  private async refreshAll(): Promise<void> {
    for (const lockID of this.locks.keys()) {
      await this.refreshLock(lockID).catch((error) => this.log.debug(`Refresh failed for ${lockID}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Refresh lock state, door state and battery for a single lock.
   *
   * @param {string} lockID - The August lock identifier.
   * @returns {Promise<void>} Resolves when attributes have been updated.
   */
  private async refreshLock(lockID: string): Promise<void> {
    const entry = this.locks.get(lockID);
    if (!entry) return;
    const config = this.augustConfig;

    let status: AugustStatus | undefined;
    try {
      status = await august.status({ config, lockID });
    } catch (error) {
      this.log.debug(`status() failed for ${lockID}: ${error instanceof Error ? error.message : String(error)}`);
    }

    let details: AugustDetails | undefined;
    try {
      details = await august.details({ config, lockID });
    } catch (error) {
      this.log.debug(`details() failed for ${lockID}: ${error instanceof Error ? error.message : String(error)}`);
    }

    await this.applyState(entry, status, details);
  }

  /**
   * Map August status/details payloads onto the Matter clusters.
   *
   * @param {LockEntry} entry - The registered lock entry.
   * @param {AugustStatus} [status] - The status payload.
   * @param {AugustDetails} [details] - The details payload.
   * @returns {Promise<void>} Resolves when attributes have been updated.
   */
  private async applyState(entry: LockEntry, status?: AugustStatus, details?: AugustDetails): Promise<void> {
    const lockStr = (status?.status ?? (details?.LockStatus?.status as string | undefined) ?? '').toLowerCase();
    const doorStr = (status?.doorState ?? (details?.LockStatus?.doorState as string | undefined) ?? '').toLowerCase();

    // Lock state -> DoorLock.lockState
    if (lockStr.includes('unlock')) {
      await entry.device.setAttribute(DoorLock.Cluster.id, 'lockState', DoorLock.LockState.Unlocked, entry.device.log);
    } else if (lockStr.includes('lock')) {
      await entry.device.setAttribute(DoorLock.Cluster.id, 'lockState', DoorLock.LockState.Locked, entry.device.log);
    } else if (lockStr.length > 0) {
      await entry.device.setAttribute(DoorLock.Cluster.id, 'lockState', DoorLock.LockState.NotFullyLocked, entry.device.log);
    }

    // Door sensor -> BooleanState.stateValue on the child endpoint (true = closed, false = open)
    const doorChild = entry.device.getChildEndpointByName('DoorSensor');
    if (doorChild && doorStr.length > 0) {
      const closed = doorStr.includes('closed') || doorStr.includes('close');
      const open = doorStr.includes('open') || doorStr.includes('ajar');
      if (closed || open) {
        await doorChild.setAttribute(BooleanState.Cluster.id, 'stateValue', closed && !open, doorChild.log);
      }
    }

    // Battery -> PowerSource.batPercentRemaining (Matter uses half-percent units: 0..200)
    if (typeof details?.battery === 'number') {
      const pct = details.battery <= 1 ? details.battery * 100 : details.battery;
      const clamped = Math.max(0, Math.min(100, Math.round(pct)));
      await entry.device.setAttribute(PowerSource.Cluster.id, 'batPercentRemaining', clamped * 2, entry.device.log);
      const level = clamped <= 10 ? PowerSource.BatChargeLevel.Critical : clamped <= 25 ? PowerSource.BatChargeLevel.Warning : PowerSource.BatChargeLevel.Ok;
      await entry.device.setAttribute(PowerSource.Cluster.id, 'batChargeLevel', level, entry.device.log);
    }

    this.log.debug(`Refreshed ${entry.name}: lock="${lockStr}" door="${doorStr}" battery=${details?.battery ?? 'n/a'}`);
  }
}
